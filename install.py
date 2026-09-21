#!/usr/bin/env python3
"""Register a per-user Chrome native host. Does not modify Natively or ChatGPT."""
from pathlib import Path
import argparse, base64, hashlib, json, os, shlex, shutil, subprocess
from capture_install import install_capture

root = Path(__file__).resolve().parent
if not (root/'Meeting Bridge Audio.app/Contents/MacOS/MeetingBridgeAudio').is_file():
    raise SystemExit('请先运行 python3 scripts/build_capture.py 构建声音采集程序。')
if not (root/'node_modules/ws/package.json').is_file():
    raise SystemExit('请先运行 npm ci --ignore-scripts 安装本机桥接依赖。')
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--runtime-dir', type=Path, default=Path.home() / 'Library/Application Support/MeetingBridge')
parser.add_argument('--native-host-dir', type=Path, default=Path.home() / 'Library/Application Support/Google/Chrome/NativeMessagingHosts')
args = parser.parse_args()
runtime = args.runtime_dir.expanduser().resolve()
runtime.mkdir(parents=True, exist_ok=True)
manifest_path = root / 'extension/manifest.json'
manifest = json.loads(manifest_path.read_text())
if not manifest.get('key'):
    private = subprocess.check_output(['openssl', 'genrsa', '2048'], stderr=subprocess.DEVNULL)
    public = subprocess.check_output(['openssl', 'rsa', '-pubout', '-outform', 'DER'], input=private, stderr=subprocess.DEVNULL)
    manifest['key'] = base64.b64encode(public).decode()
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n')
raw = base64.b64decode(manifest['key'])
extension_id = ''.join(chr(ord('a')+int(n,16)) for n in hashlib.sha256(raw).hexdigest()[:32])
node = shutil.which('node') or '/opt/homebrew/bin/node'
if not Path(node).exists(): raise SystemExit('Node.js is missing')
for folder in ['host','node_modules']:
    shutil.copytree(root/folder, runtime/folder, dirs_exist_ok=True)
for folder in ['bin','models']:
    if (root/folder).is_dir():
        shutil.copytree(root/folder, runtime/folder, dirs_exist_ok=True)
if install_capture(root/'Meeting Bridge Audio.app', runtime/'Meeting Bridge Audio.app'):
    print('声音采集程序已更新；若系统仍保留旧授权，需在录屏与系统录音中移除旧条目后添加当前程序。')
else:
    print('声音采集程序未改变，已保留现有签名和授权身份。')
host = runtime / 'host/launch-host'
host.write_text('#!/bin/sh\nexec '+shlex.quote(node)+' '+shlex.quote(str(runtime/'host/bridge.mjs'))+' "$@"\n')
host.chmod(0o755)
target = args.native_host_dir.expanduser().resolve() / 'local.meetingbridge.json'
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps({'name':'local.meetingbridge','description':'Local meeting audio transcription','path':str(host),'type':'stdio','allowed_origins':['chrome-extension://'+extension_id+'/']},indent=2)+'\n')
target.chmod(0o600)
(root/'extension-id.txt').write_text(extension_id+'\n')
(root/'打开提问面板.command').write_text('#!/bin/zsh\n/usr/bin/open -a "Google Chrome" '+shlex.quote('chrome-extension://'+extension_id+'/panel.html')+'\n')
(root/'打开提问面板.command').chmod(0o755)
print('本机桥接已安装。扩展 ID：'+extension_id)
print('请在 chrome://extensions 开启开发者模式，加载以下目录：')
print(root/'extension')
