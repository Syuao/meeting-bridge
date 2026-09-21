import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {translationCandidates} from '../extension/translation.js';
import fs from 'node:fs/promises';
const code=(await fs.readFile(new URL('../extension/background.js',import.meta.url),'utf8')).replace("import './sites.js';",await fs.readFile(new URL('../extension/sites.js',import.meta.url),'utf8')).replace("import {translationCandidates} from './translation.js';",'');
const pause=()=>new Promise(resolve=>setTimeout(resolve,20));
function setup({send,history,config,inject,tabUrl}={}){
  let listener;const messages=[],native=[],injections=[];
  const target={tabId:7,url:'https://chatgpt.com/c/existing',title:'Existing'};
  const storage={config:{streamingVersion:1,manualVersion:1,questionMode:'manual',autoFill:false,...config},target,history};
  const chrome={storage:{local:{async get(){return structuredClone(storage)},async set(data){Object.assign(storage,structuredClone(data))}},session:{async get(){return {}}}},runtime:{onMessage:{addListener(fn){listener=fn}},async sendMessage(){},connectNative(){return {onMessage:{addListener(){}},onDisconnect:{addListener(){}},postMessage(msg){native.push(msg)}}}},sidePanel:{async setPanelBehavior(){}},scripting:{async executeScript(details){injections.push(details);await inject?.(details)}},tabs:{async get(id){return {id,url:tabUrl||(id===7?target.url:'https://chatgpt.com/c/new'),title:'Chat'}},async sendMessage(id,msg){messages.push(msg);return send?send(msg):{ok:true,appended:true}},onUpdated:{addListener(){}},onRemoved:{addListener(){}}}};
  vm.runInNewContext(code,{translationCandidates,chrome,setTimeout,clearTimeout,URL,URLSearchParams,console});
  return {messages,native,storage,injections,call:(msg,sender={})=>new Promise(resolve=>{if(listener(msg,sender,resolve)===false)resolve({blocked:true})})};
}
test('manual selections work after capture stops, never send, and repeated clicks do not duplicate',async()=>{
  const app=setup();await app.call({type:'config',value:{autoSend:true,autoFill:true}});
  const msg={type:'fill_selection',id:'manual-first',text:'  Why did you choose Redis?  '};
  const first=await app.call(msg);assert.equal(first.status,'filled');
  await app.call(msg);assert.equal(app.messages.length,1);assert.equal(app.messages[0].autoSend,false);
  assert.equal(app.messages[0].text,'Why did you choose Redis?');
  const state=await app.call({type:'get_state'});assert.equal(state.questions.length,1);assert.equal(state.running,false);
  assert.equal(app.native.length,0,'manual selection must not start a native connection or an API request');
});
test('rapid selections serialize and append in order while autoFill is off',async()=>{
  let finish;const app=setup({send:()=>new Promise(resolve=>{finish=resolve})});
  const first=app.call({type:'fill_selection',id:'manual-one',text:'First question?'});await pause();
  const second=await app.call({type:'fill_selection',id:'manual-two',text:'Second question?'});
  assert.equal(second.status,'waiting');assert.equal(app.messages.length,1);
  finish({ok:true});await first;await pause();assert.equal(app.messages.length,2);
  assert.equal(app.messages[1].text,'Second question?');finish({ok:true});await pause();
  assert.ok((await app.call({type:'get_state'})).questions.every(q=>q.status==='filled'));
});
test('a busy ChatGPT retries an explicitly selected excerpt, not unrelated historical questions',async()=>{
  let busy=true;const app=setup({history:{transcripts:[],questions:[{id:'old',text:'Old question?',status:'pending'}]},send:()=>busy?{ok:false,message:'等待 ChatGPT 完成当前回答'}:{ok:true}});
  assert.equal((await app.call({type:'fill_selection',id:'manual-new',text:'New question?'})).status,'waiting');
  busy=false;await app.call({type:'composer_ready'},{tab:{id:7,url:'https://chatgpt.com/c/existing'}});await pause();
  assert.deepEqual(app.messages.map(m=>m.text),['New question?','New question?']);
  const state=await app.call({type:'get_state'});assert.equal(state.questions[0].status,'held');assert.equal(state.questions[1].status,'filled');
});
test('rebinding does not carry a waiting excerpt into a different conversation',async()=>{
  const app=setup({send:()=>({ok:false,message:'busy'})});
  await app.call({type:'fill_selection',id:'manual-one',text:'Question?'});
  await app.call({type:'bind',tabId:8});await pause();
  const state=await app.call({type:'get_state'});assert.equal(state.questions[0].status,'held');assert.equal(state.questions[0].requested,false);assert.equal(app.messages.length,1);
});
test('invalid selections and content-script commands cannot add draft text',async()=>{
  const app=setup();
  for(const msg of [{id:'manual-a',text:''},{id:'manual-b',text:'x'.repeat(10001)},{id:'bad',text:'Question?'}])assert.ok((await app.call({type:'fill_selection',...msg})).error);
  assert.equal((await app.call({type:'fill_selection',id:'manual-injected',text:'Not allowed'},{tab:{id:7,url:'https://chatgpt.com/c/existing'}})).blocked,true);
  assert.equal(app.messages.length,0);
});
test('manual mode reaches native capture unchanged, including the Tencent text route',async()=>{
  const app=setup();await app.call({type:'config',value:{source:'tencent-text'}});await app.call({type:'start'});
  const start=app.native.find(msg=>msg.type==='start');assert.equal(start.questionMode,'manual');assert.equal(start.source,'tencent-text');
});
test('an extension reload reconnects the bound page and appends the same selection once',async()=>{
  let connected=false;const inserted=[];
  const app=setup({inject:()=>{connected=true},send:msg=>{if(!connected)throw Error('Could not establish connection. Receiving end does not exist.');inserted.push(msg);return {ok:true}}});
  const result=await app.call({type:'fill_selection',id:'manual-reconnect',text:'Selected question?'});
  assert.equal(result.status,'filled');assert.equal(app.injections.length,1);
  assert.equal(app.injections[0].target.tabId,7);assert.equal(app.injections[0].files[1],'content.js');
  assert.equal(inserted.length,1);assert.equal(inserted[0].autoSend,false);
  await app.call({type:'fill_selection',id:'manual-reconnect',text:'Selected question?'});
  assert.equal(inserted.length,1);
});
test('a blocked queue reports the first error for later selections, not a success-sounding queue message',async()=>{
  const app=setup({send:()=>{throw Error('Could not establish connection. Receiving end does not exist.')},inject:()=>{throw Error('Cannot access this page')}});
  await app.call({type:'fill_selection',id:'manual-first',text:'First?'});
  const second=await app.call({type:'fill_selection',id:'manual-second',text:'Second?'});
  assert.equal(second.status,'waiting');assert.match(second.message,/尚未填入.*Cannot access this page/);
  assert.equal(app.messages.length,2);assert.ok((await app.call({type:'get_state'})).questions.every(q=>q.status==='waiting'));
});
test('a target moved off ChatGPT never receives content injection or draft text',async()=>{
  const app=setup({tabUrl:'https://example.org/c/existing'});
  const result=await app.call({type:'fill_selection',id:'manual-moved',text:'Question?'});
  assert.equal(result.status,'waiting');assert.match(result.message,/重新绑定/);
  assert.equal(app.injections.length,0);assert.equal(app.messages.length,0);
});
