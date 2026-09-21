import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PROVIDER,buildPayload,decodeResponse,saveKey,hasKey,keyFile,testConnection} from '../host/semantic.mjs';

const question={source_ids:['s1'],quotes:['Why Redis?'],kind:'question',complete:true};
const completed=result=>JSON.stringify({status:'completed',output:[{type:'reasoning',content:[{type:'reasoning_text',text:'This is not response JSON.'}]},{type:'message',content:[{type:'output_text',text:JSON.stringify(result)}]}],usage:{input_tokens:50,output_tokens:20}});

test('DeepSeek request uses the current model, supported schema format, and disables thinking',()=>{
  assert.equal(PROVIDER.endpoint,'https://api.deepseek.com/responses');
  const segment={id:'s1',text:'Why Redis? Because we needed fast reads.'};
  const payload=buildPayload([segment],['s1']);
  assert.equal(payload.model,'deepseek-flash');assert.equal(payload.reasoning.effort,'none');
  assert.equal(payload.text.format.type,'json_schema');assert.equal(payload.text.format.schema.type,'object');
  assert.equal(payload.max_output_tokens,1200);assert.ok(!('store' in payload));
  assert.match(payload.instructions,/JSON/);assert.deepEqual(JSON.parse(payload.input).segments,[segment]);
});
test('parses only completed model output and preserves usage metrics',()=>{
  const parsed=decodeResponse(200,completed({questions:[question]}));
  assert.deepEqual(parsed.result,{questions:[question]});assert.equal(parsed.usage.input_tokens,50);
  assert.deepEqual(decodeResponse(200,completed({questions:[]})).result,{questions:[]});
});
test('truncated, empty, or malformed API results cannot enter the question queue',()=>{
  for(const body of ['not-json',JSON.stringify({status:'incomplete',output:[]}),JSON.stringify({status:'completed',output:[]}),completed(null),completed({questions:'wrong'}),completed({questions:[null]}),completed({questions:[{...question,quotes:[3]}]})])assert.throws(()=>decodeResponse(200,body),/DeepSeek/);
});
test('authentication, balance, and rate errors are actionable and do not echo raw API text',()=>{
  const privateBody='private server detail that must not be displayed';
  assert.throws(()=>decodeResponse(401,privateBody),/密钥无效/);
  assert.throws(()=>decodeResponse(402,privateBody),/余额不足/);
  assert.throws(()=>decodeResponse(429,privateBody),/限流/);
  try{decodeResponse(500,privateBody);}catch(e){assert.ok(!e.message.includes(privateBody));}
});
test('provider credentials stay separate and missing DeepSeek key prevents a live API test',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'meetingbridge-key-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const fake='sk-'+ 'unit_test_credential_not_real_123';
  fs.writeFileSync(path.join(root,'openai-key.json'),JSON.stringify({key:fake}));
  assert.equal(hasKey(root),false);
  await assert.rejects(testConnection(root),/DeepSeek API 密钥/);
  saveKey(root,fake);assert.equal(hasKey(root),true);assert.equal(path.basename(keyFile(root)),'deepseek-key.json');
  assert.equal(fs.statSync(keyFile(root)).mode&0o777,0o600);
  fs.chmodSync(keyFile(root),0o644);saveKey(root,fake);assert.equal(fs.statSync(keyFile(root)).mode&0o777,0o600);
  assert.throws(()=>saveKey(root,'a password'),/DeepSeek API 密钥/);
});
