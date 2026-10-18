"""Deployment boundaries against a real isolated HTTP server; no public account."""
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location('airframe_online', ROOT/'online.py')
online = importlib.util.module_from_spec(spec)
spec.loader.exec_module(online)


class Deployment(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='airframe-online-')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            cls.port = sock.getsockname()[1]
        cls.origin = 'https://private.example.test'
        cls.password = 'Temporary-test-password-'+os.urandom(8).hex()
        cls.verifier = online.password_hash(cls.password)
        cls.env = {**os.environ, 'HVAC_DB': str(Path(cls.tmp.name)/'crm.sqlite3'), 'PORT':str(cls.port), 'AIRFRAME_PUBLIC_URL':cls.origin, 'AIRFRAME_PASSWORD_HASH':cls.verifier}
        cls.start()

    @classmethod
    def start(cls):
        cls.process = subprocess.Popen([sys.executable, str(ROOT/'online.py')], env=cls.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            if cls.process.poll() is not None:
                raise RuntimeError('Deployment server exited.')
            try:
                if cls.request('GET', '/api/health')[0] == 200:
                    return
            except OSError:
                pass
            time.sleep(.05)
        raise RuntimeError('Server did not become ready.')

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        cls.process.wait(timeout=10)
        cls.tmp.cleanup()

    @classmethod
    def request(cls, method, path, body=None, cookie=None, origin=True, host='private.example.test'):
        conn = http.client.HTTPConnection('127.0.0.1', cls.port, timeout=5)
        headers = {'Host':host}
        if origin is True:
            headers['Origin'] = cls.origin
        elif origin:
            headers['Origin'] = origin
        if cookie:
            headers['Cookie'] = cookie
        if body is not None:
            headers['Content-Type'] = 'application/json'
            body = json.dumps(body)
        try:
            conn.request(method, path, body, headers)
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            conn.close()

    def login(self):
        status, headers, _ = self.request('POST', '/api/auth/login', {'password': self.password})
        self.assertEqual(status, 200)
        return headers['Set-Cookie'].split(';')[0], headers['Set-Cookie']

    def test_01_fail_closed_configuration(self):
        for origin in ('http://public.example', 'https://example.test/', 'https://user:secret@example.test', ''):
            with self.assertRaises(ValueError):
                online.Access(origin, self.verifier)
        with self.assertRaises(ValueError):
            online.parse_hash('plaintext-password')
        env = {key:value for key,value in self.env.items() if key != 'AIRFRAME_PASSWORD_HASH'}
        result = subprocess.run([sys.executable,str(ROOT/'online.py')], env=env, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'Missing deployment setting', result.stderr)

    def test_02_public_health_and_guarded_routes(self):
        self.assertEqual(json.loads(self.request('GET','/api/health')[2]), {'status':'ready'})
        for route in ('/api/state','/api/backup','/files/1','/api/export?table=customers','/app.js'):
            self.assertEqual(self.request('GET',route)[0], 401, route)
        self.assertEqual(self.request('GET','/')[1]['Location'], '/login')
        self.assertEqual(self.request('POST','/api/customers',{})[0], 401)
        self.assertEqual(self.request('GET','/api/state',host='attacker.example')[0], 400)

    def test_03_login_cookie_and_redaction(self):
        self.assertEqual(self.request('POST','/api/auth/login',{'password':'wrong'})[0], 401)
        cookie, header = self.login()
        for attribute in ('__Host-airframe-session=', 'Secure','HttpOnly','SameSite=Strict','Path=/','Max-Age=28800'):
            self.assertIn(attribute, header)
        status, _, body = self.request('GET','/api/state',cookie=cookie)
        self.assertEqual(status, 200)
        self.assertNotIn(self.password.encode(), body)
        self.assertNotIn(self.verifier.encode(), body)
        page = self.request('GET','/',cookie=cookie)[2]
        self.assertIn(b'Sign out', page)
        self.assertIn(b'PRIVATE WORKSPACE', page)

    def test_04_csrf_and_logout(self):
        cookie, _ = self.login()
        for origin in (False, 'https://attacker.example'):
            self.assertEqual(self.request('POST','/api/auth/logout',{},cookie=cookie,origin=origin)[0], 403)
            self.assertEqual(self.request('POST','/api/auth/login',{'password':self.password},origin=origin)[0], 403)
        self.assertEqual(self.request('GET','/api/state',cookie=cookie)[0], 200)
        response = self.request('POST','/api/auth/logout',{},cookie=cookie)
        self.assertEqual(response[0], 200)
        self.assertIn('Max-Age=0', response[1]['Set-Cookie'])
        self.assertEqual(self.request('GET','/api/state',cookie=cookie)[0], 401)

    def test_05_expiry_tampering_and_throttle(self):
        access = online.Access(self.origin,self.verifier)
        status, token = access.login(self.password)
        self.assertEqual(status,200)
        cookie = f'{access.cookie}={token}'
        self.assertTrue(access.authenticated(cookie))
        self.assertFalse(access.authenticated(cookie+'tampered'))
        access.sessions[hashlib.sha256(token.encode()).digest()] = time.monotonic()-1
        self.assertFalse(access.authenticated(cookie))
        for _ in range(9):
            self.assertEqual(access.login('wrong')[0],401)
        self.assertEqual(access.login(self.password)[0],429)

    def test_06_restart_preserves_data_revokes_sessions(self):
        cookie, _ = self.login()
        before = self.request('GET','/api/state',cookie=cookie)[2]
        self.process.terminate()
        self.process.wait(timeout=10)
        self.start()
        self.assertEqual(self.request('GET','/api/state',cookie=cookie)[0],401)
        cookie, _ = self.login()
        self.assertEqual(self.request('GET','/api/state',cookie=cookie)[2],before)
        backup = self.request('GET','/api/backup',cookie=cookie)
        self.assertEqual(backup[0],200)
        self.assertTrue(backup[2].startswith(b'SQLite format 3'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
