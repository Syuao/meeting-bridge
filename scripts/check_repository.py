#!/usr/bin/env python3
"""Check the exact Git index for common secrets and accidentally staged local files."""
from pathlib import Path
import re
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
paths = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
rules = {
    'API key': rb'sk-[A-Za-z0-9_-]{20,}',
    'GitHub token': rb'(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})',
    'private key': rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
    'personal absolute path': rb'/Users/[A-Za-z0-9._-]+/',
}
errors = []
total = 0
for name in filter(None, paths):
    data = subprocess.check_output(['git', 'show', ':' + name], cwd=root)
    total += len(data)
    if len(data) > 10 * 1024 * 1024:
        errors.append((name, 'large generated file'))
    if '\0' in data.decode('utf-8', errors='replace'):
        errors.append((name, 'binary file'))
    if any(part in {'node_modules', 'models', '.env', '.DS_Store'} for part in Path(name).parts):
        errors.append((name, 'local dependency or config'))
    for label, pattern in rules.items():
        if re.search(pattern, data):
            errors.append((name, label))
if errors:
    for name, label in errors:
        print(f'BLOCKED: {name}: {label}')
    sys.exit(1)
print(f'Checked {len(list(filter(None, paths)))} staged files ({total:,} bytes); no known secret patterns or generated binaries found.')
print('Pattern checks are a supplement to reviewing the staged diff, not a guarantee of no sensitive data.')
