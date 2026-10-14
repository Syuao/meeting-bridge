import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import {translationCandidates} from '../extension/translation.js';
const code=(await fs.readFile(new URL('../extension/background.js',import.meta.url),'utf8'))
 .replace("import './sites.js';",await fs.readFile(new URL('../extension/sites.js',import.meta.url),'utf8'))
 .replace("import {translationCandidates} from './translation.js';",'');
function load(storage={}){
 let handler;const broadcasts=[];const sessionStore={};
 const local={async get(keys){if(!keys)return structuredClone(storage);if(typeof keys==='string')return {[keys]:structuredClone(storage[keys])};const out={};for(const key of keys)if(key in storage)out[key]=structuredClone(storage[key]);return out;},async set(values){Object.assign(storage,structuredClone(values));}};
 const chrome={
  storage:{local,session:{async get(key){return {[key]:structuredClone(sessionStore[key])};},async set(values){Object.assign(sessionStore,structuredClone(values));}}},
  runtime:{onMessage:{addListener(fn){handler=fn;}},async sendMessage(msg){broadcasts.push(structuredClone(msg));},connectNative(){throw new Error('native not needed');},getURL(path){return `chrome-extension://${path}`;}},
  sidePanel:{setPanelBehavior:async()=>{}},
  windows:{onRemoved:{addListener(){}},async create(){return {id:99};}},
  tabs:{onUpdated:{addListener(){}},onRemoved:{addListener(){}},async query(){return[];},async get(){throw new Error('not needed');}},
 };
 vm.runInNewContext(code,{translationCandidates,chrome,setTimeout,clearTimeout,URL,URLSearchParams,console,structuredClone,crypto:undefined,Math});
 const call=(msg,sender={})=>new Promise(resolve=>handler(msg,sender,resolve));
 return {storage,call,broadcasts};
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
