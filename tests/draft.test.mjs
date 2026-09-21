import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
const code=await fs.readFile(new URL('../extension/sites.js',import.meta.url),'utf8')+'\n'+await fs.readFile(new URL('../extension/content.js',import.meta.url),'utf8');
function setup(initial='',url='https://chatgpt.com/'){
  let listener,current=initial,registrations=0;
  class Area{get value(){return current}set value(v){current=v}focus(){}dispatchEvent(){}getClientRects(){return [1]}}
  const area=new Area();
  const document={querySelectorAll:()=>[area],querySelector:()=>null};
  const chrome={runtime:{id:'test',onMessage:{addListener(fn){listener=fn;registrations++}},sendMessage:async()=>{}}};
  const context=vm.createContext({__meetingBridgeLoaded:true,document,chrome,URL,URLSearchParams,location:{href:url},HTMLTextAreaElement:Area,Event:class{},setTimeout,clearInterval(){},setInterval(){}});
  vm.runInContext(code,context);
  return {draft:()=>current,reinject:()=>vm.runInContext(code,context),registrations:()=>registrations,fill:(id,text,expectedKey=url)=>new Promise(resolve=>listener({type:'fill_question',id,text,expectedKey,autoSend:false},{},resolve))};
}
test('successive questions append in order without replacing an existing draft',async()=>{
  const page=setup('Please answer in English.');
  const first=await page.fill('one','What is a thread?');assert.equal(first.appended,true);
  await page.fill('two','How do you avoid deadlocks?');
  assert.equal(page.draft(),'Please answer in English.\n\nWhat is a thread?\n\nHow do you avoid deadlocks?');
  await page.fill('two','How do you avoid deadlocks?');
  assert.equal(page.draft().match(/deadlocks/g).length,1);
});
test('reconnection ignores a legacy loaded marker and repeated injection retains deduplication',async()=>{
  const page=setup('Existing draft.');await page.fill('one','Selected question?');page.reinject();
  await page.fill('one','Selected question?');assert.equal(page.registrations(),1);
  assert.equal(page.draft(),'Existing draft.\n\nSelected question?');
});

test('DeepSeek and Qwen selections append without sending or overwriting existing drafts',async()=>{
  for(const url of ['https://chat.deepseek.com/a/chat/s/example','https://qianwen.com/?sessionId=example','https://chat.qwen.ai/c/example']){
    const page=setup('My instructions.',url);const result=await page.fill('one','Question?');assert.equal(result.ok,true);assert.equal(result.sent,false);assert.equal(page.draft(),'My instructions.\n\nQuestion?');
    const blocked=await page.fill('two','Wrong destination?','https://chatgpt.com/');assert.equal(blocked.ok,false);assert.ok(!page.draft().includes('Wrong'));
  }
});
