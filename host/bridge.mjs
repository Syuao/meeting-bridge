import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {cleanTranscript} from './questions.mjs';
import {QuestionStream} from './question-stream.mjs';
import {CaptionTracker} from './captions.mjs';
import {SemanticExtractor,hasKey,saveKey,testConnection,PROVIDER} from './semantic.mjs';
import {Translator} from './translation.mjs';
import {AlibabaASR,StreamingTranscript,readASRConfig,asrPublicConfig,saveASRConfig,testASRConnection,ASR_MODEL,asrModel} from './aliyun-asr.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const send = obj => { const b = Buffer.from(JSON.stringify(obj)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); process.stdout.write(Buffer.concat([h,b])); };
let input = Buffer.alloc(0), generation = 0, session = null, asr = null, watcher = null, pollBusy = false;
let ready=false,pending=[],inflight=null,questions=new QuestionStream(),captions=null,semantic=null,context=[];
let mode='rules';
let apiTest=null;
let cloud=null,cloudTranscript=null,heartbeat=null,stopTimer=null,stopping=false,finishing=false,lastPCM=0,asrTesting=false;
let selectedASRModel=ASR_MODEL;
let language = 'auto', started = false, idCounter = 0, speechEndedAt = 0;
const info = (state, message) => send({type:'status', state, message});
const metricsPath = path.join(root,'latency.jsonl');
function metric(value) {
  try { if(fs.statSync(metricsPath).size>2*1024*1024)fs.truncateSync(metricsPath,0); } catch {}
  fs.appendFile(metricsPath,JSON.stringify({at:Date.now(),...value})+'\n',()=>{});
}
function question(text,extra={}) { send({type:'question',id:`q-${Date.now()}-${++idCounter}`,text,at:Date.now(),...extra}); }
function semanticState(state,message,usage) {send({type:'semantic',state,message,provider:PROVIDER.name,model:PROVIDER.model,configured:hasKey(root)});if(usage)metric({stage:'api',provider:PROVIDER.name,inputTokens:usage.input_tokens,outputTokens:usage.output_tokens});}
function asrState(state,message){send({type:'asr_status',state,message,...asrPublicConfig(root,selectedASRModel)});}
const translator=new Translator(root,row=>send({type:'translation',...row}),(state,message,{usage,...extra})=>{
  send({type:'translation_status',state,message,...extra});
  if(usage)metric({stage:'translation',provider:extra.provider,inputTokens:usage.input_tokens,outputTokens:usage.output_tokens,latencyMs:extra.latencyMs});
  if(extra.errorCode)metric({stage:'translation_error',provider:extra.provider,code:extra.errorCode,httpStatus:extra.httpStatus,attempt:extra.attempt,backoffMs:extra.backoffMs});
});
function launchCapture(sessionDir,source,mine,streamPCM=false) {
  const app=path.join(root,'Meeting Bridge Audio.app');
  const launch=spawn('/usr/bin/open',['-n','-g',app,'--args','--session',sessionDir,'--source',source,'--parent',String(process.pid),'--stream-pcm',streamPCM?'1':'0','--background','1'],{stdio:['ignore','ignore','pipe']});
  launch.on('error',e=>{if(mine===generation)stop(e.message)});
  launch.on('exit',code=>{if(code&&mine===generation)stop('采集程序无法打开。')});
  info('permission','正在打开采集程序，首次使用可能需要系统录制权限。');
}
function drain() {
  if (!ready || inflight || !pending.length || !asr) { return; }
  inflight = pending.shift();
  asr.stdin.write(JSON.stringify({id:inflight.id, path:inflight.path, language})+'\n');
  send({type:'processing', queue:pending.length+1});
}
function stop(reason = '已停止监听') {
  cloud?.abort();cloud=null;cloudTranscript=null;clearInterval(heartbeat);clearTimeout(stopTimer);heartbeat=null;stopTimer=null;stopping=false;finishing=false;
  ++generation; started = false; semantic?.stop();semantic=null; clearInterval(watcher); watcher = null;
  apiTest?.abort();apiTest=null;
  if (session) {
    const previous = session; session = null;
    try { fs.writeFileSync(path.join(previous, 'stop'), 'stop'); } catch {}
    setTimeout(() => fs.rm(previous,{recursive:true,force:true},()=>{}), 2000).unref();
  }
  if (asr) { asr.kill('SIGTERM'); asr = null; }
  ready = false; pending = []; inflight = null; questions=new QuestionStream();captions=null;context=[];speechEndedAt=0;
  info('stopped', reason);
}
function requestStop(){
  if(!cloud||!session){stop();return;}
  if(stopping)return;stopping=true;semantic?.stop();
  info('stopping','已停止采集，正在保存最后一段文字…');
  try{fs.writeFileSync(path.join(session,'stop'),'stop');}catch{}
  stopTimer=setTimeout(finishCloud,3000);
}
function finishCloud(){
  if(finishing)return;
  if(!cloud){stop();return;}
  finishing=true;stopping=true;semantic?.stop();clearInterval(heartbeat);clearTimeout(stopTimer);
  const client=cloud,mine=generation;
  void (async()=>{
    try{
      if(client.phase==='connecting')await client.startPromise;
      await client.finish();
      if(mine===generation)stop('已停止监听，末段文字已保存');
    }catch(e){if(mine===generation)stop(e.message);}
  })();
}
async function start(options) {
  stop('准备启动…');
  const mine = ++generation;
  const source=['tencent','tencent-text','aliyun-all','aliyun-tencent'].includes(options.source)?options.source:'all';
  const useCloud=source.startsWith('aliyun-');
  let cloudConfig;if(useCloud){try{cloudConfig=readASRConfig(root);selectedASRModel=asrModel(options.asrModel,cloudConfig.region).id;}catch(e){asrState('error',e.message);info('error',e.message);return;}}
  mode=['semantic','rules'].includes(options.questionMode)?options.questionMode:'manual';
  language = ['en','zh','auto'].includes(options.language) ? options.language : 'auto';
  questions=new QuestionStream();captions=new CaptionTracker();
  const model = path.join(root,'models','ggml-base.bin');
  const workerPath = path.join(root,'bin','meeting-asr');
  if (!useCloud&&source!=='tencent-text'&&(!fs.existsSync(model) || !fs.existsSync(workerPath))) { info('error','转写引擎或模型缺失，请重新运行安装脚本。'); return; }
  session = fs.mkdtempSync(path.join(os.tmpdir(),'meetingbridge-')); fs.chmodSync(session,0o700);
  const sessionDir = session;
  started = true;
  if(mode==='semantic')semantic=new SemanticExtractor(root,q=>question(q.text,{detection:'semantic',source_ids:q.source_ids,kind:q.kind}),semanticState);
  if(useCloud){
    cloudTranscript=new StreamingTranscript(undefined,selectedASRModel);
    cloud=new AlibabaASR(cloudConfig,{model:selectedASRModel,language,hotwords:String(options.hotwords||'').slice(0,4000),onSentence:sentence=>{
      if(mine!==generation)return;
      const row=cloudTranscript.accept(sentence);if(!row)return;
      send({type:'transcript',...row});
      if(!row.final)send({type:'partial',text:row.text,piece:row.id});
      if(!stopping){
        if(mode==='semantic')semantic?.feed(cloudTranscript.recent(),[row]);
        else if(mode==='rules'&&row.final)for(const found of questions.push(row.text,{final:true}))question(found,{detection:'sentence-rules'});
      }
    },onError:e=>{if(mine===generation){stop(e.message);asrState('error',e.message);info('error',e.message);}}});
    launchCapture(sessionDir,source==='aliyun-all'?'all':'tencent',mine,true);
    if(mode==='semantic')semanticState(hasKey(root)?'ready':'unconfigured',hasKey(root)?'DeepSeek 识别待命':'实时转写可用；配置 DeepSeek API 后可自动识别问题。');
  }
  else if(source==='tencent-text'){launchCapture(sessionDir,source,mine);semanticState(hasKey(root)?'ready':'unconfigured',hasKey(root)?'DeepSeek 识别待命':'先读取实时转写；配置 DeepSeek API 后可自动识别问题。');}
  else {
  info('loading','正在加载本地转写模型…');
  asr = spawn(workerPath,[model],{stdio:['pipe','pipe','pipe']});
  asr.stderr.on('data',()=>{});
  asr.on('error',e=> { if (mine===generation) stop('引擎启动失败：'+e.message); });
  asr.on('exit',(code,signal)=> { if(mine===generation && started) stop(`转写引擎退出（${signal||code}），请重新开始。`); });
  const asrLines = createInterface({input:asr.stdout});
  asrLines.on('line', line => {
    if(mine!==generation) return;
    let msg; try { msg=JSON.parse(line); } catch { return; }
    if(msg.type==='ready') {
      ready=true;
      launchCapture(sessionDir,source,mine);
      drain(); return;
    }
    const item = inflight;
    if (!item || msg.id !== item.id) return;
    fs.rm(item.path,{force:true},()=>{}); inflight=null;
    metric({stage:item.partial?'preview':'transcript',asrMs:msg.ms||0,elapsedMs:Date.now()-item.at,duration:item.duration});
    if(msg.type==='error') { send({type:'error',message:'本段转写失败：'+msg.message}); }
    else {
      const text=cleanTranscript(msg.text);
      if(text) {
        if(item.partial) send({type:'partial',text,piece:item.piece});
        else {
          send({type:'transcript',id:item.id,text,at:item.at,ms:msg.ms,language:msg.language,piece:item.piece});
          speechEndedAt=item.speechEndedAt;
          if(mode==='semantic'){
            const segment={id:item.id,text};context.push(segment);context=context.slice(-8);semantic.feed(context,[segment]);
          }else if(mode==='rules')for(const found of questions.push(text,{final:item.final}))question(found,{speechEndedAt,detection:'sentence-rules'});
        }
      }
    }
    send({type:'processing',queue:pending.length});drain();
  });
  }
  watcher = setInterval(async()=> {
    if(pollBusy || mine!==generation) return; pollBusy=true;
    try {
      const files = (await fs.promises.readdir(sessionDir)).filter(x=>/^event-\d+\.json$/.test(x)).sort();
      for(const file of files) {
        if(mine!==generation) break;
        let event;
        try { event=JSON.parse(await fs.promises.readFile(path.join(sessionDir,file),'utf8')); await fs.promises.unlink(path.join(sessionDir,file)); } catch { continue; }
        if(event.type==='capture_started'){
          if(useCloud){
            const client=cloud;info('loading','正在连接阿里云实时转写…');asrState('connecting','正在建立语音连接…');lastPCM=Date.now();
            void client.start().then(()=>{
              if(mine!==generation||stopping)return;
              info('listening',`${source==='aliyun-all'?'正在监听系统声音':'正在监听腾讯会议声音'} · ${asrModel(selectedASRModel).name}`);asrState('ready',`${asrModel(selectedASRModel).name}已连接，正在实时转写`);
              heartbeat=setInterval(()=>{if(mine===generation&&!stopping&&Date.now()-lastPCM>300)client.push(Buffer.alloc(3200));},100);
            }).catch(e=>{if(mine===generation){stop(e.message);info('error',e.message);}});
          }else info('listening',source==='tencent-text'?'正在读取腾讯会议右侧实时转写':source==='all'?'正在监听系统声音 · 本机转写':'正在监听腾讯会议声音 · 本机转写');
        }
        if(event.type==='pcm'&&useCloud&&typeof event.data==='string'&&event.data.length<=4300){lastPCM=Date.now();cloud?.push(Buffer.from(event.data,'base64'));}
        if(event.type==='level') send(event);
        if(event.type==='caption_frame'&&captions){
          const frame=captions.ingest(event.lines,event.at);
          for(const row of frame.events)send({type:'transcript',...row});
          send({type:'partial',text:frame.partial||'未找到带时间的转写段落，请保持腾讯会议右侧实时转写展开。',piece:'tencent-text'});
          if(frame.found)semantic?.feed(frame.recent,frame.changed);
        }

        if(event.type==='capture_stopped') { if(useCloud)finishCloud();else stop(); break; }
        if(event.type==='error') { stop(event.message);info('error',event.message);break; }
        if(event.type==='segment' && /^audio-\d+\.f32$/.test(event.file)) {
          const item={id:`t-${Date.now()}-${++idCounter}`,path:path.join(sessionDir,event.file),at:event.at,partial:!!event.partial,final:!!event.final,piece:event.piece,speechEndedAt:event.speechEndedAt,duration:event.duration};
          // Keep only the newest preview for this piece; final transcription takes precedence.
          pending=pending.filter(old=>{if(old.partial&&old.piece===item.piece){fs.rm(old.path,{force:true},()=>{});return false;}return true;});
          if(pending.length>=8) { stop('转写积压过多，已停止采集。请关闭高负载应用后重试。'); break; }
          pending.push(item); drain();
        }
      }
    } catch {} finally { pollBusy=false; }
  },useCloud?40:180);
}
function handle(msg) {
  if(msg.type==='start') void start(msg).catch(e=> { stop(); info('error',e.message); });
  else if(msg.type==='translation_config')translator.configure(msg.enabled===true,msg.provider||'qwen-mt');
  else if(msg.type==='translate')translator.feed(Array.isArray(msg.rows)?msg.rows.slice(0,8):[]);
  else if(msg.type==='translation_retry')translator.retry();
  else if(msg.type==='translation_clear')translator.reset();
  else if(msg.type==='stop') requestStop();
  else if(msg.type==='ping') send({type:'pong'});
  else if(msg.type==='api_status')semanticState(hasKey(root)?'ready':'unconfigured',hasKey(root)?'DeepSeek 密钥已保存在本机；可点击测试连接':'尚未配置 DeepSeek API 密钥');
  else if(msg.type==='configure_api'){try{if(msg.provider!=='deepseek')throw new Error('请先重新加载 Meeting Bridge 扩展，再在 DeepSeek 密钥栏配置。');saveKey(root,String(msg.key||'').trim());semanticState('ready','DeepSeek 密钥已保存；尚未验证，可点击测试连接');semantic?.retry();translator.retry();}catch(e){semanticState('error',e.message);}}
  else if(msg.type==='test_api'){
    if(msg.provider!=='deepseek'){semanticState('error','请先重新加载 Meeting Bridge 扩展。');return;}
    if(apiTest)return;const controller=new AbortController();apiTest=controller;
    semanticState('testing','正在测试 DeepSeek 连接和示例问题提取…');
    void testConnection(root,controller.signal).then(({message,usage})=>{if(!controller.signal.aborted)semanticState('ready',message,usage);}).catch(e=>{if(!controller.signal.aborted)semanticState('error',e.message);}).finally(()=>{if(apiTest===controller)apiTest=null;});
  }
  else if(msg.type==='retry_api')semantic?.retry();
  else if(msg.type==='asr_status'){if(started||asrTesting)return;try{selectedASRModel=asrModel(msg.model).id;const config=asrPublicConfig(root,selectedASRModel);if(config.configured)asrModel(selectedASRModel,config.region);asrState(config.configured?'ready':'unconfigured',config.configured?`${asrModel(selectedASRModel).name}已选择；可点击测试连接`:'尚未配置阿里云百炼 API 密钥');}catch(e){asrState('error',e.message);}}
  else if(msg.type==='configure_asr'){try{if(started||asrTesting)throw new Error('请先停止监听或等待连接测试结束，再修改阿里云配置。');const model=asrModel(msg.model,msg.region).id;saveASRConfig(root,{key:msg.key,region:msg.region});selectedASRModel=model;asrState('ready',`${asrModel(model).name}：阿里云密钥已保存；请测试连接`);translator.retry();}catch(e){asrState('error',e.message);}}
  else if(msg.type==='test_asr'){
    if(asrTesting||started)return;
    try{selectedASRModel=asrModel(msg.model).id;}catch(e){asrState('error',e.message);return;}
    asrTesting=true;asrState('testing',`正在测试 ${asrModel(selectedASRModel).name}连接…`);
    void testASRConnection(root,selectedASRModel).then(message=>asrState('ready',message)).catch(e=>asrState('error',e.message)).finally(()=>{asrTesting=false;});
  }
  else if(msg.type==='delivery_metrics' && Number.isFinite(msg.latencyMs)) {
    metric({stage:'draft',latencyMs:msg.latencyMs,status:msg.status});
  }
}
process.stdin.on('data',data=> {
  input=Buffer.concat([input,data]);
  while(input.length>=4) {
    const n=input.readUInt32LE(0); if(n>1048576) { stop(); process.exit(1); }
    if(input.length<4+n) break;
    const raw=input.subarray(4,4+n); input=input.subarray(4+n);
    try { handle(JSON.parse(raw)); } catch { send({type:'error',message:'无效的控制消息'}); }
  }
});
process.stdin.on('end',()=> { translator.dispose();stop(); setTimeout(()=>process.exit(0),700); });
process.stdout.on('error',()=>process.exit(0));
for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=> { translator.dispose();stop(); setTimeout(()=>process.exit(0),700); });
send({type:'hello',version:'0.7.0',model:ASR_MODEL,source:'aliyun-all',questionProvider:PROVIDER.name});
