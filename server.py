#!/usr/bin/env python3
"""Local, single-company HVAC CRM prototype. Python standard library only."""
import argparse
from contextlib import contextmanager
import base64
import calendar
import csv
import io
import hashlib
import json
import os
import re
import sqlite3
import tempfile
from datetime import datetime, timedelta, date, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from storage import WorkspaceLock, snapshot_database

ROOT = Path(__file__).resolve().parent
VERSION = '0.2.0'
DB = Path(os.environ.get('HVAC_DB', ROOT / 'data' / 'crm.sqlite3'))
ZONE = 'America/Los_Angeles'
try:
    BUSINESS_TZ = ZoneInfo(ZONE)
except ZoneInfoNotFoundError:
    # Windows Python may have no IANA database. Ship this one public-domain zone.
    with (ROOT / 'assets' / 'Los_Angeles.tzif').open('rb') as zone_file:
        BUSINESS_TZ = ZoneInfo.from_file(zone_file, key=ZONE)
STATES = ['Scheduled', 'En route', 'In progress', 'Completed']
TABLES = ['customers', 'properties', 'equipment', 'technicians', 'requests', 'quotes', 'jobs', 'invoices', 'payments', 'agreements', 'pricebook', 'tasks', 'notes', 'messages', 'files', 'activities', 'settings', 'time_entries', 'expenses', 'inventory', 'stock_movements']


@contextmanager
def connection():
    db = sqlite3.connect(DB, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    try:
        with db:
            yield db
    finally:
        db.close()


def today():
    return datetime.now(BUSINESS_TZ).date().isoformat()


def local_datetime(value):
    naive = datetime.fromisoformat(value)
    if naive.tzinfo or naive.isoformat(timespec='minutes') != value:
        raise ValueError('Use Pacific local times with minute precision.')
    candidates = []
    for fold in [0, 1]:
        aware = naive.replace(tzinfo=BUSINESS_TZ, fold=fold)
        back = aware.astimezone(timezone.utc).astimezone(BUSINESS_TZ).replace(tzinfo=None)
        if back == naive:
            candidates.append(aware)
    if not candidates:
        raise ValueError('This Pacific time does not exist because of daylight saving time. Choose another time.')
    if len({c.utcoffset() for c in candidates}) > 1:
        raise ValueError('This Pacific time occurs twice because of daylight saving time. Choose a time outside the repeated hour.')
    return candidates[0]


def initialize():
    DB.parent.mkdir(parents=True, exist_ok=True)
    with connection() as db:
        db.executescript('''
        CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY, name TEXT NOT NULL,
          email TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS equipment(id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers,
          kind TEXT NOT NULL, brand TEXT NOT NULL, model TEXT NOT NULL, serial TEXT NOT NULL, next_service TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS technicians(id INTEGER PRIMARY KEY, name TEXT NOT NULL, specialty TEXT NOT NULL, color TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS quotes(id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers,
          title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Draft', items TEXT NOT NULL,
          subtotal INTEGER NOT NULL, tax_bps INTEGER NOT NULL, total INTEGER NOT NULL, created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY, quote_id INTEGER UNIQUE NOT NULL REFERENCES quotes,
          customer_id INTEGER NOT NULL REFERENCES customers, technician_id INTEGER NOT NULL REFERENCES technicians,
          title TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Scheduled',
          priority TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS invoices(id INTEGER PRIMARY KEY, job_id INTEGER UNIQUE NOT NULL REFERENCES jobs,
          customer_id INTEGER NOT NULL REFERENCES customers, total INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'Unpaid',
          created TEXT NOT NULL, paid_at TEXT);
        ''')
        if db.execute('SELECT COUNT(*) FROM customers').fetchone()[0]:
            return
        db.executemany('INSERT INTO customers VALUES(?,?,?,?,?,?)', [
            (1, 'Olivia Bennett', 'olivia@example.com', '(619) 555-0101', '1428 Juniper St, San Diego, CA 92101', 'Gate code available on arrival. Call before dispatch.'),
            (2, 'James Mitchell', 'james@example.com', '(619) 555-0102', '3850 Park Blvd, San Diego, CA 92103', 'Upstairs thermostat. Dog in the backyard.'),
            (3, 'Harbor Coffee Co.', 'facilities@example.com', '(619) 555-0103', '790 Market St, San Diego, CA 92101', 'Commercial rooftop unit. Access from rear stairwell.'),
            (4, 'Sophia Chen', 'sophia@example.com', '(858) 555-0104', '6520 Caminito Northland, La Jolla, CA 92037', 'Prefers morning appointments. Filter size 20 × 25 × 4.'),
            (5, 'Daniel Rivera', 'daniel@example.com', '(858) 555-0105', '2204 Adams Ave, San Diego, CA 92116', 'Interested in a heat pump upgrade.')])
        db.executemany('INSERT INTO technicians VALUES(?,?,?,?)', [(1, 'Alex Morgan', 'Service & repair', '#248977'), (2, 'Jordan Lee', 'Installations', '#6585c5'), (3, 'Chris Davis', 'Commercial HVAC', '#be874b')])
        day = date.fromisoformat(today())
        db.executemany('INSERT INTO equipment VALUES(?,?,?,?,?,?,?)', [
            (1, 1, 'Central AC', 'Carrier', '24ACC6', 'DEMO-AC-1001', (day + timedelta(days=12)).isoformat()),
            (2, 2, 'Gas furnace', 'Trane', 'S9V2', 'DEMO-FR-1002', (day - timedelta(days=4)).isoformat()),
            (3, 3, 'Rooftop unit', 'Lennox', 'L Series', 'DEMO-RT-1003', (day + timedelta(days=5)).isoformat()),
            (4, 4, 'Heat pump', 'Daikin', 'Fit', 'DEMO-HP-1004', (day + timedelta(days=20)).isoformat())])
        seeds = [(1, 'AC not cooling', 18500), (2, 'Fall furnace tune-up', 14900), (3, 'Rooftop unit diagnosis', 29500), (4, 'Heat pump maintenance', 16500), (5, 'Heat pump installation', 820000)]
        for i, (cid, title, amount) in enumerate(seeds, 1):
            items = json.dumps([{'description': title, 'quantity': 1, 'unit_cents': amount}])
            db.execute('INSERT INTO quotes(id,customer_id,title,status,items,subtotal,tax_bps,total,created) VALUES(?,?,?,?,?,?,?,?,?)', (i, cid, title, 'Draft' if i == 5 else 'Approved', items, amount, 0, amount, today()))
        for i, tech, hour, state, priority in [(1, 1, 9, 'In progress', 'Urgent'), (2, 2, 10, 'Scheduled', 'Normal'), (3, 3, 11, 'En route', 'High'), (4, 1, 13, 'Completed', 'Normal')]:
            db.execute('INSERT INTO jobs(id,quote_id,customer_id,technician_id,title,start,end,status,priority,notes) VALUES(?,?,?,?,?,?,?,?,?,?)', (i, i, i, tech, seeds[i-1][1], f'{today()}T{hour:02d}:00', f'{today()}T{hour+1:02d}:00', state, priority, ''))
        db.execute('INSERT INTO invoices VALUES(1,4,4,16500,?,?,NULL)', ('Unpaid', today()))


def upgrade():
    with connection() as db:
        db.executescript('''
        CREATE TABLE IF NOT EXISTS properties(id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers,
          label TEXT NOT NULL, address TEXT NOT NULL, access_notes TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers,
          title TEXT NOT NULL, description TEXT NOT NULL, source TEXT NOT NULL, priority TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'New', created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices,
          amount INTEGER NOT NULL CHECK(amount>0), method TEXT NOT NULL, reference TEXT NOT NULL, created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS agreements(id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers,
          name TEXT NOT NULL, price INTEGER NOT NULL, interval_months INTEGER NOT NULL, next_visit TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'Active');
        CREATE TABLE IF NOT EXISTS pricebook(id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
          unit_cents INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY, title TEXT NOT NULL, due TEXT NOT NULL,
          customer_id INTEGER REFERENCES customers, done INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers,
          job_id INTEGER REFERENCES jobs, body TEXT NOT NULL, created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers,
          channel TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS files(id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers,
          job_id INTEGER REFERENCES jobs, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
          content BLOB NOT NULL, created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS activities(id INTEGER PRIMARY KEY, action TEXT NOT NULL, record_id INTEGER,
          created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), company TEXT NOT NULL,
          email TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL, tax_bps INTEGER NOT NULL DEFAULT 0,
          invoice_days INTEGER NOT NULL DEFAULT 14);
        CREATE TABLE IF NOT EXISTS time_entries(id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs,
          technician_id INTEGER NOT NULL REFERENCES technicians, started TEXT NOT NULL, stopped TEXT);
        CREATE TABLE IF NOT EXISTS expenses(id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs,
          vendor TEXT NOT NULL, category TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>=0),
          incurred TEXT NOT NULL, description TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS inventory(id INTEGER PRIMARY KEY, sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
          quantity INTEGER NOT NULL CHECK(quantity>=0), reorder_at INTEGER NOT NULL CHECK(reorder_at>=0), unit_cost INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS stock_movements(id INTEGER PRIMARY KEY, inventory_id INTEGER NOT NULL REFERENCES inventory,
          job_id INTEGER REFERENCES jobs, quantity INTEGER NOT NULL, unit_cost INTEGER NOT NULL, reason TEXT NOT NULL, created TEXT NOT NULL);
        ''')
        for table, column, definition in [
            ('customers','active','INTEGER NOT NULL DEFAULT 1'),
            ('equipment','property_id','INTEGER REFERENCES properties'),
            ('quotes','request_id','INTEGER REFERENCES requests'),
            ('quotes','property_id','INTEGER REFERENCES properties'),
            ('quotes','discount','INTEGER NOT NULL DEFAULT 0'),
            ('jobs','checklist',"TEXT NOT NULL DEFAULT '[]'"),
            ('invoices','due','TEXT'),
            ('technicians','active','INTEGER NOT NULL DEFAULT 1')]:
            if column not in [r['name'] for r in db.execute(f'PRAGMA table_info({table})')]:
                db.execute(f'ALTER TABLE {table} ADD COLUMN {column} {definition}')
        db.execute('UPDATE invoices SET due=date(created,? ) WHERE due IS NULL', ('+14 days',))
        db.execute("INSERT OR IGNORE INTO settings VALUES(1,'Northstar Heating & Air','office@example.com','(619) 555-0100','San Diego, California',0,14)")
        if not db.execute('SELECT id FROM properties LIMIT 1').fetchone():
            for c in db.execute('SELECT * FROM customers').fetchall():
                p = db.execute('INSERT INTO properties(customer_id,label,address,access_notes) VALUES(?,?,?,?)',(c['id'],'Primary property',c['address'],c['notes'])).lastrowid
                db.execute('UPDATE equipment SET property_id=? WHERE customer_id=?',(p,c['id']))
        if not db.execute('SELECT id FROM pricebook LIMIT 1').fetchone():
            db.executemany('INSERT INTO pricebook(name,category,unit_cents) VALUES(?,?,?)',[
                ('Diagnostic visit','Service',8900),('AC tune-up','Maintenance',14900),('Furnace tune-up','Maintenance',14900),
                ('Heat pump installation','Installation',820000),('Capacitor replacement','Repair',19500),
                ('Refrigerant leak inspection','Service',22500),('Air filter replacement','Parts',4500),('Commercial rooftop service','Commercial',29500)])
            db.execute('INSERT INTO requests(customer_id,title,description,source,priority,created) VALUES(?,?,?,?,?,?)',
                (5,'Heat pump replacement consultation','Existing unit is 14 years old. Interested in efficiency and electric heating.','Website','Normal',today()))
            db.execute('INSERT INTO agreements(customer_id,name,price,interval_months,next_visit) VALUES(?,?,?,?,?)',
                (2,'Comfort Care — seasonal tune-up',14900,6,(date.fromisoformat(today())-timedelta(days=4)).isoformat()))
            db.execute('INSERT INTO tasks(title,due,customer_id) VALUES(?,?,?)',('Follow up on heat pump estimate',today(),5))
        if not db.execute('SELECT id FROM inventory LIMIT 1').fetchone():
            db.executemany('INSERT INTO inventory(sku,name,quantity,reorder_at,unit_cost) VALUES(?,?,?,?,?)',[
                ('CAP-45-5','Dual-run capacitor 45/5 μF',8,3,2800),('FLT-20254','Air filter 20 × 25 × 4',3,5,2200),('CNT-2P30','2-pole contactor 30A',6,2,1850)])


def optional_text(data, key, limit=4000):
    value = data.get(key, '')
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError(f'{key} must be text of at most {limit} characters.')
    return value.strip()


def owned_property(db, pid, cid):
    if pid is not None:
        if not isinstance(pid, int) or isinstance(pid, bool) or record(db, 'properties', pid)['customer_id'] != cid:
            raise ValueError('Property must belong to this customer.')
    return pid


def extra_mutation(db, route, data):
    if route == '/api/time/start':
        job=record(db,'jobs',identifier(data,'job_id'))
        if job['status']!='In progress':raise ValueError('Start the job before starting a work timer.')
        if db.execute('SELECT id FROM time_entries WHERE technician_id=? AND stopped IS NULL',(job['technician_id'],)).fetchone():
            raise ValueError('This technician already has a running timer. Stop it first.')
        rid=db.execute('INSERT INTO time_entries(job_id,technician_id,started) VALUES(?,?,?)',(job['id'],job['technician_id'],datetime.now(BUSINESS_TZ).isoformat())).lastrowid
        return {'id':rid,'job_id':job['id']}
    if route == '/api/time/stop':
        rid=identifier(data,'id');entry=record(db,'time_entries',rid)
        if entry['stopped'] is not None:raise ValueError('This timer is already stopped.')
        db.execute('UPDATE time_entries SET stopped=? WHERE id=?',(datetime.now(BUSINESS_TZ).isoformat(),rid))
        return {'id':rid,'job_id':entry['job_id']}
    if route == '/api/time/manual':
        job=record(db,'jobs',identifier(data,'job_id'))
        start,end=required(data,'started',16),required(data,'stopped',16)
        a,b=local_datetime(start),local_datetime(end)
        if b<=a or b.astimezone(timezone.utc)-a.astimezone(timezone.utc)>timedelta(hours=24):raise ValueError('Enter a valid work period of at most 24 hours in Pacific time.')
        if b>datetime.now(BUSINESS_TZ):raise ValueError('Recorded time cannot be in the future.')
        periods=db.execute('SELECT started,stopped FROM time_entries WHERE technician_id=?',(job['technician_id'],)).fetchall()
        now=datetime.now(timezone.utc)
        if any(datetime.fromisoformat(p['started']).astimezone(timezone.utc)<b.astimezone(timezone.utc) and
               (datetime.fromisoformat(p['stopped']).astimezone(timezone.utc) if p['stopped'] else now)>a.astimezone(timezone.utc) for p in periods):
            raise ValueError('This technician already has time recorded during that period.')
        rid=db.execute('INSERT INTO time_entries(job_id,technician_id,started,stopped) VALUES(?,?,?,?)',(job['id'],job['technician_id'],a.isoformat(),b.isoformat())).lastrowid
        return {'id':rid}
    if route == '/api/expenses':
        jid=identifier(data,'job_id');record(db,'jobs',jid)
        incurred=required(data,'incurred',10);date.fromisoformat(incurred)
        rid=db.execute('INSERT INTO expenses(job_id,vendor,category,amount,incurred,description) VALUES(?,?,?,?,?,?)',
            (jid,required(data,'vendor',150),required(data,'category',80),money(data.get('amount')),incurred,required(data,'description',500))).lastrowid
        return {'id':rid}
    if route == '/api/inventory':
        qty,threshold=data.get('quantity'),data.get('reorder_at')
        if type(qty) is not int or not 0<=qty<=100000 or type(threshold) is not int or not 0<=threshold<=100000:
            raise ValueError('Stock and reorder point must be whole numbers from 0 to 100,000.')
        cost=money(data.get('unit_cost'))
        rid=db.execute('INSERT INTO inventory(sku,name,quantity,reorder_at,unit_cost) VALUES(?,?,?,?,?)',
            (required(data,'sku',80),required(data,'name',150),qty,threshold,cost)).lastrowid
        db.execute('INSERT INTO stock_movements(inventory_id,quantity,unit_cost,reason,created) VALUES(?,?,?,?,?)',
            (rid,qty,cost,'Opening stock',datetime.now(BUSINESS_TZ).isoformat()))
        return {'id':rid}
    if route == '/api/inventory/move':
        rid=identifier(data,'id');part=record(db,'inventory',rid)
        delta=data.get('quantity')
        if type(delta) is not int or delta==0 or abs(delta)>100000:raise ValueError('Enter a nonzero whole-number stock change (maximum 100,000).')
        jid=data.get('job_id')
        if jid is not None:
            job=record(db,'jobs',identifier(data,'job_id'))
            if job['status']!='In progress' or delta>=0:raise ValueError('Job part usage requires an in-progress job and a negative stock change.')
        if part['quantity']+delta<0:raise ValueError('Not enough stock for this change.')
        db.execute('UPDATE inventory SET quantity=quantity+? WHERE id=?',(delta,rid))
        db.execute('INSERT INTO stock_movements(inventory_id,job_id,quantity,unit_cost,reason,created) VALUES(?,?,?,?,?,?)',
            (rid,jid,delta,part['unit_cost'],required(data,'reason',300),datetime.now(BUSINESS_TZ).isoformat()))
        return {'id':rid}
    if route == '/api/customers/update':
        rid=identifier(data,'id'); record(db,'customers',rid)
        fields=[required(data,k,200) for k in ['name','email','phone','address']]
        validate_email(fields[1])
        db.execute('UPDATE customers SET name=?,email=?,phone=?,address=?,notes=? WHERE id=?',(*fields,optional_text(data,'notes'),rid))
        return {'id':rid}
    if route == '/api/customers/archive':
        rid=identifier(data,'id');record(db,'customers',rid)
        active = data.get('active')
        if type(active) is not bool: raise ValueError('Specify active true or false.')
        if not active and db.execute("SELECT id FROM jobs WHERE customer_id=? AND status NOT IN ('Completed','Canceled')",(rid,)).fetchone():
            raise ValueError('Complete or cancel open jobs before archiving this customer.')
        db.execute('UPDATE customers SET active=? WHERE id=?',(int(active),rid));return {'id':rid}
    if route == '/api/properties':
        cid=identifier(data,'customer_id');record(db,'customers',cid)
        rid=db.execute('INSERT INTO properties(customer_id,label,address,access_notes) VALUES(?,?,?,?)',
            (cid,required(data,'label',100),required(data,'address',300),optional_text(data,'access_notes'))).lastrowid
        return {'id':rid}
    if route == '/api/equipment/service':
        rid=identifier(data,'id');record(db,'equipment',rid)
        due=required(data,'next_service',10);date.fromisoformat(due)
        db.execute('UPDATE equipment SET next_service=? WHERE id=?',(due,rid));return {'id':rid}
    if route == '/api/requests':
        cid=identifier(data,'customer_id');record(db,'customers',cid)
        priority=data.get('priority','Normal')
        if priority not in ['Normal','High','Urgent']:raise ValueError('Invalid priority.')
        rid=db.execute('INSERT INTO requests(customer_id,title,description,source,priority,created) VALUES(?,?,?,?,?,?)',
            (cid,required(data,'title',200),required(data,'description',4000),required(data,'source',80),priority,today())).lastrowid
        return {'id':rid}
    if route == '/api/requests/status':
        rid=identifier(data,'id');record(db,'requests',rid);status=data.get('status')
        if status not in ['New','Contacted','Won','Lost']:raise ValueError('Invalid request status.')
        db.execute('UPDATE requests SET status=? WHERE id=?',(status,rid));return {'id':rid}
    if route == '/api/jobs/reschedule':
        rid=identifier(data,'id');job=record(db,'jobs',rid)
        if job['status'] not in ['Scheduled','En route']:raise ValueError('Only scheduled or en-route jobs can be rescheduled.')
        tid=identifier(data,'technician_id');tech=record(db,'technicians',tid)
        if not tech['active']:raise ValueError('Choose an active technician.')
        start,end=required(data,'start',16),required(data,'end',16)
        a,b=local_datetime(start),local_datetime(end)
        if b<=a or a.date()!=b.date() or b.astimezone(timezone.utc)-a.astimezone(timezone.utc)>timedelta(hours=12):
            raise ValueError('Choose valid same-day local start/end times (maximum 12 hours).')
        if db.execute("SELECT id FROM jobs WHERE id!=? AND technician_id=? AND status NOT IN ('Completed','Canceled') AND start<? AND end>?",(rid,tid,end,start)).fetchone():
            raise ValueError('Technician already has a job during this time.')
        db.execute('UPDATE jobs SET technician_id=?,start=?,end=? WHERE id=?',(tid,start,end,rid));return {'id':rid}
    if route == '/api/jobs/cancel':
        rid=identifier(data,'id');job=record(db,'jobs',rid)
        if job['status'] in ['Completed','Canceled']:raise ValueError('This job is already closed.')
        db.execute("UPDATE jobs SET status='Canceled' WHERE id=?",(rid,))
        db.execute('UPDATE time_entries SET stopped=? WHERE job_id=? AND stopped IS NULL',(datetime.now(BUSINESS_TZ).isoformat(),rid))
        return {'id':rid}
    if route == '/api/jobs/notes':
        rid=identifier(data,'id');record(db,'jobs',rid)
        checks=data.get('checklist',[])
        if not isinstance(checks,list) or len(checks)>30 or any(not isinstance(i,dict) or not isinstance(i.get('label'),str) or len(i['label'])>200 or type(i.get('done')) is not bool for i in checks):
            raise ValueError('Invalid checklist.')
        db.execute('UPDATE jobs SET notes=?,checklist=? WHERE id=?',(optional_text(data,'notes'),json.dumps(checks),rid));return {'id':rid}
    if route == '/api/technicians':
        rid=db.execute('INSERT INTO technicians(name,specialty,color) VALUES(?,?,?)',
            (required(data,'name',100),required(data,'specialty',100),'#6585c5')).lastrowid
        return {'id':rid}
    if route == '/api/technicians/active':
        rid=identifier(data,'id');record(db,'technicians',rid);active=data.get('active')
        if type(active) is not bool:raise ValueError('Specify active true or false.')
        if not active and db.execute("SELECT id FROM jobs WHERE technician_id=? AND status NOT IN ('Completed','Canceled')",(rid,)).fetchone():
            raise ValueError('Reassign or close open jobs before deactivating this technician.')
        db.execute('UPDATE technicians SET active=? WHERE id=?',(int(active),rid));return {'id':rid}
    if route == '/api/pricebook':
        values=(required(data,'name',150),required(data,'category',80),money(data.get('unit_price')))
        if data.get('id'):
            rid=identifier(data,'id');record(db,'pricebook',rid)
            db.execute('UPDATE pricebook SET name=?,category=?,unit_cents=? WHERE id=?',(*values,rid))
        else:rid=db.execute('INSERT INTO pricebook(name,category,unit_cents) VALUES(?,?,?)',values).lastrowid
        return {'id':rid}
    if route == '/api/pricebook/archive':
        rid=identifier(data,'id');record(db,'pricebook',rid)
        db.execute('UPDATE pricebook SET active=0 WHERE id=?',(rid,));return {'id':rid}
    if route == '/api/agreements':
        cid=identifier(data,'customer_id');record(db,'customers',cid)
        interval=data.get('interval_months')
        if type(interval) is not int or interval not in [1,3,6,12]:raise ValueError('Choose monthly, quarterly, semiannual, or annual visits.')
        due=required(data,'next_visit',10);date.fromisoformat(due)
        rid=db.execute('INSERT INTO agreements(customer_id,name,price,interval_months,next_visit) VALUES(?,?,?,?,?)',
            (cid,required(data,'name',150),money(data.get('unit_price')),interval,due)).lastrowid
        return {'id':rid}
    if route == '/api/agreements/status':
        rid=identifier(data,'id');record(db,'agreements',rid);status=data.get('status')
        if status not in ['Active','Paused','Canceled']:raise ValueError('Invalid agreement status.')
        db.execute('UPDATE agreements SET status=? WHERE id=?',(status,rid));return {'id':rid}
    if route == '/api/agreements/visit':
        rid=identifier(data,'id');agreement=record(db,'agreements',rid)
        if agreement['status']!='Active' or agreement['next_visit']>today():raise ValueError('This agreement has no visit due yet.')
        title=agreement['name']+' · '+agreement['next_visit']
        item=json.dumps([{'description':title,'quantity':1,'unit_cents':agreement['price']}])
        qid=db.execute("INSERT INTO quotes(customer_id,title,status,items,subtotal,tax_bps,total,created) VALUES(?,?,'Approved',?,?,0,?,?)",
            (agreement['customer_id'],title,item,agreement['price'],agreement['price'],today())).lastrowid
        due=date.fromisoformat(agreement['next_visit']);month=due.month-1+agreement['interval_months'];year=due.year+month//12;month=month%12+1
        next_date=date(year,month,min(due.day,calendar.monthrange(year,month)[1]))
        db.execute('UPDATE agreements SET next_visit=? WHERE id=?',(next_date.isoformat(),rid))
        return {'id':rid,'quote_id':qid}
    if route == '/api/tasks':
        cid=data.get('customer_id')
        if cid is not None:record(db,'customers',identifier(data,'customer_id'))
        due=required(data,'due',10);date.fromisoformat(due)
        rid=db.execute('INSERT INTO tasks(title,due,customer_id) VALUES(?,?,?)',(required(data,'title',200),due,cid)).lastrowid
        return {'id':rid}
    if route == '/api/tasks/done':
        rid=identifier(data,'id');record(db,'tasks',rid)
        done=data.get('done')
        if type(done) is not bool:raise ValueError('Specify done true or false.')
        db.execute('UPDATE tasks SET done=? WHERE id=?',(int(done),rid));return {'id':rid}
    if route in ['/api/notes','/api/messages','/api/files']:
        cid=identifier(data,'customer_id');record(db,'customers',cid)
        jid=data.get('job_id')
        if jid is not None and record(db,'jobs',identifier(data,'job_id'))['customer_id']!=cid:
            raise ValueError('Job must belong to this customer.')
        if route=='/api/notes':
            rid=db.execute('INSERT INTO notes(customer_id,job_id,body,created) VALUES(?,?,?,?)',(cid,jid,required(data,'body',4000),today())).lastrowid
        elif route=='/api/messages':
            channel=data.get('channel')
            if channel not in ['Email','SMS']:raise ValueError('Choose Email or SMS.')
            rid=db.execute('INSERT INTO messages(customer_id,channel,subject,body,created) VALUES(?,?,?,?,?)',
                (cid,channel,optional_text(data,'subject',200),required(data,'body',4000),today())).lastrowid
        else:
            name=Path(required(data,'name',200)).name;mime=required(data,'mime',80)
            try:content=base64.b64decode(required(data,'content',2800000),validate=True)
            except Exception:raise ValueError('Invalid file encoding.')
            signatures={'image/png':b'\x89PNG\r\n\x1a\n','image/jpeg':b'\xff\xd8\xff','application/pdf':b'%PDF-'}
            if mime not in signatures or not content.startswith(signatures[mime]) or len(content)>2000000:
                raise ValueError('Upload a PNG, JPEG, or PDF of at most 2 MB.')
            rid=db.execute('INSERT INTO files(customer_id,job_id,name,mime,size,content,created) VALUES(?,?,?,?,?,?,?)',
                (cid,jid,name,mime,len(content),content,today())).lastrowid
        return {'id':rid}
    if route == '/api/settings':
        rate,days=data.get('tax_bps'),data.get('invoice_days')
        if type(rate) is not int or not 0<=rate<=2000 or type(days) is not int or not 1<=days<=90:
            raise ValueError('Tax must be 0–20% and payment terms 1–90 days.')
        fields=[required(data,k,200) for k in ['company','email','phone','address']]
        validate_email(fields[1])
        db.execute('UPDATE settings SET company=?,email=?,phone=?,address=?,tax_bps=?,invoice_days=? WHERE id=1',(*fields,rate,days))
        return {'id':1}
    raise LookupError('Endpoint not found.')


def required(data, key, limit=500):
    value = data.get(key)
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > limit:
        raise ValueError(f'{key.replace("_", " ").capitalize()} is required (maximum {limit} characters).')
    return value.strip()


def validate_email(value):
    if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',value):
        raise ValueError('Enter a valid email address.')
    return value


def identifier(data, key):
    value = data.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f'Choose a valid {key.replace("_id", "")}.')
    return value


def record(db, table, rid):
    row = db.execute(f'SELECT * FROM {table} WHERE id=?', (rid,)).fetchone()
    if row is None:
        raise LookupError('Record not found.')
    return row


def money(value):
    try:
        result = Decimal(str(value))
        if not result.is_finite() or result < 0 or result > 1000000 or result.as_tuple().exponent < -2:
            raise ValueError('Unit price must be between $0 and $1,000,000, with at most two decimals.')
        return int(result * 100)
    except (InvalidOperation, TypeError):
        raise ValueError('Enter a valid unit price.')


def mutate(db, route, data):
    if route == '/api/customers':
        name, email, phone, address = [required(data, k, 200) for k in ['name', 'email', 'phone', 'address']]
        validate_email(email)
        notes = data.get('notes', '')
        if not isinstance(notes, str) or len(notes) > 4000:
            raise ValueError('Notes must be at most 4,000 characters.')
        rid = db.execute('INSERT INTO customers(name,email,phone,address,notes) VALUES(?,?,?,?,?)', (name, email, phone, address, notes)).lastrowid
        return {'id': rid}
    if route == '/api/equipment':
        cid = identifier(data, 'customer_id'); record(db, 'customers', cid)
        pid = owned_property(db, data.get('property_id'), cid)
        fields = [required(data, k, 200) for k in ['kind', 'brand', 'model', 'serial', 'next_service']]
        date.fromisoformat(fields[-1])
        rid = db.execute('INSERT INTO equipment(customer_id,kind,brand,model,serial,next_service,property_id) VALUES(?,?,?,?,?,?,?)', (cid, *fields, pid)).lastrowid
        return {'id': rid}
    if route in ['/api/quotes', '/api/quotes/update']:
        cid = identifier(data, 'customer_id'); record(db, 'customers', cid)
        existing = record(db, 'quotes', identifier(data, 'id')) if route.endswith('/update') else None
        if existing and existing['status'] != 'Draft':
            raise ValueError('Only draft estimates can be edited. Approved pricing is locked to its job and invoice.')
        pid = owned_property(db, data.get('property_id'), cid)
        reqid = data.get('request_id')
        if reqid is not None and record(db,'requests',identifier(data,'request_id'))['customer_id']!=cid:
            raise ValueError('Request must belong to this customer.')
        title = required(data, 'title', 200)
        raw = data.get('items')
        if not isinstance(raw, list) or not 1 <= len(raw) <= 30:
            raise ValueError('Add 1 to 30 line items.')
        items = []
        for item in raw:
            if not isinstance(item, dict): raise ValueError('Invalid line item.')
            description = required(item, 'description', 200)
            quantity = item.get('quantity')
            if isinstance(quantity, bool) or not isinstance(quantity, int) or not 1 <= quantity <= 999:
                raise ValueError('Quantity must be a whole number between 1 and 999.')
            items.append({'description': description, 'quantity': quantity, 'unit_cents': money(item.get('unit_price'))})
        rate = data.get('tax_bps', 0)
        if isinstance(rate, bool) or not isinstance(rate, int) or not 0 <= rate <= 2000:
            raise ValueError('Tax rate must be between 0% and 20%.')
        subtotal = sum(i['quantity'] * i['unit_cents'] for i in items)
        discount = money(data.get('discount', '0'))
        if discount > subtotal: raise ValueError('Discount cannot exceed subtotal.')
        tax = int((Decimal(subtotal-discount) * rate / 10000).quantize(Decimal('1'), rounding=ROUND_HALF_UP))
        total = subtotal-discount+tax
        if existing:
            rid = existing['id']
            db.execute('UPDATE quotes SET customer_id=?,title=?,items=?,subtotal=?,tax_bps=?,total=?,request_id=?,property_id=?,discount=? WHERE id=?',
                (cid,title,json.dumps(items),subtotal,rate,total,reqid,pid,discount,rid))
        else:
            rid = db.execute('INSERT INTO quotes(customer_id,title,items,subtotal,tax_bps,total,created,request_id,property_id,discount) VALUES(?,?,?,?,?,?,?,?,?,?)', (cid, title, json.dumps(items), subtotal, rate, total, today(), reqid, pid, discount)).lastrowid
        return {'id': rid, 'total': total}
    if route == '/api/quotes/approve':
        rid = identifier(data, 'id'); q = record(db, 'quotes', rid)
        if q['status'] == 'Declined':raise ValueError('A declined estimate cannot be approved. Prepare a new estimate.')
        db.execute("UPDATE quotes SET status='Approved' WHERE id=?", (rid,))
        if q['request_id']: db.execute("UPDATE requests SET status='Won' WHERE id=?",(q['request_id'],))
        return {'id': rid}
    if route == '/api/quotes/decline':
        rid=identifier(data,'id');q=record(db,'quotes',rid)
        if q['status']!='Draft':raise ValueError('Only draft estimates can be declined.')
        db.execute("UPDATE quotes SET status='Declined' WHERE id=?",(rid,));return {'id':rid}
    if route == '/api/jobs':
        q = record(db, 'quotes', identifier(data, 'quote_id'))
        tid = identifier(data, 'technician_id'); tech = record(db, 'technicians', tid)
        if not tech['active']: raise ValueError('Choose an active technician.')
        if not record(db,'customers',q['customer_id'])['active']:raise ValueError('Restore this customer before scheduling.')
        if q['status'] != 'Approved': raise ValueError('Record customer approval before scheduling.')
        if db.execute('SELECT id FROM jobs WHERE quote_id=?', (q['id'],)).fetchone(): raise ValueError('This estimate already has a job.')
        start, end = required(data, 'start', 16), required(data, 'end', 16)
        a, b = local_datetime(start), local_datetime(end)
        if b <= a or a.date() != b.date() or b.astimezone(timezone.utc)-a.astimezone(timezone.utc) > timedelta(hours=12):
            raise ValueError('Choose an end time after the start, on the same day (maximum 12 hours).')
        if db.execute("SELECT id FROM jobs WHERE technician_id=? AND status NOT IN ('Completed','Canceled') AND start<? AND end>?", (tid, end, start)).fetchone():
            raise ValueError('Technician already has a job during this time. Choose another time or technician.')
        priority = data.get('priority', 'Normal')
        if priority not in ['Normal', 'High', 'Urgent']: raise ValueError('Invalid priority.')
        rid = db.execute('INSERT INTO jobs(quote_id,customer_id,technician_id,title,start,end,priority) VALUES(?,?,?,?,?,?,?)', (q['id'], q['customer_id'], tid, q['title'], start, end, priority)).lastrowid
        return {'id': rid}
    if route == '/api/jobs/status':
        rid = identifier(data, 'id'); job = record(db, 'jobs', rid)
        new = required(data, 'status', 30)
        if job['status'] not in STATES:raise ValueError('This job is closed.')
        i = STATES.index(job['status'])
        if i == len(STATES)-1 or new != STATES[i+1]: raise ValueError('Move the job forward one step at a time.')
        notes = data.get('notes', job['notes'])
        if not isinstance(notes, str) or len(notes) > 4000: raise ValueError('Notes must be at most 4,000 characters.')
        db.execute('UPDATE jobs SET status=?,notes=? WHERE id=?', (new, notes, rid))
        if new=='In progress':
            if db.execute('SELECT id FROM time_entries WHERE technician_id=? AND stopped IS NULL',(job['technician_id'],)).fetchone():
                raise ValueError('This technician already has a running work timer. Stop it before starting another job.')
            db.execute('INSERT INTO time_entries(job_id,technician_id,started) VALUES(?,?,?)',(rid,job['technician_id'],datetime.now(BUSINESS_TZ).isoformat()))
        if new=='Completed':
            db.execute('UPDATE time_entries SET stopped=? WHERE job_id=? AND stopped IS NULL',(datetime.now(BUSINESS_TZ).isoformat(),rid))
        return {'id': rid}
    if route == '/api/invoices':
        job = record(db, 'jobs', identifier(data, 'job_id'))
        if job['status'] != 'Completed': raise ValueError('Complete the job before invoicing.')
        existing = db.execute('SELECT id FROM invoices WHERE job_id=?', (job['id'],)).fetchone()
        if existing: return {'id': existing['id']}
        q = record(db, 'quotes', job['quote_id'])
        rid = db.execute('INSERT INTO invoices(job_id,customer_id,total,created) VALUES(?,?,?,?)', (job['id'], job['customer_id'], q['total'], today())).lastrowid
        days=record(db,'settings',1)['invoice_days']
        db.execute('UPDATE invoices SET due=? WHERE id=?',((date.fromisoformat(today())+timedelta(days=days)).isoformat(),rid))
        if q['total']==0:db.execute("UPDATE invoices SET status='Paid',paid_at=? WHERE id=?",(datetime.now(BUSINESS_TZ).isoformat(),rid))
        return {'id': rid}
    if route == '/api/invoices/pay':
        rid = identifier(data, 'id'); invoice = record(db, 'invoices', rid)
        paid = db.execute('SELECT COALESCE(SUM(amount),0) FROM payments WHERE invoice_id=?',(rid,)).fetchone()[0]
        amount = money(data.get('amount', str(Decimal(invoice['total']-paid)/100)))
        if amount<=0 or amount>invoice['total']-paid:raise ValueError('Payment must be greater than zero and no more than the outstanding balance.')
        method=data.get('method','Other')
        if method not in ['Cash','Check','Bank transfer','Card (external)','Other']:raise ValueError('Choose a valid payment method.')
        now=datetime.now(BUSINESS_TZ).isoformat()
        db.execute('INSERT INTO payments(invoice_id,amount,method,reference,created) VALUES(?,?,?,?,?)',(rid,amount,method,optional_text(data,'reference',200),now))
        complete=paid+amount==invoice['total']
        db.execute('UPDATE invoices SET status=?,paid_at=? WHERE id=?',('Paid' if complete else 'Partially paid',now if complete else None,rid))
        return {'id':rid}
    return extra_mutation(db,route,data)


class Handler(BaseHTTPRequestHandler):
    def allowed_origin(self, origin):
        return not origin or origin == 'http://' + self.headers.get('Host', '')

    def reply(self, status, value, content_type='application/json; charset=utf-8'):
        body = json.dumps(value).encode() if content_type.startswith('application/json') else value
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
        self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        route = urlsplit(self.path).path
        if route == '/api/health':
            try:
                with connection() as db:
                    db.execute('SELECT id FROM settings WHERE id=1').fetchone()
                    db.execute('SELECT id FROM jobs LIMIT 1').fetchone()
                self.reply(200, {'product':'airframe','version':VERSION,'status':'ready','timezone':ZONE,
                    'workspace':hashlib.sha256(str(DB.resolve()).encode()).hexdigest()[:16]})
            except sqlite3.Error:
                self.reply(503, {'product':'airframe','status':'unavailable'})
            return
        if route == '/api/backup':
            with tempfile.TemporaryDirectory(prefix='airframe-download-') as temporary:
                path=snapshot_database(DB,Path(temporary)/'airframe.sqlite3')
                content=path.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type','application/vnd.sqlite3')
            self.send_header('Content-Disposition',f'attachment; filename="airframe-backup-{today()}.sqlite3"')
            self.send_header('Cache-Control','no-store')
            self.send_header('Content-Length',str(len(content)))
            self.send_header('X-Content-Type-Options','nosniff')
            self.end_headers();self.wfile.write(content)
            return
        if route == '/api/state':
            with connection() as db:
                db.execute('BEGIN')
                state = {t: [dict(r) for r in db.execute(f'SELECT * FROM {t} ORDER BY id')] for t in TABLES if t!='files'}
                state['files']=[dict(r) for r in db.execute('SELECT id,customer_id,job_id,name,mime,size,created FROM files ORDER BY id')]
            for q in state['quotes']: q['items'] = json.loads(q['items'])
            for job in state['jobs']: job['checklist'] = json.loads(job['checklist'])
            state.update(today=today(), timezone=ZONE)
            self.reply(200, state); return
        if route.startswith('/files/'):
            try:
                rid=int(route.rsplit('/',1)[-1])
                with connection() as db:f=record(db,'files',rid)
                self.send_response(200)
                self.send_header('Content-Type',f['mime'])
                self.send_header('Content-Disposition','attachment; filename="attachment-'+str(rid)+('.pdf' if f['mime']=='application/pdf' else '.png' if f['mime']=='image/png' else '.jpg')+'"')
                self.send_header('Content-Length',str(f['size']))
                self.send_header('X-Content-Type-Options','nosniff')
                self.end_headers();self.wfile.write(f['content'])
            except (ValueError,LookupError):self.reply(404,{'error':'File not found.'})
            return
        if route=='/api/export':
            table=parse_qs(urlsplit(self.path).query).get('table',[''])[0]
            if table not in ['customers','requests','quotes','jobs','invoices','payments','equipment','agreements','time_entries','expenses','inventory','stock_movements']:
                self.reply(400,{'error':'Choose a supported export table.'});return
            with connection() as db:rows=[dict(r) for r in db.execute(f'SELECT * FROM {table}')]
            stream=io.StringIO();writer=csv.writer(stream)
            def safe(v):
                s=str(v) if v is not None else ''
                return "'"+s if s.lstrip().startswith(('=','+','-','@','\t','\r')) else s
            if rows:
                writer.writerow(rows[0].keys())
                writer.writerows([safe(v) for v in row.values()] for row in rows)
            self.reply(200,stream.getvalue().encode(),'text/csv; charset=utf-8');return
        files = {'/': ('index.html', 'text/html; charset=utf-8'), '/app.js': ('app.js', 'text/javascript; charset=utf-8'), '/style.css': ('style.css', 'text/css; charset=utf-8')}
        if route not in files: self.reply(404, {'error': 'Not found.'}); return
        name, kind = files[route]; self.reply(200, (ROOT/'static'/name).read_bytes(), kind)

    def do_POST(self):
        try:
            origin = self.headers.get('Origin')
            if not self.allowed_origin(origin):
                self.reply(403, {'error': 'Cross-origin requests are not allowed.'}); return
            if not self.headers.get('Content-Type', '').startswith('application/json'):
                self.reply(415, {'error': 'Send application/json.'}); return
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 3000000: raise ValueError('Request body must be between 1 and 3,000,000 bytes.')
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict): raise ValueError('Expected a JSON object.')
            with connection() as db:
                db.execute('BEGIN IMMEDIATE')
                result = mutate(db, urlsplit(self.path).path, data)
                db.execute('INSERT INTO activities(action,record_id,created) VALUES(?,?,?)',(urlsplit(self.path).path.removeprefix('/api/'),result.get('id'),datetime.now(BUSINESS_TZ).isoformat()))
            self.reply(200, result)
        except sqlite3.IntegrityError as error:
            message='An inventory item with this SKU already exists.' if 'inventory.sku' in str(error) else 'This record conflicts with an existing record.'
            self.reply(400, {'error': message})
        except (ValueError, TypeError, OverflowError) as error:
            self.reply(400, {'error': str(error)})
        except LookupError as error:
            self.reply(404, {'error': str(error)})


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8080)
    args = parser.parse_args()
    try:
        with WorkspaceLock(DB):
            initialize()
            upgrade()
            # A daily recovery point, including file attachments, before serving.
            daily=DB.parent/'backups'/f'airframe-daily-{today()}.sqlite3'
            if not daily.exists():snapshot_database(DB,daily)
            print(f'Airframe CRM {VERSION} listening on 127.0.0.1:{args.port} (local workspace)', flush=True)
            ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
    except KeyboardInterrupt:
        print('Airframe stopped. Your data is saved.', flush=True)
    except (RuntimeError, OSError, sqlite3.Error) as error:
        parser.exit(1, f'Unable to start Airframe: {error}\n')
