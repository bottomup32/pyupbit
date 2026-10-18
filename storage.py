"""Cross-platform single-writer ownership for a local workspace database."""
import os
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path


class WorkspaceLock:
    def __init__(self, database):
        self.path = Path(str(database) + '.lock')
        self.handle = None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = self.path.open('a+b')
        try:
            if os.name == 'nt':
                import msvcrt
                self.handle.seek(0, 2)
                if self.handle.tell() == 0:
                    self.handle.write(b'0')
                    self.handle.flush()
                self.handle.seek(0)
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            self.handle.close()
            self.handle = None
            raise RuntimeError('This workspace is already running. Close its server before restoring or starting a second instance.') from error
        return self

    def __exit__(self, *args):
        if self.handle is not None:
            self.handle.close()
            self.handle = None


def snapshot_database(source, destination):
    """Use SQLite's online backup API, verify the copy, then publish atomically."""
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if source == destination:
        raise ValueError('Backup destination must differ from the active database.')
    if destination.exists():
        raise ValueError('Backup destination already exists; choose a new filename.')
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, staging = tempfile.mkstemp(prefix='.airframe-backup-', dir=destination.parent)
    os.close(fd)
    staging = Path(staging)
    try:
        with closing(sqlite3.connect(source.as_uri()+'?mode=ro', uri=True)) as original:
            with closing(sqlite3.connect(staging)) as copy:
                original.backup(copy)
                result = copy.execute('PRAGMA integrity_check').fetchone()[0]
                if result != 'ok':
                    raise ValueError('Backup integrity check failed: '+result)
        # Never replace an existing user backup, even if another process creates it.
        os.link(staging, destination)
        return destination
    finally:
        staging.unlink(missing_ok=True)
