import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {apiResponseError,postJSON} from '../host/api-http.mjs';

test('Alibaba HTTP 400 Arrearage is a permanent billing error without echoing private response data',()=>{
  for(const body of [{error:{code:'Arrearage',message:'PRIVATE TRANSCRIPT AND TOKEN'}},{code:'Arrearage',message:'PRIVATE TRANSCRIPT AND TOKEN'}]){
    const error=apiResponseError('Qwen-MT',400,JSON.stringify(body));
    assert.equal(error.code,'account_arrearage');assert.equal(error.retryable,false);assert.equal(error.httpStatus,400);
    assert.match(error.message,/欠费.*Arrearage/);assert.doesNotMatch(error.message,/PRIVATE|TOKEN/);
    assert.match(error.recoveryHint,/重试/);
  }
  for(const body of ['bad',{error:{code:'SECRET',message:'PRIVATE'}}].map(x=>typeof x==='string'?x:JSON.stringify(x))){
    const error=apiResponseError('Qwen-MT',400,body);assert.equal(error.code,'http');assert.doesNotMatch(error.message,/SECRET|PRIVATE/);
  }
});
test('HTTP transport retains the provider billing code from a 400 JSON body',async t=>{
  const server=http.createServer((req,res)=>{req.resume();res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:'Arrearage',message:'PRIVATE'}}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  await assert.rejects(postJSON({endpoint:`http://127.0.0.1:${server.address().port}/`,key:'test-only',payload:{text:'synthetic'},provider:'Qwen-MT'}),e=>e.code==='account_arrearage'&&e.httpStatus===400&&!e.message.includes('PRIVATE'));
});
