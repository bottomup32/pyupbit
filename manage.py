#!/usr/bin/env python3
"""Check, back up, or restore an Airframe workspace without losing local work."""
import argparse
from contextlib import closing
from datetime import datetime
import json
import os
from pathlib import Path
import sqlite3
import sys
from uuid import uuid4

from server import DB, BUSINESS_TZ, TABLES, VERSION
from storage import WorkspaceLock, snapshot_database


def validate(path):
    path = Path(path).resolve()
    if not path.is_file():
        raise ValueError('Database does not exist. Start Airframe once to create the sample workspace.')
    with closing(sqlite3.connect(path.as_uri()+'?mode=ro', uri=True)) as db:
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('The database integrity check failed.')
        if db.execute('PRAGMA foreign_key_check').fetchone():
            raise ValueError('The database contains an invalid linked record.')
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not set(TABLES).issubset(tables):
            raise ValueError('This file is not a complete Airframe workspace backup.')
        return {table:db.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0] for table in TABLES}


def backup_name(database, prefix='airframe'):
    stamp=datetime.now(BUSINESS_TZ).strftime('%Y%m%d-%H%M%S')
    return database.parent/'backups'/f'{prefix}-{stamp}-{uuid4().hex[:6]}.sqlite3'


def main():
    parser=argparse.ArgumentParser(description='Airframe data management')
    parser.add_argument('--database',type=Path,default=DB)
    subs=parser.add_subparsers(dest='command',required=True)
    subs.add_parser('check')
    backup=subs.add_parser('backup');backup.add_argument('--output',type=Path)
    restore=subs.add_parser('restore');restore.add_argument('source',type=Path)
    args=parser.parse_args()
    database=args.database.resolve()
    try:
        if args.command=='check':
            counts=validate(database)
            print(json.dumps({'version':VERSION,'integrity':'ok','foreign_keys':'ok','records':counts},indent=2))
        elif args.command=='backup':
            validate(database)
            path=snapshot_database(database,args.output or backup_name(database))
            validate(path)
            print(f'Backup created and verified: {path}')
        else:
            source=args.source.resolve()
            validate(source)
            if source==database:raise ValueError('Choose a backup file different from the active database.')
            with WorkspaceLock(database):
                before=None
                if database.exists():
                    before=snapshot_database(database,backup_name(database,'before-restore'))
                staged=database.with_name('.restore-'+uuid4().hex+'.sqlite3')
                try:
                    snapshot_database(source,staged)
                    validate(staged)
                    os.replace(staged,database)
                finally:
                    staged.unlink(missing_ok=True)
                print('Workspace restored and verified.')
                if before:print(f'Previous workspace preserved: {before}')
    except (ValueError,RuntimeError,OSError,sqlite3.Error) as error:
        parser.exit(1,str(error)+'\n')


if __name__=='__main__':
    main()
