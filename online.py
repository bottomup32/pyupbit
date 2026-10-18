#!/usr/bin/env python3
"""Single-company HTTPS deployment adapter. Local launch.py remains independent."""
import argparse
from collections import deque
import getpass
import hashlib
import hmac
from http.cookies import SimpleCookie, CookieError
import json
import os
from pathlib import Path
import secrets
import sqlite3
import threading
import time
from urllib.parse import urlsplit

import server
from storage import WorkspaceLock, snapshot_database


def password_hash(password):
    if len(password) < 16:
        raise ValueError('Use a password of at least 16 characters.')
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1, dklen=32)
    return 'scrypt$1$' + salt.hex() + '$' + digest.hex()


def parse_hash(encoded):
    method, version, salt, digest = encoded.split('$')
    if method != 'scrypt' or version != '1' or len(salt) != 32 or len(digest) != 64:
        raise ValueError('Invalid password verifier.')
    return bytes.fromhex(salt), bytes.fromhex(digest)


class Access:
    def __init__(self, origin, verifier):
        parsed = urlsplit(origin)
        self.local = parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', 'localhost', '::1')
        if (parsed.scheme != 'https' and not self.local) or not parsed.netloc or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
            raise ValueError('AIRFRAME_PUBLIC_URL must be an HTTPS origin with no trailing slash; HTTP is allowed only for loopback tests.')
        self.origin = origin
        self.host = parsed.netloc
        self.salt, self.digest = parse_hash(verifier)
        self.cookie = 'airframe-local-session' if self.local else '__Host-airframe-session'
        self.sessions = {}
        self.attempts = deque()
        self.lock = threading.Lock()

    def login(self, password):
        # Deliberately global: do not trust client-supplied forwarding headers.
        with self.lock:
            now = time.monotonic()
            while self.attempts and self.attempts[0] < now - 60:
                self.attempts.popleft()
            if len(self.attempts) >= 10:
                return 429, None
            self.attempts.append(now)
        digest = hashlib.scrypt(password.encode(), salt=self.salt, n=16384, r=8, p=1, dklen=32)
        if not hmac.compare_digest(digest, self.digest):
            return 401, None
        token = secrets.token_urlsafe(32)
        key = hashlib.sha256(token.encode()).digest()
        with self.lock:
            now = time.monotonic()
            self.sessions = {k: v for k, v in self.sessions.items() if v > now}
            if len(self.sessions) >= 256:
                self.sessions.pop(next(iter(self.sessions)))
            self.sessions[key] = now + 8 * 3600
        return 200, token

    def key(self, header):
        try:
            cookie = SimpleCookie()
            cookie.load(header or '')
            token = cookie[self.cookie].value
            if len(token) > 100:
                return None
            return hashlib.sha256(token.encode()).digest()
        except (CookieError, KeyError):
            return None

    def authenticated(self, header):
        key = self.key(header)
        with self.lock:
            expiry = self.sessions.get(key, 0)
            if expiry <= time.monotonic():
                self.sessions.pop(key, None)
                return False
            return True

    def logout(self, header):
        with self.lock:
            self.sessions.pop(self.key(header), None)


class OnlineHandler(server.Handler):
    def allowed_origin(self, origin):
        return origin == self.server.access.origin

    def end_headers(self):
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Frame-Options', 'DENY')
        if not self.server.access.local:
            self.send_header('Strict-Transport-Security', 'max-age=31536000')
        super().end_headers()

    def redirect(self, location):
        self.send_response(303)
        self.send_header('Location', location)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def host_ok(self):
        if self.headers.get('Host') != self.server.access.host:
            self.reply(400, {'error': 'Unexpected host.'})
            return False
        return True

    def do_GET(self):
        route = urlsplit(self.path).path
        if route == '/api/health':
            # Public readiness contains no workspace fingerprint or customer data.
            try:
                with server.connection() as db:
                    db.execute('SELECT id FROM settings WHERE id=1').fetchone()
                self.reply(200, {'status': 'ready'})
            except sqlite3.Error:
                self.reply(503, {'status': 'unavailable'})
            return
        if not self.host_ok():
            return
        if route in ('/login', '/login.js'):
            name, kind = ('login.html', 'text/html; charset=utf-8') if route == '/login' else ('login.js', 'text/javascript; charset=utf-8')
            self.reply(200, (server.ROOT/'static'/name).read_bytes(), kind)
            return
        if not self.server.access.authenticated(self.headers.get('Cookie')):
            if route == '/':
                self.redirect('/login')
            else:
                self.reply(401, {'error': 'Sign in to your workspace.'})
            return
        if route == '/online.js':
            self.reply(200, (server.ROOT/'static'/'online.js').read_bytes(), 'text/javascript; charset=utf-8')
            return
        if route == '/':
            page = (server.ROOT/'static'/'index.html').read_text()
            page = page.replace('<script src="/app.js"', '<script src="/online.js" defer></script><script src="/app.js"')
            page = page.replace('LOCAL DEMO', 'PRIVATE WORKSPACE').replace('Jamie Lawson', 'Workspace admin').replace('Office manager · demo', 'Signed in · private access')
            page = page.replace('<div class="top-actions">', '<div class="top-actions"><button class="btn" id="sign-out" type="button">Sign out</button>')
            self.reply(200, page.encode(), 'text/html; charset=utf-8')
            return
        super().do_GET()

    def session_reply(self, token):
        self.send_response(200)
        secure = '' if self.server.access.local else '; Secure'
        self.send_header('Set-Cookie', f'{self.server.access.cookie}={token or ""}; Path=/; HttpOnly; SameSite=Strict; Max-Age={28800 if token else 0}{secure}')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', '2')
        self.end_headers()
        self.wfile.write(b'{}')

    def do_POST(self):
        if not self.host_ok():
            return
        if not self.allowed_origin(self.headers.get('Origin')):
            self.reply(403, {'error': 'Submit from the workspace origin.'})
            return
        route = urlsplit(self.path).path
        if route == '/api/auth/login':
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 2048 or not self.headers.get('Content-Type', '').startswith('application/json'):
                    raise ValueError()
                data = json.loads(self.rfile.read(size))
                password = data.get('password') if isinstance(data, dict) else None
                if not isinstance(password, str) or len(password) > 512:
                    raise ValueError()
                status, token = self.server.access.login(password)
                if token:
                    self.session_reply(token)
                else:
                    self.reply(status, {'error': 'Too many attempts. Try again in one minute.' if status == 429 else 'Incorrect workspace password.'})
            except (ValueError, TypeError):
                self.reply(400, {'error': 'Enter a valid workspace password.'})
            return
        if not self.server.access.authenticated(self.headers.get('Cookie')):
            self.reply(401, {'error': 'Sign in to your workspace.'})
            return
        if route == '/api/auth/logout':
            self.server.access.logout(self.headers.get('Cookie'))
            self.session_reply(None)
            return
        super().do_POST()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hash-password', action='store_true', help='Read a password privately and print a deployment verifier.')
    args = parser.parse_args()
    try:
        if args.hash_password:
            password = getpass.getpass('Workspace password (16+ characters): ')
            if password != getpass.getpass('Confirm password: '):
                raise ValueError('Passwords do not match.')
            print(password_hash(password))
            return
        access = Access(os.environ['AIRFRAME_PUBLIC_URL'], os.environ['AIRFRAME_PASSWORD_HASH'])
        if not os.environ.get('HVAC_DB') or not Path(os.environ['HVAC_DB']).is_absolute():
            raise ValueError('Set HVAC_DB to an absolute path on persistent storage.')
        with WorkspaceLock(server.DB):
            server.initialize()
            server.upgrade()
            daily = server.DB.parent/'backups'/f'airframe-daily-{server.today()}.sqlite3'
            if not daily.exists():
                snapshot_database(server.DB, daily)
            httpd = server.ThreadingHTTPServer(('0.0.0.0', int(os.environ.get('PORT', '8080'))), OnlineHandler)
            httpd.access = access
            print('Airframe private workspace ready. HTTPS termination and persistent storage are required.', flush=True)
            httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    except KeyError as error:
        parser.exit(1, f'Missing deployment setting: {error.args[0]}\n')
    except (ValueError, RuntimeError, OSError, sqlite3.Error) as error:
        parser.exit(1, f'Unable to start online workspace: {error}\n')


if __name__ == '__main__':
    main()
