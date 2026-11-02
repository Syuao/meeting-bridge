import test from 'node:test';
import assert from 'node:assert/strict';
import '../extension/sites.js';
import {createAnswerRelay,roomKey} from '../extension/answer-relay.js';
const source={tabId:7,url:'https://chatgpt.com/c/test'};
const room={id:8,url:'https://kode666.com/room/example?runner=right',title:'ShareCode'};
function setup({write,site=source.url,ack}={}){
 let config={},target={...source,url:site},sourceHealth,documentToken='document-1';const writes=[],statuses=[];
 const chrome={tabs:{async get(id){return id===8?room:{id:7,url:target.url}},async sendMessage(id,msg){if(msg.type==='answer_relay_config')sourceHealth={ok:true,...msg,sameConversation:true};return ack?ack(sourceHealth):sourceHealth}},scripting:{async executeScript(args){if(!args.func)return [];const request=args.args[0];if(request.action==='probe')return[{result:{ok:true,documentToken}}];writes.push(request);return[{result:write?await write(request):{ok:true}}]}}};
 const relay=createAnswerRelay({chrome,sites:globalThis.MeetingBridgeSites,sessionId:'test',getTarget:()=>target,getConfig:()=>config,saveConfig:async v=>{config=v},notify:s=>statuses.push(s)});
 const send=(text,id='answer1',revision=1,manual=false,extra={})=>relay.receive({type:manual?'answer_selection':'answer_update',text,id,revision,epoch:config.epoch,...extra},{tab:{id:7,url:target.url},url:target.url,frameId:0});
 return {relay,writes,statuses,send,config:()=>config,loseListener:()=>{sourceHealth=undefined},reloadRoom:()=>{documentToken='document-2'}};
}
test('ShareCode room keys ignore display options but reject unrelated pages and lookalike domains',()=>{
 assert.equal(roomKey(room.url),'https://kode666.com/room/example');
 for(const url of ['https://kode666.com/notifications','https://kode666.com.evil.test/room/x','http://kode666.com/room/x'])assert.equal(roomKey(url),'');
});
test('automatic mode writes partial answers immediately and manual mode works without ending generation',async()=>{
 const app=setup();await app.relay.bind(8,async()=>false);assert.equal(app.config().automatic,false);
 assert.equal((await app.send('Selected half sentence','manual1',1,true)).ok,true);
 assert.equal(app.writes.length,1);
 assert.equal((await app.send('automatic while off')).ok,false);
 await app.relay.setMode(true);
 await app.send('The first');assert.equal(app.writes.at(-1).text,'The first');
 await app.send('The first answer is streaming.','answer1',2);
 assert.equal(app.writes.at(-1).id,app.writes.at(-2).id);
 assert.equal((await app.send('manual while auto','m',1,true)).ok,false);
 await app.relay.setMode(false);await app.send('Another selected phrase','manual2',1,true);
 assert.equal(app.writes.at(-1).text,'Another selected phrase');
});
test('fast stream revisions coalesce during a slow write; selections remain separate',async()=>{
 let release;let count=0;
 const app=setup({write:()=>++count===1?new Promise(r=>{release=r}):{ok:true}});
 await app.relay.bind(8,async()=>false);await app.relay.setMode(true);
 const first=app.send('A');await new Promise(r=>setImmediate(r));
 await app.send('AB','answer1',2);await app.send('ABC','answer1',3);
 release({ok:true});await first;
 assert.deepEqual(app.writes.map(x=>x.text),['A','ABC']);
});
test('mode changes drop queued stream updates and reject old epochs',async()=>{
 let release;const app=setup({write:()=>new Promise(r=>{release=r})});
 await app.relay.bind(8,async()=>false);await app.relay.setMode(true);const epoch=app.config().epoch;
 const first=app.send('A');await new Promise(r=>setImmediate(r));await app.send('AB','answer1',2);
 await app.relay.setMode(false);release({ok:true});await first;
 assert.equal(app.writes.length,1);assert.equal((await app.send('stale','a',4,true,{epoch})).ok,false);
});
test('room conflict stops sync; reopening does not silently backfill historical replies',async()=>{
 const app=setup({write:()=>({ok:false,message:'同步段落已被手工修改'})});
 await app.relay.bind(8,async()=>false);assert.equal((await app.send('Selected','manual1',1,true)).ok,false);
 assert.equal(app.relay.sourceConfig().enabled,false);assert.match(app.statuses.at(-1).message,/手工修改/);
 await app.relay.restore();assert.equal(app.relay.sourceConfig().enabled,false);
});
test('rooms owned by another window cannot bind; unsupported answer providers fail explicitly',async()=>{
 const app=setup();await assert.rejects(app.relay.bind(8,async()=>true),/另一个窗口/);
 const ds=setup({site:'https://chat.deepseek.com/a/chat/s/a'});await assert.rejects(ds.relay.bind(8,async()=>false),/首版支持 ChatGPT/);
});
test('binding cannot report ready without acknowledgement of the exact source mode and epoch',async()=>{
 for(const ack of [()=>undefined,()=>({ok:true}),h=>({...h,enabled:false}),h=>({...h,epoch:'old'}),h=>({...h,automatic:!h.automatic})]){
   const app=setup({ack});await assert.rejects(app.relay.bind(8,async()=>false),/划词监听尚未连接/);
   assert.equal(app.relay.sourceConfig().enabled,false);assert.equal(app.statuses.at(-1).state,'paused');
 }
});
test('connection check verifies both source listener and room without writing any text',async()=>{
 const app=setup();await app.relay.bind(8,async()=>false);await app.relay.check();
 assert.equal(app.writes.length,0);assert.match(app.statuses.at(-1).message,/连接正常/);
 app.loseListener();await assert.rejects(app.relay.check(),/划词监听/);assert.equal(app.relay.sourceConfig().enabled,false);
 await app.relay.bind(8,async()=>false);app.reloadRoom();await assert.rejects(app.relay.check(),/重新加载/);
 assert.equal(app.writes.length,0);assert.equal(app.statuses.at(-1).state,'paused');
});

test('turning on automatic mode reconnects the current room document in the same action',async()=>{
 const app=setup();await app.relay.bind(8,async()=>false);app.reloadRoom();
 await app.relay.setMode(true);assert.equal(app.relay.sourceConfig().enabled,true);
 assert.equal(app.config().room.documentToken,'document-2');assert.equal((await app.send('Partial live answer')).ok,true);
 assert.equal(app.writes.length,1);
});
