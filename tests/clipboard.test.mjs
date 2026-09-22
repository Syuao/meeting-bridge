import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
const code=(await fs.readFile(new URL('../extension/clipboard.js',import.meta.url),'utf8')).replace('export async function','async function');
function setup(write,{fallback=true,accepted=fallback}={}){
  let handler;const copied=[];
  const document={addEventListener(type,fn){assert.equal(type,'copy');handler=fn},removeEventListener(){handler=null},execCommand(type){assert.equal(type,'copy');if(fallback)handler({clipboardData:{setData(type,text){copied.push({type,text})}},preventDefault(){}});return accepted}};
  const context=vm.createContext({navigator:{clipboard:{writeText:write}},document});vm.runInContext(code,context);
  return {copy:context.writeClipboard,copied,handler:()=>handler};
}
test('synchronous copy completes in the gesture before another page can take focus',async()=>{
  const values=[];const app=setup(text=>{values.push(text);return Promise.resolve()});const promise=app.copy('Selected question?');
  assert.deepEqual(app.copied,[{type:'text/plain',text:'Selected question?'}]);assert.equal(values.length,0);assert.equal(await promise,true);assert.equal(app.handler(),null);
});
test('Async Clipboard is a fallback when the synchronous command is unavailable',async()=>{
  const values=[];const app=setup(text=>{values.push(text);return Promise.resolve()},{fallback:false});assert.equal(await app.copy('Exact text'),true);
  assert.deepEqual(values,['Exact text']);assert.equal(app.handler(),null);
});
test('a dispatched copy event is not success when the browser rejects the command',async()=>{
  const app=setup(()=>Promise.reject(Error('denied')),{fallback:true,accepted:false});
  assert.equal(await app.copy('Do not report a false success'),false);
  assert.equal(app.handler(),null);
});
test('failed clipboard writes report failure so draft filling can continue independently',async()=>{
  const app=setup(()=>Promise.reject(Error('denied')),{fallback:false});assert.equal(await app.copy('Question?'),false);assert.equal(app.handler(),null);
});
