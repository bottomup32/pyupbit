#!/usr/bin/env python3
"""Build a verifiable source package without shipping a user's database."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

ROOT=Path(__file__).resolve().parent
OUTPUT=ROOT.parent/'hvac-crm.zip'
EXCLUDED={'data','__pycache__','.git','.env','.env.local','.env.production'}


def main():
    files=sorted(p for p in ROOT.rglob('*') if p.is_file() and not any(part in EXCLUDED or part.startswith('.env.') for part in p.relative_to(ROOT).parts) and p.name!='RELEASE.json')
    manifest={'product':'Airframe','version':'0.2.0','built_at_utc':datetime.now(timezone.utc).isoformat(),
        'runtime':'Python 3.12+; standard library only','workspace_data_included':False,
        'checksums':{p.relative_to(ROOT).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in files}}
    (ROOT/'RELEASE.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
    with ZipFile(OUTPUT,'w',ZIP_DEFLATED) as archive:
        for p in [*files,ROOT/'RELEASE.json']:archive.write(p,Path('hvac-crm')/p.relative_to(ROOT))
    with ZipFile(OUTPUT) as archive:
        assert archive.testzip() is None
        assert not any(n.startswith('hvac-crm/data/') for n in archive.namelist())
        for name,digest in manifest['checksums'].items():
            assert hashlib.sha256(archive.read('hvac-crm/'+name)).hexdigest()==digest
    digest=hashlib.sha256(OUTPUT.read_bytes()).hexdigest()
    OUTPUT.with_suffix('.zip.sha256').write_text(digest+'  '+OUTPUT.name+'\n',encoding='ascii')
    print(f'Verified {len(files)} source/artifact files. No workspace data included.\n{OUTPUT}\nSHA-256: {digest}')


if __name__=='__main__':main()
