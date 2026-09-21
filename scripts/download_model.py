#!/usr/bin/env python3
"""Fetch the optional Whisper Base model, verifying its pinned SHA-256."""
import hashlib
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
target = root / 'models/ggml-base.bin'
url = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin'
expected = '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'

def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()

if target.exists() and digest(target) == expected:
    print('Whisper Base already downloaded and verified.')
else:
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='download-', dir=target.parent) as temporary:
        download = Path(temporary) / 'model.bin'
        subprocess.run(['curl', '--fail', '--location', '--retry', '3', '--connect-timeout', '15',
                        '--max-time', '1800', '--output', str(download), url], check=True)
        if digest(download) != expected:
            raise SystemExit('Model checksum mismatch; the downloaded file was not installed.')
        download.replace(target)
    print('Whisper Base downloaded and verified.')
