"""Acceptance checks for recovery, financial concurrency, time zones and launching."""
import base64
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
import urllib.error

ROOT=Path(__file__).resolve().parents[1]
OPENER=urllib.request.build_opener(urllib.request.ProxyHandler({}))


class RecoveryAcceptance(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='airframe-recovery-')
        self.database=Path(self.temp.name)/'workspace.sqlite3'
        self.environment={**os.environ,'HVAC_DB':str(self.database)}
        with socket.socket() as probe:
            probe.bind(('127.0.0.1',0));self.port=probe.getsockname()[1]
        self.url=f'http://127.0.0.1:{self.port}'
        self.process=None
        self.start()

    def start(self):
        self.process=subprocess.Popen([sys.executable,str(ROOT/'server.py'),'--port',str(self.port)],env=self.environment,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        for _ in range(100):
            try:
                if self.get('/api/health')['status']=='ready':return
            except OSError:pass
            if self.process.poll() is not None:self.fail(self.process.stderr.read().decode())
            time.sleep(.05)
        self.fail('Server did not become ready.')

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.terminate();self.process.wait(timeout=10)
        if self.process and self.process.stderr:self.process.stderr.close()

    def tearDown(self):
        self.stop();self.temp.cleanup()

    def get(self,path):
        with OPENER.open(self.url+path,timeout=5) as r:return json.load(r)

    def post(self,route,data):
        req=urllib.request.Request(self.url+'/api/'+route,data=json.dumps(data).encode(),headers={'Content-Type':'application/json'})
        try:
            with OPENER.open(req,timeout=10) as r:return r.status,json.load(r)
        except urllib.error.HTTPError as e:return e.code,json.load(e)

    def manage(self,*args):
        return subprocess.run([sys.executable,str(ROOT/'manage.py'),'--database',str(self.database),*map(str,args)],env=self.environment,text=True,capture_output=True,timeout=15)

    def quote(self,title='Test',price='100.00'):
        return {'customer_id':1,'title':title,'items':[{'description':'Service','quantity':1,'unit_price':price}],'tax_bps':0}

    def test_draft_edit_preserves_identity_and_locks_after_approval(self):
        status,q=self.post('quotes',self.quote());self.assertEqual(status,200)
        original=self.get('/api/state');count=len(original['quotes'])
        edit={**self.quote('Revised scope','250.00'),'id':q['id'],'discount':'10.00','tax_bps':725}
        self.assertEqual(self.post('quotes/update',edit)[0],200)
        result=self.get('/api/state');revised=next(x for x in result['quotes'] if x['id']==q['id'])
        self.assertEqual(len(result['quotes']),count);self.assertEqual(revised['total'],25740)
        self.post('quotes/approve',{'id':q['id']})
        self.assertEqual(self.post('quotes/update',edit)[0],400)
        self.assertEqual(next(x for x in self.get('/api/state')['quotes'] if x['id']==q['id'])['total'],25740)

    def test_declined_estimate_cannot_be_silently_reapproved(self):
        _,q=self.post('quotes',self.quote());self.post('quotes/decline',{'id':q['id']})
        self.assertEqual(self.post('quotes/approve',{'id':q['id']})[0],400)

    def test_daylight_saving_invalid_and_repeated_times_are_rejected(self):
        _,q=self.post('quotes',self.quote());self.post('quotes/approve',{'id':q['id']})
        for start,end in [('2027-03-14T02:15','2027-03-14T03:15'),('2026-11-01T01:15','2026-11-01T02:15')]:
            status,error=self.post('jobs',{'quote_id':q['id'],'technician_id':1,'start':start,'end':end})
            self.assertEqual(status,400);self.assertIn('daylight saving',error['error'])
        self.assertEqual(self.post('jobs',{'quote_id':q['id'],'technician_id':1,'start':'2026-11-01T03:00','end':'2026-11-01T04:00'})[0],200)

    def test_concurrent_payments_cannot_overpay(self):
        # Seed invoice balance is $165. Both submissions attempt to settle it.
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:self.post('invoices/pay',{'id':1,'amount':'165.00','method':'Check'}),range(2)))
        self.assertEqual(sorted(code for code,_ in results),[200,400])
        state=self.get('/api/state');self.assertEqual(sum(p['amount'] for p in state['payments'] if p['invoice_id']==1),16500)

    def test_concurrent_stock_usage_never_goes_negative(self):
        _,part=self.post('inventory',{'sku':'ONE-LEFT','name':'Last part','quantity':1,'reorder_at':1,'unit_cost':'10.00'})
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:self.post('inventory/move',{'id':part['id'],'job_id':1,'quantity':-1,'reason':'Service usage'}),range(2)))
        self.assertEqual(sorted(code for code,_ in results),[200,400])
        self.assertEqual(next(p for p in self.get('/api/state')['inventory'] if p['id']==part['id'])['quantity'],0)

    def test_download_backup_restores_files_and_preserves_previous_workspace(self):
        png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2a0AAAAASUVORK5CYII='
        self.post('files',{'customer_id':1,'name':'proof.png','mime':'image/png','content':png})
        backup=Path(self.temp.name)/'download.sqlite3'
        with OPENER.open(self.url+'/api/backup',timeout=10) as r:backup.write_bytes(r.read())
        with sqlite3.connect(backup) as db:
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0],'ok')
            self.assertEqual(db.execute('SELECT content FROM files').fetchone()[0],base64.b64decode(png))
        self.post('customers',{'name':'After backup','email':'after@example.com','phone':'555-0100','address':'Demo address'})
        self.assertNotEqual(self.manage('restore',backup).returncode,0,'Restore must refuse a live workspace')
        self.stop()
        restored=self.manage('restore',backup);self.assertEqual(restored.returncode,0,restored.stderr)
        before=list((self.database.parent/'backups').glob('before-restore-*.sqlite3'));self.assertEqual(len(before),1)
        with sqlite3.connect(before[0]) as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM customers').fetchone()[0],6)
        self.start();state=self.get('/api/state');self.assertEqual(len(state['customers']),5);self.assertEqual(len(state['files']),1)

    def test_backup_never_overwrites_and_bad_restore_is_rejected(self):
        target=Path(self.temp.name)/'backup.sqlite3'
        self.assertEqual(self.manage('backup','--output',target).returncode,0)
        original=target.read_bytes();self.assertNotEqual(self.manage('backup','--output',target).returncode,0);self.assertEqual(target.read_bytes(),original)
        bad=Path(self.temp.name)/'bad.sqlite3';bad.write_bytes(b'not a database')
        self.stop();self.assertNotEqual(self.manage('restore',bad).returncode,0)
        self.assertEqual(self.manage('check').returncode,0)

    def test_same_workspace_cannot_run_twice_and_releases_lock_on_exit(self):
        duplicate=subprocess.run([sys.executable,str(ROOT/'server.py'),'--port',str(self.port+1)],env=self.environment,capture_output=True,text=True,timeout=10)
        self.assertNotEqual(duplicate.returncode,0);self.assertIn('already running',duplicate.stderr)
        self.stop();self.start();self.assertEqual(self.get('/api/health')['status'],'ready')

    def test_one_click_launcher_reuses_server_and_stops_its_child(self):
        reused=subprocess.run([sys.executable,str(ROOT/'launch.py'),'--port',str(self.port),'--no-browser'],env=self.environment,capture_output=True,text=True,timeout=10)
        self.assertEqual(reused.returncode,0);self.assertIn('already running',reused.stdout)
        self.stop()
        launcher=subprocess.Popen([sys.executable,str(ROOT/'launch.py'),'--port',str(self.port),'--no-browser'],env=self.environment,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        try:
            for _ in range(100):
                if launcher.poll() is not None:
                    self.fail('Launcher exited early: '+launcher.stderr.read()+launcher.stdout.read())
                try:
                    if self.get('/api/health')['status']=='ready':break
                except OSError:pass
                time.sleep(.1)
            else:self.fail('Launcher did not start a ready server.')
            launcher.send_signal(signal.SIGINT);launcher.wait(timeout=10)
            with self.assertRaises(OSError):self.get('/api/health')
        finally:
            if launcher.poll() is None:launcher.terminate();launcher.wait(timeout=10)
            launcher.stdout.close();launcher.stderr.close()

    def test_bundled_timezone_works_without_system_zone_database(self):
        code='''import zoneinfo
real=zoneinfo.ZoneInfo
class MissingZone:
    def __new__(cls,key):raise zoneinfo.ZoneInfoNotFoundError(key)
    from_file=staticmethod(real.from_file)
zoneinfo.ZoneInfo=MissingZone
import server
from datetime import datetime
assert datetime(2026,7,1,tzinfo=server.BUSINESS_TZ).utcoffset().total_seconds()==-7*3600
assert datetime(2026,12,1,tzinfo=server.BUSINESS_TZ).utcoffset().total_seconds()==-8*3600
print('Bundled Pacific timezone verified')'''
        result=subprocess.run([sys.executable,'-c',code],cwd=ROOT,env=self.environment,capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)


if __name__=='__main__':
    unittest.main(verbosity=2)
