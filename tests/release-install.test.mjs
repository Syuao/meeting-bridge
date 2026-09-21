import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {installBundle} from '../distribution/install.mjs';

test('release install preserves credentials and capture identity, starts native protocol, rejects damaged helper', {skip:process.platform!=='darwin'||process.arch!=='arm64'},()=>{
  const root=fileURLToPath(new URL('..',import.meta.url));
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"meetingbridge-release's-"));
  try{
    const bundle=path.join(temporary,'bundle'),runtime=path.join(temporary,'installed runtime'),nativeHosts=path.join(temporary,'native hosts');
    fs.mkdirSync(bundle);
    for(const folder of ['host','extension','node_modules/ws','Meeting Bridge Audio.app'])fs.cpSync(path.join(root,folder),path.join(bundle,folder),{recursive:true});
    fs.mkdirSync(path.join(bundle,'node-runtime'));fs.copyFileSync(process.execPath,path.join(bundle,'node-runtime/node'));
    execFileSync('/usr/bin/xattr',['-cr',path.join(bundle,'Meeting Bridge Audio.app')]);
    const first=installBundle({bundle,runtime,nativeHosts});
    assert.equal(first.preserveCapture,false);
    const manifest=JSON.parse(fs.readFileSync(path.join(nativeHosts,'local.meetingbridge.json'),'utf8'));
    assert.equal(manifest.path,path.join(runtime,'host/launch-host'));
    assert.deepEqual(manifest.allowed_origins,['chrome-extension://nikdjjonbnjblpeopjgddiclfdddlmcm/']);
    const body=Buffer.from(JSON.stringify({type:'ping'})),header=Buffer.alloc(4);header.writeUInt32LE(body.length);
    const launched=spawnSync(manifest.path,[],{input:Buffer.concat([header,body]),timeout:5000});
    assert.equal(launched.status,0,launched.stderr?.toString());
    const messages=[];let offset=0;
    while(offset<launched.stdout.length){const length=launched.stdout.readUInt32LE(offset);offset+=4;messages.push(JSON.parse(launched.stdout.subarray(offset,offset+length)));offset+=length;}
    assert.ok(messages.some(message=>message.type==='hello'));
    assert.ok(messages.some(message=>message.type==='pong'));
    const credential=path.join(runtime,'aliyun-asr.json');fs.writeFileSync(credential,'TEST CONFIG MUST SURVIVE',{mode:0o600});
    const binary=path.join(runtime,'Meeting Bridge Audio.app/Contents/MacOS/MeetingBridgeAudio');
    const before=fs.statSync(binary),bytes=fs.readFileSync(binary);
    const second=installBundle({bundle,runtime,nativeHosts});
    assert.equal(second.preserveCapture,true);
    assert.equal(fs.statSync(binary).ino,before.ino);
    assert.deepEqual(fs.readFileSync(binary),bytes);
    assert.equal(fs.readFileSync(credential,'utf8'),'TEST CONFIG MUST SURVIVE');
    assert.equal(fs.statSync(credential).mode&0o777,0o600);
    fs.appendFileSync(path.join(bundle,'Meeting Bridge Audio.app/Contents/Info.plist'),'damaged');
    assert.throws(()=>installBundle({bundle,runtime,nativeHosts}));
    assert.equal(fs.statSync(binary).ino,before.ino);
    assert.equal(fs.readFileSync(credential,'utf8'),'TEST CONFIG MUST SURVIVE');
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});
