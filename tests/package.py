"""Verify the downloadable ZIP in a clean directory with spaces and a fresh DB."""
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from zipfile import ZipFile

ROOT=Path(__file__).resolve().parents[1]
ARCHIVE=Path(sys.argv[1]) if len(sys.argv)>1 else ROOT.parent/'hvac-crm.zip'
OPENER=urllib.request.build_opener(urllib.request.ProxyHandler({}))


def main():
    with tempfile.TemporaryDirectory(prefix='Airframe clean install ') as temporary:
        folder=Path(temporary)
        with ZipFile(ARCHIVE) as z:
            assert z.testzip() is None
            assert not any(n.startswith('hvac-crm/data/') for n in z.namelist())
            manifest=json.loads(z.read('hvac-crm/RELEASE.json'))
            for name,digest in manifest['checksums'].items():
                assert hashlib.sha256(z.read('hvac-crm/'+name)).hexdigest()==digest,name
            z.extractall(folder)
        print('PASS ZIP integrity, per-file SHA-256, and exclusion of workspace data')
        app=folder/'hvac-crm'
        env={k:v for k,v in os.environ.items() if k!='HVAC_DB'}
        with socket.socket() as probe:
            probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
        address=f'http://127.0.0.1:{port}'
        unrelated=folder/'another working directory';unrelated.mkdir()

        def get(route):
            with OPENER.open(address+route,timeout=3) as r:return json.load(r)

        def start():
            process=subprocess.Popen([sys.executable,str(app/'launch.py'),'--port',str(port),'--no-browser'],cwd=unrelated,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            for _ in range(100):
                if process.poll() is not None:raise AssertionError(process.communicate())
                try:
                    health=get('/api/health')
                    if health['status']=='ready' and health['version']=='0.2.0':return process
                except OSError:pass
                time.sleep(.1)
            process.terminate();process.wait(timeout=10)
            raise AssertionError('Packaged launcher did not become ready.')

        def stop(process):
            if process.poll() is None:process.send_signal(signal.SIGINT);process.wait(timeout=10)
            process.stdout.close();process.stderr.close()

        process=start()
        try:
            state=get('/api/state')
            assert len(state['customers'])==5 and len(state['jobs'])==4
            assert len(state['inventory'])==3
            print('PASS clean first launch from a folder with spaces and an unrelated working directory')
            req=urllib.request.Request(address+'/api/customers',data=json.dumps({'name':'Package persistence check','email':'package@example.com','phone':'555-0199','address':'Demo location'}).encode(),headers={'Content-Type':'application/json'})
            with OPENER.open(req,timeout=3) as r:assert r.status==200
        finally:stop(process)
        process=start()
        try:
            assert any(c['name']=='Package persistence check' for c in get('/api/state')['customers'])
            assert list((app/'data'/'backups').glob('airframe-daily-*.sqlite3'))
            result=subprocess.run([sys.executable,str(app/'manage.py'),'check'],cwd=unrelated,env=env,capture_output=True,text=True,timeout=10)
            assert result.returncode==0,result.stderr
            assert json.loads(result.stdout)['integrity']=='ok'
            print('PASS packaged restart, data persistence, automatic daily backup, and database integrity')
        finally:stop(process)
        print('COMPLETED: downloadable release verified with Python standard library only; no package installation or external network request needed.')
        print('ARCHIVE_SHA256 '+hashlib.sha256(ARCHIVE.read_bytes()).hexdigest())


if __name__=='__main__':main()
