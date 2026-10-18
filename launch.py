#!/usr/bin/env python3
"""Launch the local workspace, wait for readiness, and open its browser."""
import argparse
import json
import hashlib
import os
from pathlib import Path
import socket
import signal
import subprocess
import sys
import time
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parent


def ready(port):
    try:
        # Loopback readiness must not go through a company/network proxy.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f'http://127.0.0.1:{port}/api/health', timeout=1) as r:
            data = json.load(r)
            database=Path(os.environ.get('HVAC_DB',ROOT/'data'/'crm.sqlite3')).resolve()
            identity=hashlib.sha256(str(database).encode()).hexdigest()[:16]
            return data.get('product') == 'airframe' and data.get('status') == 'ready' and data.get('workspace')==identity
    except (OSError, ValueError):
        return False


def main():
    parser = argparse.ArgumentParser(description='Open Airframe CRM locally.')
    parser.add_argument('--port', type=int, default=8080)
    parser.add_argument('--no-browser', action='store_true', help='Do not open a desktop browser.')
    args = parser.parse_args()
    if sys.version_info < (3, 12):
        parser.exit(1, 'Please install Python 3.12 or later, then open this launcher again.\n')
    port = args.port
    if not 1 <= port <= 65535:
        parser.error('Port must be between 1 and 65535.')
    address = f'http://127.0.0.1:{port}'
    if ready(port):
        print(f'Airframe is already running: {address}')
        if not args.no_browser:
            webbrowser.open(address)
        return
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(('127.0.0.1', port))
        except OSError:
            parser.exit(1, f'Port {port} is in use by another program. Run launch.py --port {port+1}.\n')
    database=Path(os.environ.get('HVAC_DB',ROOT/'data'/'crm.sqlite3')).resolve()
    logs = database.parent / 'logs'
    logs.mkdir(parents=True, exist_ok=True)
    child = None
    with (logs / 'server.log').open('a', encoding='utf-8') as log:
        try:
            child = subprocess.Popen([sys.executable, str(ROOT/'server.py'), '--port', str(port)], cwd=ROOT, stdout=log, stderr=log)
            for _ in range(100):
                if child.poll() is not None:
                    parser.exit(1, 'The server could not start. Run `python manage.py check`; details are in data/logs/server.log.\n')
                if ready(port):
                    print(f'Airframe is ready: {address}\nKeep this window open. Press Ctrl+C to stop. Your data is saved automatically.', flush=True)
                    if not args.no_browser:
                        webbrowser.open(address)
                    child.wait()
                    return
                time.sleep(.1)
            parser.exit(1, 'The server did not become ready. See data/logs/server.log.\n')
        except KeyboardInterrupt:
            print('\nStopping Airframe. Your data is saved.')
        finally:
            if child and child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()


if __name__ == '__main__':
    def stop_signal(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop_signal)
    if hasattr(signal, 'SIGHUP'):
        signal.signal(signal.SIGHUP, stop_signal)
    main()
