import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs/promises';
const code=await fs.readFile(new URL('../extension/answer-source.js',import.meta.url),'utf8');
function setup(){
 let listener,mutation,busy=false,modernBusy=false,selection=null,clock=0,holdReplies=false,heartbeat,handshakeError=false,cleanupError=false;const pendingReplies=[],timers=new Map(),events={},sent=[],answers=[];
 class Text{constructor(text){this.nodeType=3;this.textContent=text;this.parentElement=null}}
 class Element{constructor(name='DIV',text=''){this.nodeType=1;this.nodeName=name;this.childNodes=text?[new Text(text)]:[];for(const n of this.childNodes)n.parentElement=this;this.style={};this.isAnswer=false;}matches(){return false}querySelector(){return null}querySelectorAll(){return this.markdown?[this.markdown]:[]}getAttribute(name){return name===(this.modern?'data-chatgpt-search-message-ids':'data-message-id')?this.id:null}closest(selector){return this.isAnswer&&selector.includes(this.modern?'data-content-search-unit-key':'data-message-author-role')?this:null}setAttribute(){}remove(){} }
 const root=new Element();root.append=()=>{};
 const document={body:root,querySelectorAll:selector=>answers.filter(n=>n.closest(selector)),querySelector:s=>s==='main'?root:busy&&(!modernBusy||s.includes('button[aria-label="停止"]'))?{}:null,getElementById:()=>null,createElement:()=>new Element(),addEventListener:(name,fn)=>{events[name]=fn},removeEventListener:(name)=>{delete events[name]}};
 const chrome={runtime:{onMessage:{addListener:fn=>{listener=fn},removeListener(){if(cleanupError)throw Error('Extension context invalidated.')}},async sendMessage(msg){if(msg.type==='answer_source_ready'){if(handshakeError)throw Error('Could not establish connection. Receiving end does not exist.');return{}}sent.push(msg);return holdReplies?new Promise(resolve=>pendingReplies.push(resolve)):{ok:true}}}};
 const context=vm.createContext({document,window:{getSelection:()=>selection},location:{href:'https://chatgpt.com/c/example'},MeetingBridgeSites:{key:u=>u},chrome,crypto,MutationObserver:class{constructor(fn){mutation=fn}observe(){}disconnect(){}},setTimeout:fn=>{const id=++clock;timers.set(id,fn);return id},clearTimeout:id=>timers.delete(id),setInterval:fn=>{heartbeat=fn;return 1},clearInterval(){heartbeat=null}});
 vm.runInContext(code,context);
 const reply=(id,text)=>{let n=answers.find(n=>n.id===id);if(!n){n=new Element();n.id=id;n.isAnswer=true;answers.push(n)}n.childNodes=[new Text(text)];n.childNodes[0].parentElement=n;mutation?.();return n};
 const mode=automatic=>listener({type:'answer_relay_config',enabled:true,automatic,epoch:'epoch-'+automatic,expectedKey:context.location.href},{},()=>{});
 const tick=async()=>{const run=[...timers.values()];timers.clear();run.forEach(fn=>fn());await new Promise(r=>setImmediate(r));};
 return {sent,reply,mode,tick,heartbeat:async fail=>{handshakeError=fail;assert.equal(typeof heartbeat,'function');await heartbeat()},invalidateCleanup:()=>{cleanupError=true},hold:()=>{holdReplies=true},release:async()=>{holdReplies=false;pendingReplies.splice(0).forEach(resolve=>resolve({ok:false}));await new Promise(r=>setImmediate(r))},reinject:()=>vm.runInContext(code,context),busy:(v,modern=false)=>{busy=v;modernBusy=modern;mutation?.()},submit:()=>events.click({isTrusted:true,target:{closest:s=>s.includes('button[aria-label="发送"]')?{}:null}}),modern(answer,text){answer.modern=true;answer.markdown=new Element('DIV',text);return answer},select(text,answer){selection={rangeCount:1,isCollapsed:false,getRangeAt:()=>({startContainer:answer.childNodes[0],endContainer:answer.childNodes[0],cloneContents:()=>({nodeType:11,childNodes:[new Text(text)]})})};events.pointerdown({button:0});events.pointerup();},disable:()=>listener({type:'answer_relay_config',enabled:false},{},()=>{})};
}
test('streaming source emits partial text before stop and updates the same record',async()=>{
 const s=setup();s.reply('old','Historical answer');s.mode(true);await s.tick();assert.equal(s.sent.length,0);
 s.busy(true);s.reply('new','Half');await s.tick();assert.equal(s.sent[0].text,'Half');
 s.reply('new','Half a streamed answer');await s.tick();assert.equal(s.sent[1].id,s.sent[0].id);assert.equal(s.sent[1].revision,2);
 s.busy(false);s.reply('new','Half a streamed answer.');await s.tick();assert.equal(s.sent.at(-1).text,'Half a streamed answer.');
});
test('enabling while generation is already active syncs the visible partial answer',async()=>{
 const s=setup();s.busy(true);s.reply('a','In progress');s.mode(true);await s.tick();assert.equal(s.sent[0].text,'In progress');
});
test('manual selection works during streaming and freezes the selected words before DOM replacement',async()=>{
 const s=setup();const answer=s.reply('a','The streamed answer');s.busy(true);s.mode(false);
 s.select('streamed',answer);s.reply('a','The streamed answer continued');await s.tick();assert.equal(s.sent[0].text,'streamed');assert.equal(s.sent[0].type,'answer_selection');
 s.select('continued',answer);await s.tick();assert.equal(s.sent.length,2);assert.notEqual(s.sent[0].id,s.sent[1].id);
});
test('switching off auto cancels a scheduled update, manual mode never mirrors unselected tokens',async()=>{
 const s=setup();s.mode(true);s.busy(true);const answer=s.reply('a','New answer');s.mode(false);await s.tick();assert.equal(s.sent.length,0);
 s.reply('a','New answer keeps streaming');await s.tick();assert.equal(s.sent.length,0);
 s.select('New answer',answer);s.disable();await s.tick();assert.equal(s.sent.length,0);
});
test('current ChatGPT search-unit markup supports streaming and manual selection',async()=>{
 const s=setup();s.mode(true);s.busy(true);const a=s.modern(s.reply('new','ChatGPT says: controls'),'Partial answer');await s.tick();assert.equal(s.sent[0].text,'Partial answer');
 s.mode(false);s.select('Partial',a);await s.tick();assert.equal(s.sent[1].text,'Partial');
});
test('reinjecting the same version replaces stale listeners without double delivery',async()=>{
 const s=setup();const a=s.reply('a','Select me');s.mode(false);s.reinject();s.mode(false);s.select('Select me',a);await s.tick();assert.equal(s.sent.length,1);
});
test('current localized stop control starts streaming without a legacy test id',async()=>{
 const s=setup();s.reply('old','Old');s.mode(true);s.busy(true,true);s.modern(s.reply('new','New'),'Partial');await s.tick();assert.equal(s.sent[0].text,'Partial');
});
test('current localized send control captures very fast answers with no observed stop control',async()=>{
 const s=setup();s.reply('old','Old');s.mode(true);s.submit();s.modern(s.reply('new','New'),'Fast');await s.tick();assert.equal(s.sent[0].text,'Fast');
});
test('streamed and selected text retain line breaks without extra empty lines',async()=>{
 const s=setup();s.mode(true);s.busy(true);const a=s.reply('new','Heading\n\n  code\n \nMore');await s.tick();assert.equal(s.sent[0].text,'Heading\n  code\nMore');
 s.mode(false);s.select('First\n\nSecond',a);await s.tick();assert.equal(s.sent[1].text,'First\nSecond');
});
test('a late failure from automatic mode cannot disable newly enabled manual mode',async()=>{
 const s=setup();s.mode(true);s.hold();s.busy(true);const a=s.reply('a','Live answer');await s.tick();
 s.mode(false);await s.release();s.select('Live',a);await s.tick();assert.equal(s.sent.at(-1).type,'answer_selection');
});
test('a transient heartbeat error preserves selection listeners and retries the connection',async()=>{
 const s=setup();const a=s.reply('a','Keep selecting');s.mode(false);await s.tick();
 await s.heartbeat(true);await s.heartbeat(false);
 s.select('Keep selecting',a);await s.tick();assert.equal(s.sent.length,1);assert.equal(s.sent[0].text,'Keep selecting');
});
test('reconnection replaces an invalidated runtime even when removing its old listener throws',async()=>{
 const s=setup();const a=s.reply('a','Reconnected');s.mode(false);s.invalidateCleanup();
 assert.doesNotThrow(()=>s.reinject());s.mode(false);s.select('Reconnected',a);await s.tick();assert.equal(s.sent.length,1);
});
