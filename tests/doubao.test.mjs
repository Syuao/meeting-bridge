import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {gzipSync,gunzipSync} from 'node:zlib';
import {
  DOUBAO_ASR_MODEL,DOUBAO_WS_URL,DOUBAO_RESOURCE_ID,DOUBAO_CHUNK_BYTES,
  validateDoubaoConfig,readDoubaoConfig,saveDoubaoConfig,doubaoPublicConfig,
  buildDoubaoStartFrame,buildDoubaoAudioFrame,buildDoubaoFinishFrame,parseDoubaoFrame,
  DoubaoTranscript,DoubaoASR,safeDoubaoError,extractDoubaoSpeakerId,
} from '../host/doubao-asr.mjs';

const key='doubao-test-key';
const config={key,resourceId:DOUBAO_RESOURCE_ID,websocketUrl:DOUBAO_WS_URL,uid:'test-session'};
const responseFrame=(payload={},last=false)=>{
  const body=gzipSync(Buffer.from(JSON.stringify(payload)));
  const header=Buffer.from([0x11,0x90|(last?2:0),0x11,0]);
  const size=Buffer.alloc(4);size.writeUInt32BE(body.length);
  return Buffer.concat([header,size,body]);
};
const bodyOf=frame=>{
  const compression=frame[2]&0x0f;
  const sequence=(frame[1]&1)?4:0;
  const size=frame.readUInt32BE(4+sequence);
  const body=frame.subarray(8+sequence,8+sequence+size);
  return compression===1?gunzipSync(body):body;
};

test('Doubao config stays local, defaults to ASR 2.0 duration resource, and hides the key',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mb-doubao-'));
  try {
    assert.deepEqual(validateDoubaoConfig({key}),{key,resourceId:DOUBAO_RESOURCE_ID,websocketUrl:DOUBAO_WS_URL,uid:'meeting-bridge'});
    saveDoubaoConfig(root,{...config});
    assert.equal(fs.statSync(path.join(root,'doubao-asr.json')).mode&0o777,0o600);
    assert.equal(readDoubaoConfig(root).key,key);
    assert.equal(doubaoPublicConfig(root).configured,true);
    assert.equal(JSON.stringify(doubaoPublicConfig(root)).includes(key),false);
    assert.deepEqual(readDoubaoConfig(root+'-env',{DOUBAO_API_KEY:key,DOUBAO_UID:'env-user'}),{key,resourceId:DOUBAO_RESOURCE_ID,websocketUrl:DOUBAO_WS_URL,uid:'env-user'});
    assert.throws(()=>validateDoubaoConfig({key:'x\ny'}),/API Key/);
    assert.throws(()=>validateDoubaoConfig({key,resourceId:'volc.invalid'}),/Resource ID/);
    assert.throws(()=>validateDoubaoConfig({key,websocketUrl:'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream'}),/bigmodel_async/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('Doubao frames carry bilingual PCM request and gzip framed 200ms audio',()=>{
  const start=buildDoubaoStartFrame({uid:'u-1'});
  assert.deepEqual([...start.subarray(0,4)],[0x11,0x10,0x11,0]);
  const request=JSON.parse(bodyOf(start));
  assert.deepEqual(request.audio,{format:'pcm',codec:'raw',rate:16000,bits:16,channel:1});
  assert.equal(request.request.model_name,DOUBAO_ASR_MODEL);
  assert.equal(request.request.enable_nonstream,true);
  assert.equal(request.request.enable_speaker_info,true);
  assert.equal(request.request.show_utterances,true);
  assert.equal(request.request.ssd_version,'200');
  assert.deepEqual(request.user,{uid:'u-1'});
  const audio=buildDoubaoAudioFrame(Buffer.alloc(DOUBAO_CHUNK_BYTES,7),{sequence:5});
  assert.deepEqual([...audio.subarray(0,4)],[0x11,0x20,0x01,0]);
  assert.equal(bodyOf(audio).length,DOUBAO_CHUNK_BYTES);
  const finish=buildDoubaoFinishFrame({sequence:6});
  assert.equal(finish[1],0x22);assert.equal(bodyOf(finish).length,0);
  assert.throws(()=>buildDoubaoAudioFrame(Buffer.alloc(3)),/16-bit/);
});

test('Doubao response parser and transcript preserve interim revisions, finals, and stable speaker mapping',()=>{
  const frame=responseFrame({result:{utterances:[{text:'今天我们讨论 RAG',start_time:100,definite:false,additions:{speaker_id:'0'}}]}});
  const parsed=parseDoubaoFrame(frame);assert.equal(parsed.messageType,9);assert.equal(parsed.last,false);assert.equal(parsed.payloadMsg.result.utterances[0].text,'今天我们讨论 RAG');
  const tracker=new DoubaoTranscript('s1');
  const first=tracker.accept(parsed.payloadMsg.result.utterances[0],0,1);assert.equal(first.final,false);assert.equal(first.speakerId,'speaker-0');
  const revised=tracker.accept({text:'今天我们讨论一下 RAG 的 retrieval module。',start_time:100,definite:true,additions:{speaker_id:'0'}},0,2);assert.equal(revised.id,first.id);assert.equal(revised.final,true);assert.equal(revised.speakerId,'speaker-0');
  assert.equal(tracker.accept({text:'late partial',start_time:100,definite:false,additions:{speaker_id:'0'}},0),null);
  const unknown=tracker.accept({text:'I think 这个方案可以优化。',start_time:200,definite:true,additions:{}},0,3);assert.equal(unknown.speakerId,'Unknown');assert.equal(unknown.speakerRaw,'');
  assert.equal(tracker.accept({text:'I think 这个方案可以优化。',start_time:200,definite:true,additions:{}},0),null);
  const numeric=tracker.accept({text:'Speaker zero',start_time:300,definite:true,additions:{speaker_id:0}},0,4);assert.equal(numeric.speakerRaw,'0');assert.equal(numeric.speakerId,'speaker-0');
  const stringified=tracker.accept({text:'Speaker one',start_time:400,definite:true,additions:'{"speaker_id":"1"}'},0,5);assert.equal(stringified.speakerRaw,'1');assert.equal(stringified.speakerId,'speaker-1');
  assert.equal(extractDoubaoSpeakerId({text:'nested',speaker_info:{speaker_id:'2'}}),'2');
  assert.throws(()=>parseDoubaoFrame(Buffer.from([0x11,0x90,0x11])),/不完整/);
});

test('Doubao error frames expose only the numeric provider code',()=>{
  const message=Buffer.from('invalid request');const frame=Buffer.alloc(12+message.length);
  Buffer.from([0x11,0xf0,0x00,0]).copy(frame,0);frame.writeInt32BE(45000001,4);frame.writeUInt32BE(message.length,8);message.copy(frame,12);
  const parsed=parseDoubaoFrame(frame);assert.equal(parsed.messageType,15);assert.equal(parsed.code,45000001);assert.equal(parsed.rawPayload.toString(),'invalid request');
});

test('Doubao WebSocket sends framed audio and waits for a final response',async()=>{
  const sent=[],rows=[],errors=[];
  class FakeSocket extends EventEmitter {
    constructor(url,options){super();this.url=url;this.options=options;this.bufferedAmount=0;FakeSocket.instance=this;setImmediate(()=>{this.emit('upgrade',{headers:{'x-tt-logid':'test-log-id'}});this.emit('open');});}
    send(data,_options,callback){sent.push(Buffer.from(data));callback?.();const type=(data[1]>>4)&0x0f;if(type===1)setImmediate(()=>this.emit('message',responseFrame({result:{}})));if(type===2&&data[1]===0x22)setImmediate(()=>this.emit('message',responseFrame({result:{utterances:[{text:'最终结果',start_time:0,definite:true,additions:{speaker_id:'1'}}]}},true)));}
    close(){this.emit('close');}terminate(){this.emit('close');}
  }
  const client=new DoubaoASR(config,{WebSocketClass:FakeSocket,onSentence:(s)=>rows.push(s),onError:e=>errors.push(e)});
  await client.start();assert.equal(client.phase,'streaming');assert.equal(client.logId,'test-log-id');assert.equal(FakeSocket.instance.options.headers['X-Api-Key'],key);assert.equal(FakeSocket.instance.options.headers['X-Api-Resource-Id'],DOUBAO_RESOURCE_ID);assert.match(FakeSocket.instance.options.headers['X-Api-Request-Id'],/^[0-9a-f-]{36}$/);
  assert.equal(client.push(Buffer.alloc(DOUBAO_CHUNK_BYTES)),true);await client.finish();
  assert.equal(client.phase,'closed');assert.equal(errors.length,0);assert.equal(sent[0][1],0x10);assert.ok(sent.some(frame=>frame[1]===0x22));assert.equal(rows.at(-1).text,'最终结果');
});

test('Doubao errors are user-safe and never expose provider details',()=>{
  assert.match(safeDoubaoError('403 resource permission denied').message,/API Key|Resource ID/);
  assert.match(safeDoubaoError('429 quota').message,/额度|并发/);
  assert.match(safeDoubaoError('bad pcm sample rate').message,/音频格式/);
  assert.match(safeDoubaoError(45000002).message,/有效音频/);
  assert.match(safeDoubaoError(45000151).message,/音频格式/);
  assert.equal(safeDoubaoError('private-secret').message.includes('private-secret'),false);
});
