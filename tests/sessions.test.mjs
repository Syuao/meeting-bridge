import {createAnswerRelay,roomKey,SHARECODE_MATCH} from '../extension/answer-relay.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import {translationCandidates} from '../extension/translation.js';
const code=(await fs.readFile(new URL('../extension/background.js',import.meta.url),'utf8'))
 .replace("import {createAnswerRelay, roomKey, SHARECODE_MATCH} from './answer-relay.js';",'').replace("import './sites.js';",await fs.readFile(new URL('../extension/sites.js',import.meta.url),'utf8'))
 .replace("import {translationCandidates} from './translation.js';",'');
function load(storage={}){
 let handler,updated;const broadcasts=[],tabUrls=new Map();const sessionStore={};
 const local={async get(keys){if(!keys)return structuredClone(storage);if(typeof keys==='string')return {[keys]:structuredClone(storage[keys])};const out={};for(const key of keys)if(key in storage)out[key]=structuredClone(storage[key]);return out;},async set(values){Object.assign(storage,structuredClone(values));}};
 const chrome={
  storage:{local,session:{async get(key){return {[key]:structuredClone(sessionStore[key])};},async set(values){Object.assign(sessionStore,structuredClone(values));}}},
  runtime:{onMessage:{addListener(fn){handler=fn;}},async sendMessage(msg){broadcasts.push(structuredClone(msg));},connectNative(){throw new Error('native not needed');},getURL(path){return `chrome-extension://${path}`;}},
  sidePanel:{setPanelBehavior:async()=>{}},
  windows:{onRemoved:{addListener(){}},async create(){return {id:99};}},
  tabs:{onUpdated:{addListener(fn){updated=fn}},onRemoved:{addListener(){}},async query(){return[];},async get(id){return {id,url:tabUrls.get(id)||(id===8?'https://kode666.com/room/test':'https://chatgpt.com/c/test')}},async sendMessage(id,msg){return {ok:true,...msg,sameConversation:true}}},
  scripting:{async executeScript(){return [{result:{ok:true,documentToken:'document-1'}}]}},
 };
 vm.runInNewContext(code,{createAnswerRelay,roomKey,SHARECODE_MATCH,translationCandidates,chrome,setTimeout,clearTimeout,URL,URLSearchParams,console,structuredClone,crypto:undefined,Math});
 const call=(msg,sender={})=>new Promise(resolve=>handler(msg,sender,resolve));
 return {storage,call,broadcasts,updated,navigate:(id,url)=>tabUrls.set(id,url)};
}
test('each browser window receives an independent persistent transcription session',async()=>{
 const app=load({config:{streamingVersion:1,manualVersion:1,continuousVersion:1,fontSize:11},history:{transcripts:[{id:'legacy',text:'A'}],questions:[]}});
 const a=await app.call({type:'session_context',windowId:10});assert.equal(a.sessionId,'legacy');
 const aState=await app.call({type:'get_state',sessionId:a.sessionId});assert.equal(aState.transcripts.length,1);
 const b=await app.call({type:'session_context',windowId:11});assert.notEqual(b.sessionId,a.sessionId);
 const bState=await app.call({type:'get_state',sessionId:b.sessionId});assert.equal(bState.transcripts.length,0);
 await app.call({type:'config',sessionId:b.sessionId,value:{fontSize:20}});
 assert.equal((await app.call({type:'get_state',sessionId:a.sessionId})).config.fontSize,11);
 assert.equal((await app.call({type:'get_state',sessionId:b.sessionId})).config.fontSize,20);
 assert.ok(app.storage.meetingSessions[b.sessionId]);
});
test('reloading either bound page pauses answer relay without changing transcript history',async()=>{
 const target={tabId:7,url:'https://chatgpt.com/c/test'};
 const app=load({target,history:{transcripts:[{id:'kept',text:'Existing transcript'}],questions:[]}});
 await app.call({type:'session_context',windowId:10});
 const source={frameId:0,tab:{id:7,url:target.url},url:target.url};
 for(const id of [7,8]){
   assert.equal((await app.call({type:'relay_bind',sessionId:'legacy',tabId:8})).ok,true);
   assert.equal((await app.call({type:'answer_source_ready'},source)).config.enabled,true);
   await app.updated(id,{status:'loading'},{id,url:id===7?target.url:'https://kode666.com/room/test'});
   assert.equal((await app.call({type:'answer_source_ready'},source)).config.enabled,false);
 }
 const state=await app.call({type:'get_state',sessionId:'legacy'});assert.equal(state.transcripts[0].text,'Existing transcript');assert.match(state.answerRelayStatus.message,/重新加载/);
});

test('rebind after same-tab conversation and room navigation uses the live URLs, not the initial document URL',async()=>{
 const old='https://chatgpt.com/c/test',next='https://chatgpt.com/c/next';
 const app=load({target:{tabId:7,url:old},history:{transcripts:[{id:'kept',text:'Keep'}],questions:[]}});
 await app.call({type:'session_context',windowId:10});await app.call({type:'relay_bind',sessionId:'legacy',tabId:8});
 app.navigate(7,next);app.navigate(8,'https://kode666.com/room/next');
 await app.call({type:'bind',sessionId:'legacy',tabId:7});await app.call({type:'relay_bind',sessionId:'legacy',tabId:8});
 const sender={frameId:0,tab:{id:7,url:next},url:old};
 const ready=await app.call({type:'answer_source_ready',pageUrl:next},sender);assert.equal(ready.config.enabled,true);
 assert.equal((await app.call({type:'answer_selection',pageUrl:next,epoch:ready.config.epoch,id:'selected',revision:1,text:'Test selection'},sender)).ok,true);
 assert.equal((await app.call({type:'answer_source_ready',pageUrl:old},sender)).config.enabled,false);
 const state=await app.call({type:'get_state',sessionId:'legacy'});assert.equal(state.transcripts[0].text,'Keep');assert.match(state.config.answerRelay.room.url,/room\/next/);
});

test('either binding button connects both dropdown choices, and the auto toggle reconnects a changed conversation',async()=>{
 const app=load({target:{tabId:7,url:'https://chatgpt.com/c/test'}});
 await app.call({type:'session_context',windowId:10});
 assert.equal((await app.call({type:'bind',sessionId:'legacy',tabId:7,roomTabId:8})).ok,true);
 let state=await app.call({type:'get_state',sessionId:'legacy'});assert.equal(state.answerRelayStatus.state,'ready');
 const next='https://chatgpt.com/c/next';app.navigate(7,next);
 assert.equal((await app.call({type:'relay_bind',sessionId:'legacy',tabId:8,targetTabId:7})).ok,true);
 state=await app.call({type:'get_state',sessionId:'legacy'});assert.equal(state.target.url,next);assert.equal(state.answerRelayStatus.state,'ready');
 const last='https://chatgpt.com/c/last';app.navigate(7,last);
 assert.equal((await app.call({type:'relay_mode',sessionId:'legacy',automatic:true,targetTabId:7,roomTabId:8})).ok,true);
 state=await app.call({type:'get_state',sessionId:'legacy'});assert.equal(state.target.url,last);assert.equal(state.config.answerRelay.automatic,true);assert.equal(state.answerRelayStatus.state,'ready');
});
