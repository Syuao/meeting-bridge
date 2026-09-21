import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';

export const ASR_MODEL='qwen-audio-3.0-asr-flash-streaming';
const endpoints={beijing:'wss://dashscope.aliyuncs.com/api-ws/v1/inference',singapore:'wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference'};
const configFile=root=>path.join(root,'aliyun-asr.json');
export function readASRConfig(root){
  let config;try{config=JSON.parse(fs.readFileSync(configFile(root),'utf8'));}catch{throw new Error('请先在助手设置中保存阿里云百炼 API 密钥。');}
  return validateConfig(config);
}
function validateConfig({key,region='beijing'}={}){
  if(typeof key!=='string'||!/^sk-[A-Za-z0-9_-]{20,}$/.test(key))throw new Error('请输入阿里云百炼 API 密钥（sk- 开头）。');
  if(!Object.hasOwn(endpoints,region))throw new Error('请选择密钥所属地域：北京或新加坡。');
  return {key,region};
}
export function asrPublicConfig(root){try{const {region}=readASRConfig(root);return {configured:true,region,model:ASR_MODEL};}catch{return {configured:false,region:'beijing',model:ASR_MODEL};}}
export function saveASRConfig(root,input){
  const config=validateConfig({...input,key:String(input.key||'').trim()});
  const file=configFile(root);if(fs.existsSync(file))fs.chmodSync(file,0o600);
  fs.writeFileSync(file,JSON.stringify(config),{mode:0o600});
  return asrPublicConfig(root);
}
export function parseHotwords(text=''){
  return [...new Set(String(text).split(/[,，;；\n]+/).map(x=>x.trim()).filter(Boolean))].slice(0,80).filter(x=>x.length<=60);
}
export function runTask(taskID,{language='auto',hotwords=''}={}){
  const words=parseHotwords(hotwords),parameters={format:'pcm',sample_rate:16000,language_hints:language==='en'?['en']:language==='zh'?['zh']:['en','zh'],semantic_punctuation_enabled:false,max_sentence_silence:500,multi_threshold_mode_enabled:true,heartbeat:true};
  if(words.length)parameters.vocabulary=Object.fromEntries(words.map(word=>[word,2]));
  return {header:{action:'run-task',task_id:taskID,streaming:'duplex'},payload:{task_group:'audio',task:'asr',function:'recognition',model:ASR_MODEL,parameters,input:{}}};
}
export function finishTask(taskID){return {header:{action:'finish-task',task_id:taskID,streaming:'duplex'},payload:{input:{}}};}
export function safeASRError(code){
  const value=String(code).toLowerCase();
  if(/401|403|auth|api.?key|access.?denied|forbidden/.test(value))return new Error('阿里云密钥无效、地域不匹配或没有模型权限，请检查百炼控制台。');
  if(/payment|balance|quota|arrear/.test(value))return new Error('阿里云余额或额度不足，请检查百炼控制台。');
  if(/429|throttl|limit/.test(value))return new Error('阿里云请求限流，请稍后重试。');
  if(/invalid|unsupported|model/.test(value))return new Error('阿里云不接受当前模型或参数，请检查模型开通状态和密钥地域。');
  return new Error('阿里云实时转写连接中断或超时，请检查网络和百炼服务状态后重新开始。');
}

// One ID survives every interim revision. Finals cannot be overwritten by late partials.
export class StreamingTranscript {
  constructor(sessionID=randomUUID()){this.sessionID=sessionID;this.rows=new Map();}
  accept(sentence,at=Date.now()){
    if(!sentence||sentence.heartbeat||!Number.isInteger(sentence.sentence_id)||sentence.sentence_id<1||typeof sentence.text!=='string'||!sentence.text.trim())return null;
    const id=`ali-${this.sessionID}-${sentence.sentence_id}`,old=this.rows.get(id),text=sentence.text.trim(),final=sentence.sentence_end===true;
    if(old?.final||(old?.text===text&&old.final===final))return null;
    const row={id,piece:id,text,final,source:'aliyun',at:old?.at||at,beginTime:sentence.begin_time,endTime:sentence.end_time};
    this.rows.set(id,row);while(this.rows.size>12)this.rows.delete(this.rows.keys().next().value);
    return row;
  }
  recent(){return [...this.rows.values()].slice(-8);}
}

export class AlibabaASR {
  constructor(config,{language='auto',hotwords='',onSentence=()=>{},onError=()=>{},WebSocketClass=WebSocket,startTimeout=12000,finishTimeout=5000}={}){
    this.config=validateConfig(config);Object.assign(this,{language,hotwords,onSentence,onError,WebSocketClass,startTimeout,finishTimeout});
    this.taskID=randomUUID();this.phase='new';this.queue=[];this.queuedBytes=0;
  }
  start(){
    if(this.phase!=='new')return this.startPromise;
    this.phase='connecting';
    this.startPromise=new Promise((resolve,reject)=>{this.startResolve=resolve;this.startReject=reject;});
    this.startTimer=setTimeout(()=>this.fail(safeASRError('timeout')),this.startTimeout);
    try{
      const ws=this.ws=new this.WebSocketClass(endpoints[this.config.region],{headers:{Authorization:`Bearer ${this.config.key}`},handshakeTimeout:this.startTimeout,maxPayload:1024*1024,followRedirects:false});
      ws.on('open',()=>{if(this.phase==='connecting')ws.send(JSON.stringify(runTask(this.taskID,this)));});
      ws.on('message',data=>this.receive(data));
      ws.on('unexpected-response',(_req,res)=>{res.resume();this.fail(safeASRError(res.statusCode));});
      ws.on('error',()=>this.fail(safeASRError('network')));
      ws.on('close',()=>{if(!['closed','failed'].includes(this.phase))this.fail(safeASRError('closed'));});
    }catch{this.fail(safeASRError('network'));}
    return this.startPromise;
  }
  receive(data){
    if(['failed','closed'].includes(this.phase))return;
    let msg;try{msg=JSON.parse(data.toString());}catch{return;}
    if(msg.header?.task_id!==this.taskID)return;
    if(msg.header.event==='task-failed'){this.fail(safeASRError(msg.header.error_code));return;}
    if(msg.header.event==='task-started'&&this.phase==='connecting'){
      clearTimeout(this.startTimer);this.phase='streaming';
      for(const frame of this.queue)this.sendPCM(frame);
      this.queue=[];this.queuedBytes=0;
      if(this.phase==='streaming')this.startResolve();
    }else if(msg.header.event==='result-generated'&&['streaming','finishing'].includes(this.phase)){
      const sentence=msg.payload?.output?.sentence;if(sentence)this.onSentence(sentence);
    }else if(msg.header.event==='task-finished'&&this.phase==='finishing'){
      clearTimeout(this.finishTimer);this.phase='closed';this.finishResolve();this.ws.close();
    }
  }
  push(data){
    if(!Buffer.isBuffer(data)||data.length%2||data.length>32000)throw new Error('无效的 PCM 音频帧。');
    if(['new','connecting'].includes(this.phase)){
      if(this.queuedBytes+data.length>320000){this.fail(new Error('实时转写连接过慢，音频已积压 10 秒，请检查网络后重新开始。'));return false;}
      this.queue.push(data);this.queuedBytes+=data.length;return true;
    }
    return this.phase==='streaming'?this.sendPCM(data):false;
  }
  sendPCM(data){
    if(this.phase!=='streaming')return false;
    if(this.ws.bufferedAmount>160000){this.fail(new Error('上传声音已积压 5 秒，请检查网络后重新开始。'));return false;}
    try{this.ws.send(data,{binary:true},error=>{if(error)this.fail(safeASRError('network'));});return true;}catch{this.fail(safeASRError('network'));return false;}
  }
  finish(){
    if(this.finishPromise)return this.finishPromise;
    if(this.phase!=='streaming'){this.abort();return Promise.resolve();}
    this.phase='finishing';
    this.finishPromise=new Promise((resolve,reject)=>{this.finishResolve=resolve;this.finishReject=reject;});
    this.finishTimer=setTimeout(()=>this.fail(new Error('阿里云末段文字确认超时；已保留收到的实时文字。')),this.finishTimeout);
    try{this.ws.send(JSON.stringify(finishTask(this.taskID)));}catch{this.fail(safeASRError('network'));}
    return this.finishPromise;
  }
  fail(error){
    if(['closed','failed'].includes(this.phase))return;
    this.phase='failed';clearTimeout(this.startTimer);clearTimeout(this.finishTimer);
    this.queue=[];this.queuedBytes=0;this.startReject?.(error);this.finishReject?.(error);this.onError(error);this.ws?.terminate();
  }
  abort(){
    if(['closed','failed'].includes(this.phase))return;
    this.phase='closed';clearTimeout(this.startTimer);clearTimeout(this.finishTimer);
    this.queue=[];this.queuedBytes=0;this.startReject?.(new Error('已停止连接'));this.finishResolve?.();this.ws?.terminate();
  }
}

export async function testASRConnection(root){
  const client=new AlibabaASR(readASRConfig(root));
  try{await client.start();client.push(Buffer.alloc(3200));await new Promise(r=>setTimeout(r,100));client.push(Buffer.alloc(3200));await client.finish();}
  finally{client.abort();}
  return '阿里云连接成功，模型可用。请开始监听并播放英文声音，验证实际转写效果。';
}
