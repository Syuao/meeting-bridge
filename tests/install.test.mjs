import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('reinstall preserves capture signature and file identity; real bundle changes still install', {skip:process.platform!=='darwin'},()=>{
  const script=String.raw`
from pathlib import Path
import tempfile,shutil,plistlib,hashlib
from capture_install import install_capture,payload_digest
with tempfile.TemporaryDirectory(prefix='meetingbridge-install-test-') as temporary:
    source=Path(temporary)/'source.app'
    target=Path(temporary)/'installed.app'
    shutil.copytree(Path('Meeting Bridge Audio.app'),source)
    assert install_capture(source,target) is True
    binary=target/'Contents/MacOS/MeetingBridgeAudio'
    def snapshot():
        return (hashlib.sha256(binary.read_bytes()).hexdigest(),binary.stat().st_ino,binary.stat().st_mtime_ns)
    before=snapshot()
    assert payload_digest(source)==payload_digest(target)
    assert install_capture(source,target) is False
    assert snapshot()==before
    info=source/'Contents/Info.plist'
    settings=plistlib.loads(info.read_bytes())
    settings['CFBundleVersion']='fixture-only'
    info.write_bytes(plistlib.dumps(settings))
    assert payload_digest(source)!=payload_digest(target)
    assert install_capture(source,target) is True
    assert snapshot()[0]!=before[0]
    assert plistlib.loads((target/'Contents/Info.plist').read_bytes())['CFBundleVersion']=='fixture-only'
    assert install_capture(source,target) is False
`;
  const result=spawnSync('python3',['-c',script],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||result.stdout);
});
