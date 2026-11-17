import test from 'node:test';
import assert from 'node:assert/strict';
import {CHUNK_BYTES,PCM_RATE,parseArgs,ffmpegArgs,rmsLevel} from '../host/windows-capture.mjs';

test('Windows capture emits 16 kHz mono WASAPI loopback chunks',()=>{
  assert.equal(PCM_RATE,16000);
  assert.equal(CHUNK_BYTES,6400);
  assert.deepEqual(parseArgs(['--session','C:/tmp/a','--stream-pcm','1','--background']),{session:'C:/tmp/a','stream-pcm':'1',background:true});
  assert.deepEqual(ffmpegArgs().slice(0,8),['-hide_banner','-loglevel','error','-f','wasapi','-loopback','1','-i']);
  assert.equal(ffmpegArgs().at(-1),'-');
  assert.ok(rmsLevel(Buffer.alloc(6400))<0.001);
  const loud=Buffer.alloc(6400);for(let i=0;i<loud.length;i+=2)loud.writeInt16LE(16384,i);assert.ok(rmsLevel(loud)>0.4);
});
