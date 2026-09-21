"""Keep the authorized capture bundle intact when only the bridge/UI changes."""
from pathlib import Path
import hashlib
import shutil
import struct
import subprocess
import tempfile


def executable_payload(binary: Path) -> bytes:
    # Work on a disposable copy. Never strip or sign the installed executable here.
    with tempfile.TemporaryDirectory(prefix='meetingbridge-compare-') as temporary:
        copy = Path(temporary) / binary.name
        shutil.copy2(binary, copy)
        subprocess.run(['/usr/bin/codesign', '--remove-signature', str(copy)],
                       check=True, capture_output=True)
        data = bytearray(copy.read_bytes())
    if data[:4] != b'\xcf\xfa\xed\xfe':
        raise ValueError('Capture helper must be a thin 64-bit Mach-O executable')
    count = struct.unpack_from('<I', data, 16)[0]
    offset = 32
    for _ in range(count):
        command, size = struct.unpack_from('<II', data, offset)
        if size < 8 or offset + size > len(data):
            raise ValueError('Invalid Mach-O load command')
        if command == 0x19 and data[offset + 8:offset + 24].rstrip(b'\0') == b'__LINKEDIT':
            # codesign --remove-signature leaves the former signature's VM padding.
            # All actual link-edit bytes, file size and every other command stay hashed.
            struct.pack_into('<Q', data, offset + 32, 0)
        offset += size
    return bytes(data)


def payload_digest(app: Path) -> str:
    digest = hashlib.sha256()
    for item in sorted(app.rglob('*')):
        relative = item.relative_to(app)
        if not item.is_file() or '_CodeSignature' in relative.parts:
            continue
        data = executable_payload(item) if relative.parts[:2] == ('Contents', 'MacOS') else item.read_bytes()
        digest.update(str(relative).encode() + b'\0')
        digest.update(len(data).to_bytes(8, 'big'))
        digest.update(data)
    return digest.hexdigest()


def install_capture(source: Path, target: Path) -> bool:
    if target.exists() and payload_digest(source) == payload_digest(target):
        valid = subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(target)],
                               capture_output=True).returncode == 0
        if valid:
            return False
    shutil.copytree(source, target, dirs_exist_ok=True)
    subprocess.run(['/usr/bin/xattr', '-cr', str(target)], check=True)
    subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', '--identifier',
                    'local.meetingbridge.audio', str(target)], check=True)
    subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(target)], check=True)
    return True
