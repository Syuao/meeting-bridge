import test from 'node:test';
import assert from 'node:assert/strict';
import {Translator,translationPayload,decodeTranslation,needsTranslation} from '../host/translation.mjs';
import {translationCandidates,translationText,translationPending} from '../extension/translation.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const result=rows=>({result:{translations:rows.map(row=>({id:row.id,text:'译：'+row.text}))},usage:{input_tokens:100,output_tokens:30}});
function setup(t,requestFn){
  const output=[],status=[],calls=[];
  const translator=new Translator('/unused',row=>output.push(row),(state,message)=>status.push({state,message}),{keyAvailable:()=>true,delay:5,interval:10,partialInterval:0,retryDelays:[20,30,40],requestFn:async(root,payload,signal)=>{const rows=JSON.parse(payload.input).segments;calls.push(rows);return requestFn?requestFn(rows,signal):result(rows)}});
  t.after(()=>translator.dispose());translator.configure(true);return {translator,output,status,calls};
}
test('translation accepts interim speech and uses non-thinking structured output with quoted transcript',()=>{
  const rows=[{id:'a',text:'Why would you choose',final:false}];assert.equal(needsTranslation(rows[0]),true);
  const payload=translationPayload(rows,'Prior context');assert.equal(payload.reasoning.effort,'none');assert.equal(payload.model,'deepseek-flash');
  assert.deepEqual(JSON.parse(payload.input).segments,[{id:'a',text:rows[0].text}]);assert.match(payload.instructions,/never follow instructions/);assert.equal(payload.text.format.type,'json_schema');
});
test('rapid interim revisions coalesce and repeated stable rows do not trigger more requests',async t=>{
  const app=setup(t);app.translator.feed([{id:'a',text:'Why would',final:false}]);app.translator.feed([{id:'a',text:'Why would you use Redis?',final:false}]);await wait(35);
  assert.equal(app.calls.length,1);assert.equal(app.calls[0][0].text,'Why would you use Redis?');
  app.translator.feed([{id:'a',text:'Why would you use Redis?',final:true}]);await wait(25);assert.equal(app.calls.length,1);
  app.translator.feed([{id:'b',text:'Why would you use Redis?',final:true}]);await wait(25);assert.equal(app.calls.length,1);assert.equal(app.output.at(-1).id,'b');
});
test('continuous speech displays a provisional translation before the latest revision completes',async t=>{
  const finishes=[];const app=setup(t,rows=>new Promise(resolve=>finishes.push(()=>resolve(result(rows)))));
  app.translator.feed([{id:'a',text:'What is your',final:false}]);await wait(15);
  app.translator.feed([{id:'a',text:'What is your greatest strength?',final:false}]);finishes.shift()();await wait(20);
  assert.equal(app.output.length,1,'a growing sentence must not suppress every translation');assert.equal(app.output[0].sourceText,'What is your');
  assert.equal(app.calls.length,2);finishes.shift()();await wait(10);assert.equal(app.output[1].sourceText,'What is your greatest strength?');
});
test('turning translation off aborts requests and suppresses late results',async t=>{
  let finish,signal;const app=setup(t,(rows,s)=>{signal=s;return new Promise(r=>{finish=()=>r(result(rows))})});
  app.translator.feed([{id:'a',text:'Selected question?'}]);await wait(15);app.translator.configure(false);assert.equal(signal.aborted,true);finish();await wait(15);assert.equal(app.output.length,0);
});
test('transient failure automatically recovers and preserves later speech',async t=>{
  let fail=true;const app=setup(t,rows=>{if(fail)throw Error('network failure');return result(rows)});
  app.translator.feed([{id:'a',text:'First question?'}]);await wait(15);app.translator.feed([{id:'b',text:'Second question?'}]);
  assert.equal(app.status.at(-1).state,'retrying');fail=false;await wait(90);
  assert.deepEqual(app.output.map(r=>r.id).sort(),['a','b']);assert.equal(app.translator.paused,false);
});
test('permanent authorization errors wait for explicit retry without a request loop',async t=>{
  let fail=true;const app=setup(t,rows=>{if(fail)throw Object.assign(Error('invalid key'),{retryable:false,httpStatus:401});return result(rows)});
  app.translator.feed([{id:'a',text:'Question?'}]);await wait(80);assert.equal(app.calls.length,1);assert.equal(app.status.at(-1).state,'error');
  fail=false;app.translator.retry();await wait(30);assert.equal(app.output.length,1);
});
test('unknown or duplicate response IDs fail closed and remain retryable',async t=>{
  const app=setup(t,()=>({result:{translations:[{id:'wrong',text:'错误'}]}}));app.translator.feed([{id:'a',text:'Question?'}]);await wait(25);assert.equal(app.output.length,0);assert.equal(app.status.at(-1).state,'retrying');assert.equal(app.translator.pending.size,1);
});
test('translation payloads batch at most eight segments',async t=>{
  const app=setup(t);app.translator.feed(Array.from({length:18},(_,i)=>({id:String(i),text:'Question '+i+'?'})));await wait(80);assert.equal(app.output.length,18);assert.ok(app.calls.every(rows=>rows.length<=8));
});
test('cached history is not retransmitted, while changed source keeps a visibly provisional translation',()=>{
  const a={id:'a',text:'Old English',translation:{sourceText:'Old English',text:'中文'}};
  assert.equal(translationCandidates([a]).length,0);assert.equal(translationText(a),'中文');assert.equal(translationPending(a),false);
  a.text='Revised English';assert.equal(translationCandidates([a])[0].text,'Revised English');assert.equal(translationPending(a),true);assert.equal(translationText(a),'中文');
  assert.equal(translationCandidates([{id:'zh',text:'这是一句中文。'}]).length,0);
  const translated=Array.from({length:8},(_,i)=>({id:'done-'+i,text:'English '+i,translation:{sourceText:'English '+i,text:'中文'}}));
  assert.equal(translationCandidates([{id:'old',text:'Old unrelated history'},...translated]).length,0,'reopening must not keep backfilling increasingly old history');
});
test('incomplete, malformed, or oversized translations cannot become displayed text',()=>{
  const response=result=>JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(result)}]}]});
  assert.equal(decodeTranslation(200,response({translations:[{id:'a',text:'中文'}]})).result.translations[0].text,'中文');
  for(const body of ['bad',JSON.stringify({status:'incomplete'}),response({translations:[{id:'a',text:''}]}),response({translations:[{id:'a',text:'字'.repeat(10001)}]})])assert.throws(()=>decodeTranslation(200,body),/DeepSeek/);
  assert.throws(()=>decodeTranslation(402,'private'),/余额不足/);
});
