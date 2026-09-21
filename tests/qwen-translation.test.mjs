import test from 'node:test';
import assert from 'node:assert/strict';
import {Translator} from '../host/translation.mjs';
import {createTranslationStream,qwenPayload} from '../host/qwen-translation.mjs';
import {apiError} from '../host/api-http.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const result=row=>({result:{translations:[{id:row.id,text:'译：'+row.text}]}});
test('Qwen MT streams fragmented SSE and usage without a JSON translation prompt',()=>{
  const updates=[],stream=createTranslationStream(t=>updates.push(t));
  const wire=[{choices:[{delta:{content:'你'}}]},{choices:[{delta:{content:'好吗？'},finish_reason:'stop'}]},{choices:[],usage:{prompt_tokens:30,completion_tokens:4}}].map(v=>'data: '+JSON.stringify(v)+'\r\n\r\n').join('')+'data: [DONE]\r\n\r\n';
  for(const ch of wire)stream.push(ch);
  assert.deepEqual(updates,['你','你好吗？']);assert.deepEqual(stream.result(),{text:'你好吗？',usage:{input_tokens:30,output_tokens:4}});
  const payload=qwenPayload('How are you?');assert.deepEqual(payload.messages,[{role:'user',content:'How are you?'}]);assert.equal(payload.translation_options.target_lang,'Chinese');assert.equal(payload.stream,true);
});
test('incomplete streams and output limits cannot be cached as completed translations',()=>{
  for(const finish of [null,'length']){const stream=createTranslationStream();try{stream.push('data: '+JSON.stringify({choices:[{delta:{content:'译文'},finish_reason:finish}]})+'\n\n');assert.throws(()=>stream.result());}catch(e){assert.match(e.message,/完整/);}}
});
test('long sequential workload recovers from repeated 429, timeout and server failures',async t=>{
  const output=[],states=[],attempts=new Map();let active=0,maxActive=0;
  const translator=new Translator('/unused',row=>output.push(row),(state,message,extra)=>states.push({state,...extra}),{keyAvailable:()=>true,delay:1,interval:1,partialInterval:0,retryDelays:[1,2,3],qwenRequestFn:async(root,row,signal,onText)=>{
    active++;maxActive=Math.max(maxActive,active);const attempt=(attempts.get(row.id)||0)+1;attempts.set(row.id,attempt);
    try{await wait(1);if(Number(row.id)%9===0&&attempt===1)throw apiError('Qwen-MT',Number(row.id)%18===0?429:503);if(row.id==='49'&&attempt<3)throw apiError('Qwen-MT',0,'timeout');onText('译');return result(row);}finally{active--;}
  }});
  t.after(()=>translator.dispose());translator.configure(true,'qwen-mt');translator.feed(Array.from({length:90},(_,i)=>({id:String(i),text:'Question '+i,final:true})));
  for(let i=0;i<150&&output.filter(x=>x.complete).length<90;i++)await wait(10);
  assert.equal(output.filter(x=>x.complete).length,90);assert.equal(maxActive,1);assert.equal(translator.pending.size,0);assert.equal(translator.paused,false);assert.ok(states.some(s=>s.httpStatus===429));assert.ok(states.some(s=>s.errorCode==='timeout'));
});
test('switching provider aborts old requests and ignores late streaming chunks',async t=>{
  let finish,oldSignal;const rows=[];
  const translator=new Translator('/unused',row=>rows.push(row),()=>{},{keyAvailable:()=>true,delay:1,interval:1,partialInterval:0,qwenRequestFn:(root,row,signal,chunk)=>{oldSignal=signal;return new Promise(resolve=>{finish=()=>{chunk('旧译文');resolve(result(row));}})},requestFn:async(root,payload)=>({result:{translations:JSON.parse(payload.input).segments.map(r=>({id:r.id,text:'DeepSeek 译文'}))}})});
  t.after(()=>translator.dispose());translator.configure(true,'qwen-mt');translator.feed([{id:'a',text:'Hello world'}]);await wait(10);translator.configure(true,'deepseek');assert.equal(oldSignal.aborted,true);finish();await wait(20);
  assert.deepEqual(rows.map(r=>r.text),['DeepSeek 译文']);
});
test('rapid interim changes coalesce while final speech bypasses interim cooldown',async t=>{
  const calls=[],output=[];const translator=new Translator('/unused',r=>output.push(r),()=>{},{keyAvailable:()=>true,delay:1,interval:1,partialInterval:100,qwenRequestFn:async(root,row)=>{calls.push(row.text);return result(row);}});
  t.after(()=>translator.dispose());translator.configure(true,'qwen-mt');translator.feed([{id:'a',text:'How do',final:false}]);await wait(10);
  for(let i=0;i<20;i++)translator.feed([{id:'a',text:'How do you '+i,final:false}]);await wait(20);assert.equal(calls.length,1);
  translator.feed([{id:'a',text:'How do you scale this?',final:true}]);
  // Reschedule an existing cooldown when final arrives.
  await wait(25);assert.equal(calls.length,2);assert.equal(output.at(-1).sourceText,'How do you scale this?');
});
