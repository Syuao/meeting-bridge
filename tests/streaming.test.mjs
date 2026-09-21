import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import WebSocket,{WebSocketServer} from 'ws';
import {AlibabaASR,StreamingTranscript,runTask,ASR_MODEL,saveASRConfig,asrPublicConfig,readASRConfig,safeASRError} from '../host/aliyun-asr.mjs';
import {SemanticExtractor,saveKey,validateQuestions} from '../host/semantic.mjs';
const key='sk-'+('test-only-'.repeat(4));
const config={key,region:'beijing'};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const quote=text=>({source_ids:['s1'],quotes:[text],kind:'question',complete:true});

async function fixture(t,connected){
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
  t.after(()=>{for(const ws of server.clients)ws.terminate();server.close();});
  server.on('connection',connected);
  const address=`ws://127.0.0.1:${server.address().port}`;
  return class LocalSocket extends WebSocket {constructor(_url,options){super(address,options);}};
}
test('cloud configuration stays local, private and isolated from DeepSeek credentials',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mb-config-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  assert.equal(asrPublicConfig(root).configured,false);
  saveASRConfig(root,config);saveKey(root,key+'deepseek');
  assert.equal(fs.statSync(path.join(root,'aliyun-asr.json')).mode&0o777,0o600);
  assert.equal(readASRConfig(root).key,key);assert.equal(asrPublicConfig(root).region,'beijing');
  assert.equal(JSON.stringify(asrPublicConfig(root)).includes(key),false);
  assert.throws(()=>saveASRConfig(root,{key,region:'attacker.example'}));
  assert.throws(()=>saveASRConfig(root,{key:'account-password'}));
});
test('streaming request uses documented bilingual PCM and optional instant vocabulary',()=>{
  const task=runTask('test-task',{hotwords:'APS, TAM, APS，Redis'});
  assert.equal(task.payload.model,ASR_MODEL);assert.equal(task.payload.parameters.sample_rate,16000);
  assert.deepEqual(task.payload.parameters.language_hints,['en','zh']);
  assert.deepEqual(task.payload.parameters.vocabulary,{APS:2,TAM:2,Redis:2});
  assert.equal(task.payload.parameters.max_sentence_silence,500);
  assert.equal(task.payload.parameters.heartbeat,true);
});
test('real local WebSocket: wait for task-started, send binary audio, retain revisions and stop-time final',async t=>{
  const tracker=new StreamingTranscript('test'),rows=[],actions=[],audio=[];
  let ack=false;
  const WebSocketClass=await fixture(t,ws=>{
    ws.on('message',(data,binary)=>{
      if(binary){assert.ok(ack);audio.push(Buffer.from(data));return;}
      const msg=JSON.parse(data);actions.push(msg.header.action);const task_id=msg.header.task_id;
      const emit=(event,sentence)=>ws.send(JSON.stringify({header:{event,task_id},payload:{output:{sentence}}}));
      if(msg.header.action==='run-task')setTimeout(()=>{ack=true;emit('task-started');
        ws.send(JSON.stringify({header:{event:'result-generated',task_id:'foreign'},payload:{output:{sentence:{sentence_id:99,text:'MUST IGNORE'}}}}));
        emit('result-generated',{sentence_id:1,text:'How would you',sentence_end:false});
        emit('result-generated',{sentence_id:1,text:'How would you design a cache?',sentence_end:false});
        emit('result-generated',{sentence_id:0,text:'',heartbeat:true});
      },30);
      if(msg.header.action==='finish-task'){
        emit('result-generated',{sentence_id:1,text:'How would you design a cache?',sentence_end:true});
        emit('task-finished');
      }
    });
  });
  const client=new AlibabaASR(config,{WebSocketClass,onSentence:s=>{const row=tracker.accept(s);if(row)rows.push(row);}});t.after(()=>client.abort());
  client.push(Buffer.alloc(3200,1));await client.start();client.push(Buffer.alloc(3200,2));
  await pause(25);await client.finish();
  assert.deepEqual(actions,['run-task','finish-task']);assert.equal(audio.length,2);assert.equal(audio[0].length,3200);
  assert.equal(rows.length,3);assert.equal(new Set(rows.map(x=>x.id)).size,1);assert.equal(rows.at(-1).final,true);
  assert.equal(tracker.recent().length,1);assert.equal(client.phase,'closed');
  assert.equal(tracker.accept({sentence_id:1,text:'late broken partial',sentence_end:false}),null);
});
test('a server failure is redacted and does not wait indefinitely for audio or completion',async t=>{
  const errors=[];
  const WebSocketClass=await fixture(t,ws=>ws.on('message',data=>{const msg=JSON.parse(data);ws.send(JSON.stringify({header:{task_id:msg.header.task_id,event:'task-failed',error_code:'InvalidApiKey',error_message:'secret '+key}}));}));
  const client=new AlibabaASR(config,{WebSocketClass,onError:e=>errors.push(e.message)});
  await assert.rejects(client.start(),/密钥/);assert.equal(errors.length,1);assert.equal(errors.join().includes(key),false);
  assert.equal(safeASRError('429').message.includes('限流'),true);
});
test('missing start acknowledgement and excessive audio backlog have bounded failure paths',async t=>{
  const WebSocketClass=await fixture(t,()=>{});
  const client=new AlibabaASR(config,{WebSocketClass,startTimeout:80});
  await assert.rejects(client.start(),/超时/);assert.equal(client.phase,'failed');
  const errors=[],queued=new AlibabaASR(config,{onError:e=>errors.push(e.message)});
  for(let i=0;i<101;i++)queued.push(Buffer.alloc(3200));
  assert.equal(queued.phase,'failed');assert.equal(queued.queuedBytes,0);assert.match(errors[0],/10 秒/);
});
test('ongoing speech does not postpone semantic extraction; new updates coalesce during a request',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mb-semantic-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));saveKey(root,key);
  const calls=[],questions=[];let complete;
  const extractor=new SemanticExtractor(root,q=>questions.push(q),()=>{},{requestFn:async(_root,payload)=>{
    calls.push(JSON.parse(payload.input));
    if(calls.length===1)await new Promise(r=>{complete=r;});
    return {result:{questions:[quote('Why Redis?')]}};
  }});t.after(()=>extractor.stop());
  const feed=text=>{const row={id:'s1',text};extractor.feed([row],[row]);};
  feed('Why Redis? I');
  const timer=setInterval(()=>feed('Why Redis? I would use it because it is fast.'),50);t.after(()=>clearInterval(timer));
  await pause(450);assert.equal(calls.length,1,'continuous revisions must not reset debounce');
  assert.equal(questions.length,0);complete();await pause(50);
  assert.equal(questions[0].text,'Why Redis?');
  await pause(850);assert.equal(calls.length,2);assert.equal(questions.length,1);
});
test('superseded interim words cannot be emitted from an older in-flight result',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mb-revision-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));saveKey(root,key);
  let complete;const questions=[];
  const extractor=new SemanticExtractor(root,q=>questions.push(q),()=>{},{requestFn:async()=>{await new Promise(r=>{complete=r;});return {result:{questions:[quote('Why Redis?')]}};}});t.after(()=>extractor.stop());
  extractor.feed([{id:'s1',text:'Why Redis?'}],[{id:'s1'}]);await pause(300);
  extractor.feed([{id:'s1',text:'Why Redshift?'}],[{id:'s1'}]);complete();await pause(30);
  assert.equal(questions.length,0);
  assert.deepEqual(validateQuestions({questions:[quote('Why Redis ?')]},[{id:'s1',text:'Why Redis ?'}],['s1'],[{source_ids:['s1'],text:'Why Redis?'}]),[]);
});
