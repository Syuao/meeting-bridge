#!/usr/bin/env python3
"""Build the macOS helper without modifying the installed, authorized copy."""
import argparse
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=root / 'Meeting Bridge Audio.app')
args = parser.parse_args()
if platform.system() != 'Darwin':
    raise SystemExit('The capture helper requires macOS and Xcode Command Line Tools.')
output = args.output.resolve()
installed = Path.home() / 'Library/Application Support/MeetingBridge/Meeting Bridge Audio.app'
if output == installed.resolve():
    raise SystemExit('Build into the source directory, then use install.py to preserve the installed identity.')
output.parent.mkdir(parents=True, exist_ok=True)
cache = root / '.build/swift-cache'
cache.mkdir(parents=True, exist_ok=True)
# Build/sign outside cloud-synced Documents directories: file providers can add
# Finder metadata between xattr cleanup and signing, invalidating the bundle.
with tempfile.TemporaryDirectory(prefix='meetingbridge-build-') as temporary:
    app = Path(temporary) / 'Meeting Bridge Audio.app'
    binary = app / 'Contents/MacOS/MeetingBridgeAudio'
    binary.parent.mkdir(parents=True)
    shutil.copy2(root / 'native/Info.plist', app / 'Contents/Info.plist')
    subprocess.run(['xcrun', 'swiftc', '-O', '-swift-version', '5',
                    '-target', f'{platform.machine()}-apple-macos13.0',
                    '-module-cache-path', str(cache), str(root / 'native/Capture.swift'),
                    '-o', str(binary), '-framework', 'AppKit', '-framework', 'ScreenCaptureKit',
                    '-framework', 'AVFoundation', '-framework', 'CoreMedia', '-framework', 'Vision'], check=True)
    subprocess.run(['/usr/bin/xattr', '-cr', str(app)], check=True)
    subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', '--identifier',
                    'local.meetingbridge.audio', str(app)], check=True)
    subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)], check=True)
    shutil.copytree(app, output, dirs_exist_ok=True)
print(f'Built {output}. The installed helper and recording permissions were not changed.')
