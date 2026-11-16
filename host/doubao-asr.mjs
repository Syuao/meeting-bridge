import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import WebSocket from 'ws';

/** Doubao Streaming ASR 2.0 optimized duplex endpoint. */
export const DOUBAO_ASR_MODEL='bigmodel';
export const DOUBAO_WS_URL='wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
export const DOUBAO_RESOURCE_ID='volc.seedasr.sauc.duration';
export const DOUBAO_SAMPLE_RATE=16000;
export const DOUBAO_CHUNK_MS=200;
export const DOUBAO_CHUNK_BYTES=DOUBAO_SAMPLE_RATE*DOUBAO_CHUNK_MS/1000*2;

const configFile=root=>path.join(root,'doubao-asr.json');
const resourcePattern=/^volc\.(?:seedasr|bigasr)\.sauc\.(?:duration|concurrent)$/;
const urlPattern=/^wss:\/\/openspeech\.bytedance\.com\/api\/v3\/sauc\/bigmodel_async$/;

export function validateDoubaoConfig(input={}) {
  const key=String(input.key||'').trim();
  if(!key||key.length>512||/[\r\n]/.test(key))throw new Error('请输入火山引擎豆包 API Key。');
  const resourceId=String(input.resourceId||DOUBAO_RESOURCE_ID).trim();
  if(!resourcePattern.test(resourceId))throw new Error('豆包 Resource ID 无效，请使用 volc.seedasr.sauc.duration 或 concurrent。');
  const websocketUrl=String(input.websocketUrl||DOUBAO_WS_URL).trim();
  if(!urlPattern.test(websocketUrl))throw new Error('豆包 WebSocket 地址必须使用 bigmodel_async。');
  const uid=String(input.uid||'meeting-bridge').trim().slice(0,128)||'meeting-bridge';
  return {key,resourceId,websocketUrl,uid};
}

export function readDoubaoConfig(root,env=process.env) {
  let parsed;
  try { parsed=JSON.parse(fs.readFileSync(configFile(root),'utf8')); } catch {}
  const source=parsed||{
    key:env.DOUBAO_API_KEY||env.VOLCENGINE_ASR_ACCESS_KEY||env.VOLC_ASR_ACCESS_KEY,
    resourceId:env.DOUBAO_RESOURCE_ID||env.VOLCENGINE_ASR_RESOURCE_ID||env.VOLC_ASR_RESOURCE_ID,
    websocketUrl:env.DOUBAO_WS_URL||env.VOLCENGINE_ASR_WS_URL,
    uid:env.DOUBAO_UID||env.VOLCENGINE_ASR_UID,
  };
  return validateDoubaoConfig(source);
}

export function saveDoubaoConfig(root,input) {
  const config=validateDoubaoConfig({...input,key:String(input.key||'').trim()});
  const file=configFile(root);fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify(config),{mode:0o600});fs.chmodSync(file,0o600);
  return doubaoPublicConfig(root);
}

export function doubaoPublicConfig(root,env=process.env) {
  try { const config=readDoubaoConfig(root,env);return {configured:true,resourceId:config.resourceId,model:DOUBAO_ASR_MODEL}; }
  catch { return {configured:false,resourceId:DOUBAO_RESOURCE_ID,model:DOUBAO_ASR_MODEL}; }
}

const MESSAGE={FULL_REQUEST:1,AUDIO_ONLY:2,FULL_RESPONSE:9,ERROR_RESPONSE:15};
const FLAG={NONE:0,POSITIVE:1,NEGATIVE:2,NEGATIVE_WITH_SEQUENCE:3};
const SERIALIZATION={NONE:0,JSON:1};
const COMPRESSION={NONE:0,GZIP:1};
function header(type,flags,serialization,compression) {
  return Buffer.from([(1<<4)|1,(type<<4)|flags,(serialization<<4)|compression,0]);
}
function frame(type,flags,serialization,compression,sequence,payload) {
  const body=Buffer.isBuffer(payload)?payload:Buffer.from(JSON.stringify(payload));
  const compressed=compression===COMPRESSION.GZIP?gzipSync(body):body;
  const sequencePart=(flags&1)?Buffer.alloc(4):Buffer.alloc(0);
  if(sequencePart.length)sequencePart.writeInt32BE(sequence,0);
  const size=Buffer.alloc(4);size.writeUInt32BE(compressed.length,0);
  return Buffer.concat([header(type,flags,serialization,compression),sequencePart,size,compressed]);
}

export function buildDoubaoStartFrame({uid='meeting-bridge',request={}}={}) {
  // SAUC V3 uses no sequence extension for client full/audio requests. The
  // server adds sequence numbers to full responses; keeping client frames at
  // the documented four-byte header is required by bigmodel_async.
  return frame(MESSAGE.FULL_REQUEST,FLAG.NONE,SERIALIZATION.JSON,COMPRESSION.GZIP,0,{user:{uid:String(uid).slice(0,128)},audio:{format:'pcm',codec:'raw',rate:16000,bits:16,channel:1},request:{model_name:DOUBAO_ASR_MODEL,enable_nonstream:true,enable_speaker_info:true,show_utterances:true,ssd_version:'200',enable_itn:true,enable_punc:true,enable_ddc:false,end_window_size:800,result_type:'single',...request}});
}

export function buildDoubaoAudioFrame(audio,{sequence=2,last=false}={}) {
  if(!Buffer.isBuffer(audio)||audio.length%2)throw new Error('豆包音频必须是 16-bit PCM。');
  // Audio payloads are raw PCM wrapped in the protocol's gzip compression;
  // no sequence field is sent. The final packet uses the no-sequence final
  // flag documented for the async endpoint.
  return frame(MESSAGE.AUDIO_ONLY,last?FLAG.NEGATIVE:FLAG.NONE,SERIALIZATION.NONE,COMPRESSION.GZIP,0,audio);
}

export function buildDoubaoFinishFrame({sequence=2}={}) { return buildDoubaoAudioFrame(Buffer.alloc(0),{sequence,last:true}); }

export function parseDoubaoFrame(data) {
  const buf=Buffer.isBuffer(data)?data:Buffer.from(data||[]);
  if(buf.length<8)throw new Error('豆包响应帧不完整。');
  const headerSize=(buf[0]&0x0f)||1,type=(buf[1]>>4)&0x0f,flags=buf[1]&0x0f,serialization=(buf[2]>>4)&0x0f,compression=buf[2]&0x0f;
  let offset=headerSize*4,sequence;
  if(flags&1){if(buf.length<offset+4)throw new Error('豆包响应序号缺失。');sequence=buf.readInt32BE(offset);offset+=4;}
  const last=!!(flags&2);let event;
  if(flags&4){if(buf.length<offset+4)throw new Error('豆包响应事件缺失。');event=buf.readInt32BE(offset);offset+=4;}
  let code=0,payloadSize=0;
  if(type===MESSAGE.ERROR_RESPONSE){if(buf.length<offset+8)throw new Error('豆包错误响应不完整。');code=buf.readUInt32BE(offset);payloadSize=buf.readUInt32BE(offset+4);offset+=8;}
  else {if(buf.length<offset+4)throw new Error('豆包响应长度缺失。');payloadSize=buf.readUInt32BE(offset);offset+=4;}
  if(payloadSize>buf.length-offset)throw new Error('豆包响应长度超出数据帧。');
  let payload=buf.subarray(offset,offset+payloadSize);
  if(compression===COMPRESSION.GZIP&&payload.length)payload=gunzipSync(payload);
  let payloadMsg=null;if(serialization===SERIALIZATION.JSON&&payload.length){try{payloadMsg=JSON.parse(payload.toString('utf8'));}catch{throw new Error('豆包响应 JSON 无法解析。');}}
  return {messageType:type,flags,serialization,compression,sequence,last,event,code,payloadSize,payloadMsg,rawPayload:payload};
}

export function safeDoubaoError(code) {
  const value=String(code||'').toLowerCase();
  if(/401|403|auth|api.?key|resource|permission|grant/.test(value))return new Error('豆包 API Key 无效，或未开通当前 Resource ID，请检查火山引擎控制台。');
  if(value==='45000001'||/invalid.?request|parameter/.test(value))return new Error('豆包请求参数无效，请检查 ASR 配置后重试。');
  if(value==='45000002'||/empty.?audio/.test(value))return new Error('豆包没有收到有效音频，请确认系统声音采集已开启。');
  if(value==='45000081'||/packet.?wait|timeout/.test(value))return new Error('豆包等待音频超时，请检查网络或重新开始监听。');
  if(value==='45000151'||/audio|format|pcm|sample/.test(value))return new Error('豆包不接受当前音频格式，请确认是 16kHz、16-bit、单声道 PCM。');
  if(value==='55000031'||/429|quota|limit|thrott|busy/.test(value))return new Error('豆包实时转写请求受限，请检查并发或额度后重试。');
  return new Error('豆包实时转写连接中断或服务返回错误，请检查网络和火山引擎配置。');
}

function utteranceKey(utterance,index) {
  if(Number.isFinite(utterance?.start_time))return `time-${utterance.start_time}`;
  if(Number.isFinite(utterance?.begin_time))return `time-${utterance.begin_time}`;
  return `index-${index}`;
}

export class DoubaoTranscript {
  constructor(sessionID=randomUUID()){this.sessionID=sessionID;this.rows=new Map();this.speakers=new Map();}
  speaker(raw) {
    if(raw==null||String(raw).trim()==='')return 'Unknown';
    const value=String(raw);
    if(!this.speakers.has(value))this.speakers.set(value,`speaker-${this.speakers.size}`);
    return this.speakers.get(value);
  }
  accept(utterance,index=0,at=Date.now(),isLast=false) {
    if(!utterance||typeof utterance.text!=='string'||!utterance.text.trim())return null;
    const key=utteranceKey(utterance,index),id=`doubao-${this.sessionID}-${key}`,old=this.rows.get(id),text=utterance.text.trim(),final=utterance.definite===true||isLast;
    if(old?.final||(old?.text===text&&old.final===final&&old.speakerRaw===String(utterance.additions?.speaker_id??utterance.additions?.speaker??utterance.speaker_id??'')))return null;
    const raw=utterance.additions?.speaker_id??utterance.additions?.speaker??utterance.speaker_id??'';
    const row={id,piece:id,text,final,source:'doubao',model:DOUBAO_ASR_MODEL,at:old?.at||at,beginTime:utterance.start_time??utterance.begin_time,endTime:utterance.end_time,speakerId:this.speaker(raw),speakerRaw:String(raw||'')};
    this.rows.set(id,row);while(this.rows.size>12)this.rows.delete(this.rows.keys().next().value);return row;
  }
  recent(){return [...this.rows.values()].slice(-8);}
}

export class DoubaoASR {
  constructor(config,{uid,request={},onSentence=()=>{},onError=()=>{},WebSocketClass=WebSocket,startTimeout=12000,finishTimeout=6000}={}) {
    this.config=validateDoubaoConfig(config);this.uid=uid||this.config.uid;this.request=request;Object.assign(this,{onSentence,onError,WebSocketClass,startTimeout,finishTimeout});
    this.taskID=randomUUID();this.sequence=2;this.phase='new';this.queue=[];this.queuedBytes=0;this.audioBuffer=Buffer.alloc(0);
  }
  start(){
    if(this.phase!=='new')return this.startPromise;
    this.phase='connecting';this.startPromise=new Promise((resolve,reject)=>{this.startResolve=resolve;this.startReject=reject;});
    this.startTimer=setTimeout(()=>this.fail(safeDoubaoError('timeout')),this.startTimeout);
    try {const ws=this.ws=new this.WebSocketClass(this.config.websocketUrl,{headers:{'X-Api-Key':this.config.key,'X-Api-Resource-Id':this.config.resourceId,'X-Api-Request-Id':this.taskID,'X-Api-Connect-Id':randomUUID(),'X-Api-Sequence':'-1'},handshakeTimeout:this.startTimeout,maxPayload:4*1024*1024,followRedirects:false});
      // The service returns X-Tt-Logid in the HTTP upgrade response. Keep it
      // alongside the generated request ID so a failed session can be traced
      // without ever logging the API key or audio payload.
      ws.on('upgrade',response=>{const value=response?.headers?.['x-tt-logid'];if(value)this.logId=Array.isArray(value)?value[0]:String(value);});
      ws.on('open',()=>{try{ws.send(buildDoubaoStartFrame({uid:this.uid,request:this.request}));}catch{this.fail(safeDoubaoError('network'));}});ws.on('message',data=>this.receive(data));ws.on('unexpected-response',(_req,res)=>{res.resume();this.fail(safeDoubaoError(res.statusCode));});ws.on('error',()=>this.fail(safeDoubaoError('network')));ws.on('close',()=>{if(!['closed','failed'].includes(this.phase))this.fail(safeDoubaoError('closed'));});
    }catch{this.fail(safeDoubaoError('network'));}return this.startPromise;
  }
  receive(data){
    if(['failed','closed'].includes(this.phase))return;let msg;try{msg=parseDoubaoFrame(data);}catch(e){this.fail(e);return;}
    // Error frames carry the numeric provider code in the binary envelope.
    // Some optimized-endpoint responses also put a status code in
    // payload_msg; 1013 means “no valid speech” and is a normal silent
    // result, while 20000000 is the success sentinel.  Do not turn either
    // into a failed session, but surface other non-zero provider errors.
    const payloadCode=Number(msg.payloadMsg?.code||0);
    const providerCode=msg.code||((payloadCode&&payloadCode!==20000000)?payloadCode:0);
    if(providerCode&&providerCode!==1013){this.fail(safeDoubaoError(providerCode));return;}
    if(this.phase==='connecting'){clearTimeout(this.startTimer);this.phase='streaming';for(const frame of this.queue)this.sendFrame(frame);this.queue=[];this.queuedBytes=0;this.startResolve?.();}
    const list=msg.payloadMsg?.result?.utterances||msg.payloadMsg?.payload_msg?.result?.utterances||[];const fallback=msg.payloadMsg?.result;
    if(Array.isArray(list))list.forEach((utterance,index)=>this.onSentence({...utterance,definite:utterance.definite===true||msg.last},index));
    else if(fallback?.text)this.onSentence({...fallback,definite:fallback.definite===true||msg.last},0);
    if(msg.last&&this.phase==='finishing'){clearTimeout(this.finishTimer);this.phase='closed';this.finishResolve?.();this.ws?.close();}
  }
  sendFrame(frame){if(this.phase!=='streaming'&&this.phase!=='finishing')return false;if(this.ws.bufferedAmount>320000){this.fail(new Error('豆包实时转写上传积压过多，请检查网络后重新开始。'));return false;}try{this.ws.send(frame,{binary:true},e=>{if(e)this.fail(safeDoubaoError('network'));});return true;}catch{this.fail(safeDoubaoError('network'));return false;}}
  push(data){
    if(!Buffer.isBuffer(data)||data.length%2)throw new Error('豆包音频必须是 16-bit PCM。');
    if(this.phase==='failed'||this.phase==='closed')return false;this.audioBuffer=Buffer.concat([this.audioBuffer,data]);
    while(this.audioBuffer.length>=DOUBAO_CHUNK_BYTES){const chunk=this.audioBuffer.subarray(0,DOUBAO_CHUNK_BYTES);this.audioBuffer=this.audioBuffer.subarray(DOUBAO_CHUNK_BYTES);const frame=buildDoubaoAudioFrame(chunk,{sequence:this.sequence++});if(this.phase==='new'||this.phase==='connecting'){if(this.queuedBytes+frame.length>640000){this.fail(new Error('豆包实时转写连接过慢，音频已积压，请检查网络后重新开始。'));return false;}this.queue.push(frame);this.queuedBytes+=frame.length;}else if(!this.sendFrame(frame))return false;}
    return true;
  }
  finish(){
    if(this.finishPromise)return this.finishPromise;if(this.phase==='new'||this.phase==='connecting'){this.finishPromise=Promise.resolve(this.abort());return this.finishPromise;}
    if(this.phase!=='streaming')return Promise.resolve();this.phase='finishing';this.finishPromise=new Promise((resolve,reject)=>{this.finishResolve=resolve;this.finishReject=reject;});
    const finalFrame=buildDoubaoAudioFrame(this.audioBuffer,{sequence:this.sequence,last:true});this.audioBuffer=Buffer.alloc(0);this.sequence++;this.sendFrame(finalFrame);this.finishTimer=setTimeout(()=>this.fail(new Error('豆包末段文字确认超时；已保留收到的实时文字。')),this.finishTimeout);return this.finishPromise;
  }
  fail(error){if(['closed','failed'].includes(this.phase))return;this.phase='failed';clearTimeout(this.startTimer);clearTimeout(this.finishTimer);this.queue=[];this.audioBuffer=Buffer.alloc(0);this.startReject?.(error);this.finishReject?.(error);this.onError(error);this.ws?.terminate();}
  abort(){if(['closed','failed'].includes(this.phase))return;this.phase='closed';clearTimeout(this.startTimer);clearTimeout(this.finishTimer);this.queue=[];this.audioBuffer=Buffer.alloc(0);this.startReject?.(new Error('已停止连接'));this.finishResolve?.();this.ws?.terminate();}
}

export async function testDoubaoConnection(root) {
  const client=new DoubaoASR(readDoubaoConfig(root));
  try {await client.start();client.push(Buffer.alloc(DOUBAO_CHUNK_BYTES));await new Promise(r=>setTimeout(r,100));await client.finish();}
  finally {client.abort();}
  return '豆包流式语音识别连接成功，模型可用。';
}
