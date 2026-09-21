#!/usr/bin/env python3
"""Build public release assets from an explicit allowlist, never from an installed runtime."""
from pathlib import Path
import hashlib
import json
import platform
import re
import shutil
import subprocess
import tarfile
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
NODE_VERSION = 'v22.23.2'
NODE_SHA256 = '61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6'
if platform.system() != 'Darwin' or platform.machine() != 'arm64':
    raise SystemExit('This release target is macOS Apple Silicon only.')
version = json.loads((ROOT / 'package.json').read_text())['version']
if json.loads((ROOT / 'extension/manifest.json').read_text())['version'] != version:
    raise SystemExit('Extension and package versions must match.')
archive_name = f'node-{NODE_VERSION}-darwin-arm64.tar.gz'
cache = ROOT / '.build/release-downloads'
cache.mkdir(parents=True, exist_ok=True)
archive = cache / archive_name
if not archive.exists():
    partial = archive.with_suffix('.download')
    subprocess.run(['curl', '--fail', '--location', '--retry', '2',
                    f'https://nodejs.org/dist/{NODE_VERSION}/{archive_name}', '-o', str(partial)], check=True)
    partial.replace(archive)
if hashlib.sha256(archive.read_bytes()).hexdigest() != NODE_SHA256:
    raise SystemExit('Node archive checksum mismatch; remove the cached archive and retry.')
capture_temp = tempfile.TemporaryDirectory(prefix='meetingbridge-release-capture-')
app = Path(capture_temp.name) / 'Meeting Bridge Audio.app'
subprocess.run(['python3', str(ROOT / 'scripts/build_capture.py'), '--output', str(app)], check=True)
dist = ROOT / 'dist'
dist.mkdir(exist_ok=True)
name = f'MeetingBridge-{version}-macOS-arm64'

def copy_tree(source, target, allow):
    target.mkdir(parents=True, exist_ok=True)
    for item in sorted(source.rglob('*')):
        if item.is_symlink():
            raise RuntimeError(f'Unexpected symlink: {item.relative_to(ROOT)}')
        if item.is_file() and allow(item):
            dest = target / item.relative_to(source)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(item, dest)
            dest.chmod(item.stat().st_mode & 0o777)

def zip_tree(source, target, prefix=''):
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as out:
        for item in sorted(source.rglob('*')):
            if item.is_file():
                out.write(item, prefix + item.relative_to(source).as_posix())

with tempfile.TemporaryDirectory(prefix='meetingbridge-release-') as temporary:
    bundle = Path(temporary) / name
    bundle.mkdir()
    copy_tree(ROOT / 'extension', bundle / 'extension', lambda p: p.suffix in {'.js', '.html', '.css', '.json', '.png'})
    copy_tree(ROOT / 'host', bundle / 'host', lambda p: p.suffix == '.mjs')
    copy_tree(ROOT / 'node_modules/ws', bundle / 'node_modules/ws', lambda p: p.name in {'LICENSE', 'package.json', 'index.js', 'browser.js', 'wrapper.mjs'} or 'lib' in p.relative_to(ROOT / 'node_modules/ws').parts)
    copy_tree(app, bundle / app.name, lambda p: True)
    (bundle / 'installer').mkdir()
    shutil.copyfile(ROOT / 'distribution/install.mjs', bundle / 'installer/install.mjs')
    shutil.copyfile(ROOT / 'distribution/Install.command', bundle / 'Install.command')
    (bundle / 'Install.command').chmod(0o755)
    for source, target in [('distribution/README.md', 'README.md'), ('LICENSE', 'LICENSE'), ('THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md')]:
        shutil.copyfile(ROOT / source, bundle / target)
    runtime = bundle / 'node-runtime'
    runtime.mkdir()
    with tarfile.open(archive, 'r:gz') as tar:
        for suffix, dest in [('bin/node', 'node'), ('LICENSE', 'LICENSE')]:
            member = tar.getmember(f'node-{NODE_VERSION}-darwin-arm64/{suffix}')
            if not member.isfile():
                raise RuntimeError('Unexpected Node archive entry')
            (runtime / dest).write_bytes(tar.extractfile(member).read())
    (runtime / 'node').chmod(0o755)
    assert subprocess.check_output([str(runtime / 'node'), '--version'], text=True).strip() == NODE_VERSION
    # Finder/FileProvider may add metadata while the bundle is staged in Documents.
    # Clean only this generated build copy, never an installed or downloaded app.
    subprocess.run(['/usr/bin/xattr', '-cr', str(bundle / app.name)], check=True)
    subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(bundle / app.name)], check=True)
    metadata = {'version': version, 'platform': 'darwin', 'arch': 'arm64', 'minimumMacOS': '13.0',
                'node': NODE_VERSION, 'nodeArchiveSHA256': NODE_SHA256,
                'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
                'captureSigning': 'ad-hoc, not notarized', 'includesAPIKeys': False, 'includesLocalWhisper': False}
    (bundle / 'build-metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')
    patterns = [rb'sk-[A-Za-z0-9_-]{20,}', rb'gh[pousr]_[A-Za-z0-9]{30,}', rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----', rb'/Users/[A-Za-z0-9._-]+/']
    for item in bundle.rglob('*'):
        if not item.is_file():
            continue
        # The official upstream Node executable has its own build paths; verify it by checksum.
        if item == runtime / 'node':
            continue
        data = item.read_bytes()
        if any(re.search(pattern, data) for pattern in patterns):
            raise SystemExit(f'Release scan failed: {item.relative_to(bundle)}')
    mac_zip = dist / f'{name}.zip'
    ext_zip = dist / f'MeetingBridge-{version}-extension.zip'
    zip_tree(bundle, mac_zip, name + '/')
    shutil.copyfile(ROOT / 'LICENSE', bundle / 'extension/LICENSE')
    zip_tree(bundle / 'extension', ext_zip)
checksums = ''.join(hashlib.sha256(item.read_bytes()).hexdigest() + '  ' + item.name + '\n' for item in [mac_zip, ext_zip])
(dist / 'SHA256SUMS.txt').write_text(checksums)
for item in [mac_zip, ext_zip, dist / 'SHA256SUMS.txt']:
    print(f'{item.name}: {item.stat().st_size:,} bytes')
print('Release allowlist and secret/path checks passed.')
capture_temp.cleanup()
