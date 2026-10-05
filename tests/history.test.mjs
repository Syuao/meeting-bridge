import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {translationCandidates} from '../extension/translation.js';
import fs from 'node:fs/promises';
const code=(await fs.readFile(new URL('../extension/background.js',import.meta.url),'utf8')).replace("import './sites.js';",await fs.readFile(new URL('../extension/sites.js',import.meta.url),'utf8')).replace("import {translationCandidates} from './translation.js';",'');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function load(storage={}) {
  let handle,native;const outgoing=[];
  const chrome={
    storage:{local:{async get(){return structuredClone(storage)},async set(data){Object.assign(storage,structuredClone(data))}},session:{async get(){return {}}}},
    runtime:{onMessage:{addListener(fn){handle=fn}},async sendMessage(){},connectNative(){return {onMessage:{addListener(fn){native=fn}},onDisconnect:{addListener(){}},postMessage(msg){outgoing.push(msg)}}}},
    sidePanel:{async setPanelBehavior(){}},
    tabs:{onUpdated:{addListener(){}},onRemoved:{addListener(){}}}
  };
  vm.runInNewContext(code,{translationCandidates,chrome,setTimeout,clearTimeout,URL,URLSearchParams,console});
  return {outgoing,call:msg=>new Promise(resolve=>handle(msg,{},resolve)),emit:msg=>native(msg)};
}
test('transcripts persist while audio level events continue, and survive a worker restart',async()=>{
  const storage={};const bridge=load(storage);await bridge.call({type:'start'});
  bridge.emit({type:'transcript',id:'t1',text:'How does a cache work?',at:1000,ms:300,piece:1});
  const timer=setInterval(()=>bridge.emit({type:'level',value:.1}),30);
  await pause(350);clearInterval(timer);
  assert.equal(storage.history.transcripts[0].text,'How does a cache work?');
  const reopened=load(storage);assert.equal((await reopened.call({type:'get_state'})).transcripts.length,1);
  await reopened.call({type:'clear'});assert.deepEqual(storage.history.transcripts,[]);
});

test('interim translations persist with history, stay provisional after revisions, and never fill a draft',async()=>{
  const storage={};const bridge=load(storage);await bridge.call({type:'asr_status'});
  bridge.emit({type:'transcript',id:'live',text:'What is your',final:false});
  assert.ok(bridge.outgoing.some(msg=>msg.type==='translate'&&msg.rows[0].text==='What is your'));
  bridge.emit({type:'translation',id:'live',sourceText:'What is your',text:'你的……是什么？'});
  bridge.emit({type:'transcript',id:'live',text:'What is your greatest strength?',final:true});
  let state=await bridge.call({type:'get_state'});assert.equal(state.transcripts[0].translation.text,'你的……是什么？');assert.equal(state.questions.length,0);
  bridge.emit({type:'translation',id:'live',sourceText:state.transcripts[0].text,text:'你最大的优势是什么？'});await pause(240);
  const reopened=load(storage);await reopened.call({type:'asr_status'});state=await reopened.call({type:'get_state'});
  assert.equal(state.transcripts[0].translation.text,'你最大的优势是什么？');assert.equal(reopened.outgoing.filter(msg=>msg.type==='translate').length,0);
  await reopened.call({type:'config',value:{translationEnabled:false}});assert.equal((await load(storage).call({type:'get_state'})).config.translationEnabled,false);
});
test('old waiting questions stay available but do not automatically enter a new draft',async()=>{
  const reopened=load({config:{autoSend:true},history:{transcripts:[],questions:[{id:'q1',text:'What is a thread?',status:'waiting'}]}});
  const state=await reopened.call({type:'get_state'});
  assert.equal(state.questions[0].status,'held');assert.equal(state.config.autoSend,false);assert.equal(state.running,false);
});
test('updates to a Tencent paragraph replace its text without duplicating or deleting older history',async()=>{
  const storage={history:{transcripts:[{id:'old',text:'Earlier saved transcript.'}],questions:[]}};
  const bridge=load(storage);await bridge.call({type:'start'});
  bridge.emit({type:'transcript',id:'caption-1',text:'How would',source:'tencent-text',at:100});
  bridge.emit({type:'transcript',id:'caption-1',text:'How would you design a cache?',source:'tencent-text',at:100});
  const state=await bridge.call({type:'get_state'});
  assert.equal(state.transcripts.length,2);assert.equal(state.transcripts[0].text,'Earlier saved transcript.');
  assert.equal(state.transcripts[1].text,'How would you design a cache?');
  await pause(250);assert.equal(storage.history.transcripts.length,2);
});
test('workflow migration selects manual mode and preserves history, binding and source preferences',async()=>{
  const storage={config:{source:'all',autoFill:false,autoSend:true},target:{tabId:7,url:'https://chatgpt.com/c/existing'},history:{transcripts:[{id:'old',text:'Saved text'}],questions:[]}};
  const bridge=load(storage),state=await bridge.call({type:'get_state'});
  assert.equal(state.config.source,'aliyun-all');assert.equal(state.config.questionMode,'manual');assert.equal(state.config.fontSize,14);
  assert.equal(state.config.autoFill,false);assert.equal(state.config.autoSend,false);assert.equal(state.target.tabId,7);assert.equal(state.transcripts.length,1);
  await bridge.call({type:'config',value:{source:'all'}});
  assert.equal((await load(storage).call({type:'get_state'})).config.source,'all');
});
test('frequent cloud revisions persist, upsert one history row and display each final once',async()=>{
  const storage={history:{transcripts:[{id:'old',text:'Preserved'}],questions:[]}};
  const bridge=load(storage);await bridge.call({type:'start'});
  let revision=0;const emit=final=>bridge.emit({type:'transcript',source:'aliyun',id:'cloud-1',piece:'cloud-1',text:final?'Why Redis?':'Why Redis? '+(++revision),final});
  emit(false);const timer=setInterval(()=>emit(false),25);await pause(280);clearInterval(timer);
  assert.equal(storage.history.transcripts.length,2,'continuous speech must not postpone saving history');
  assert.equal(storage.history.transcripts[0].text,'Preserved');
  emit(true);emit(true);
  const state=await bridge.call({type:'get_state'});
  assert.equal(state.transcripts.length,2);assert.equal(state.transcripts[1].text,'Why Redis?');
  assert.equal(state.liveLines.length,1);assert.equal(state.liveLines[0],'Why Redis?');
});

test('custom font sizes and confirmation preferences persist without resetting on startup',async()=>{
 const storage={};const app=load(storage);await app.call({type:'config',value:{fontSize:11,confirmSelection:true}});
 const reopened=load(storage);const state=await reopened.call({type:'get_state'});
 assert.equal(state.config.fontSize,11);assert.equal(state.config.confirmSelection,true);
 for(const invalid of [9,33,NaN,14.5,'12'])await reopened.call({type:'config',value:{fontSize:invalid}});
 assert.equal((await reopened.call({type:'get_state'})).config.fontSize,11);
 await reopened.call({type:'config',value:{fontSize:32,confirmSelection:false}});
 assert.equal((await load(storage).call({type:'get_state'})).config.fontSize,32);
 assert.equal((await load(storage).call({type:'get_state'})).config.confirmSelection,false);
});

test('ASR model selection persists and reaches connection tests and capture without changing history or binding',async()=>{
  const qwen='qwen-audio-3.0-asr-flash-streaming',paraformer='paraformer-realtime-v2';
  const storage={config:{streamingVersion:1,manualVersion:1,continuousVersion:1,hotwords:'Redis',translationEnabled:false},target:{tabId:7,url:'https://chatgpt.com/c/existing'},history:{transcripts:[{id:'old',text:'Saved text'}],questions:[]}};
  const first=load(storage);assert.equal((await first.call({type:'get_state'})).config.asrModel,qwen);
  assert.equal((await first.call({type:'config',value:{asrModel:paraformer}})).ok,true);
  const reopened=load(storage),state=await reopened.call({type:'get_state'});
  assert.equal(state.config.asrModel,paraformer);assert.equal(state.target.tabId,7);assert.equal(state.transcripts[0].text,'Saved text');assert.equal(state.config.hotwords,'Redis');
  await reopened.call({type:'test_asr'});assert.equal(reopened.outgoing.at(-1).model,paraformer);
  reopened.emit({type:'asr_status',state:'testing'});
  assert.match((await reopened.call({type:'config',value:{asrModel:qwen}})).error,/等待/);
  reopened.emit({type:'asr_status',state:'ready'});
  await reopened.call({type:'start'});assert.equal(reopened.outgoing.at(-1).asrModel,paraformer);
  assert.match((await reopened.call({type:'config',value:{asrModel:qwen}})).error,/停止/);
  await reopened.call({type:'stop'});reopened.emit({type:'status',state:'stopped'});
  assert.match((await reopened.call({type:'config',value:{asrModel:'unsupported'}})).error,/受支持/);
  assert.equal((await reopened.call({type:'get_state'})).config.asrModel,paraformer);
  await reopened.call({type:'config',value:{asrModel:qwen}});await reopened.call({type:'test_asr'});
  assert.equal(reopened.outgoing.at(-1).model,qwen);
  const invalid=load({config:{asrModel:'obsolete'}});assert.equal((await invalid.call({type:'get_state'})).config.asrModel,qwen);
});
