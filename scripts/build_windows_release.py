#!/usr/bin/env python3
"""Build a Windows x64 + Edge package from the cross-platform source allowlist."""
from pathlib import Path
import json, shutil, tempfile, zipfile, hashlib, re

ROOT=Path(__file__).resolve().parents[1]
version=json.loads((ROOT/'package.json').read_text())['version']
name=f'MeetingBridge-{version}-Windows-Edge'
dist=ROOT/'dist'; dist.mkdir(exist_ok=True)

def copy_tree(source: Path, target: Path, predicate):
    target.mkdir(parents=True, exist_ok=True)
    for item in sorted(source.rglob('*')):
        if item.is_symlink() or not item.is_file() or not predicate(item): continue
        dest=target/item.relative_to(source); dest.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(item,dest); dest.chmod(item.stat().st_mode & 0o777)

def zip_tree(source: Path, target: Path):
    with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as out:
        for item in sorted(source.rglob('*')):
            if item.is_file(): out.write(item,name+'/'+item.relative_to(source).as_posix())

with tempfile.TemporaryDirectory(prefix='meetingbridge-windows-') as td:
    bundle=Path(td)/name; bundle.mkdir()
    copy_tree(ROOT/'extension',bundle/'extension',lambda p:p.suffix in {'.js','.html','.css','.json','.png'})
    copy_tree(ROOT/'host',bundle/'host',lambda p:p.suffix=='.mjs')
    copy_tree(ROOT/'node_modules/ws',bundle/'node_modules/ws',lambda p:p.name in {'LICENSE','package.json','index.js','browser.js','wrapper.mjs'} or 'lib' in p.relative_to(ROOT/'node_modules/ws').parts)
    shutil.copy2(ROOT/'distribution/windows/install.ps1',bundle/'install.ps1')
    shutil.copy2(ROOT/'distribution/windows/HostLauncher.cs',bundle/'HostLauncher.cs')
    shutil.copy2(ROOT/'distribution/windows/README.md',bundle/'README.md')
    for item in ['LICENSE','THIRD_PARTY_NOTICES.md']:
        shutil.copy2(ROOT/item,bundle/item)
    metadata={'version':version,'platform':'windows','arch':'x64','browser':'Microsoft Edge','requiresNode':'>=22','requires':'FFmpeg with WASAPI input','sourceCommit':__import__('subprocess').check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'capture':'WASAPI loopback via ffmpeg; default system output mix; not app-filtered','testedOn':'not available on macOS build host'}
    (bundle/'build-metadata.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2)+'\n')
    for item in bundle.rglob('*'):
        if not item.is_file(): continue
        data=item.read_bytes()
        if any(re.search(p,data) for p in [rb'sk-[A-Za-z0-9_-]{20,}',rb'gh[pousr]_[A-Za-z0-9]{30,}',rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----']):
            raise SystemExit(f'secret scan failed: {item.relative_to(bundle)}')
    archive=dist/f'{name}.zip'; zip_tree(bundle,archive)
    print(f'{archive}: {archive.stat().st_size:,} bytes')
    print(hashlib.sha256(archive.read_bytes()).hexdigest()+'  '+archive.name)
