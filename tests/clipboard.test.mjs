import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
const code=(await fs.readFile(new URL('../extension/clipboard.js',import.meta.url),'utf8')).replace('export async function','async function');
function setup(write,{fallback=true}={}){
  let handler;const copied=[];
  const document={addEventListener(type,fn){assert.equal(type,'copy');handler=fn},removeEventListener(){handler=null},execCommand(type){assert.equal(type,'copy');if(fallback)handler({clipboardData:{setData(type,text){copied.push({type,text})}},preventDefault(){}});return fallback}};
  const context=vm.createContext({navigator:{clipboard:{writeText:write}},document});vm.runInContext(code,context);
  return {copy:context.writeClipboard,copied,handler:()=>handler};
}
test('automatic clipboard writes start immediately in the completed gesture',async()=>{
  const values=[];const app=setup(text=>{values.push(text);return Promise.resolve()});const promise=app.copy('Selected question?');
  assert.deepEqual(values,['Selected question?']);assert.equal(await promise,true);assert.equal(app.copied.length,0);
});
test('clipboard denial falls back to a copy event without changing selection or focus',async()=>{
  const app=setup(()=>Promise.reject(Error('not focused')));assert.equal(await app.copy('Exact text'),true);
  assert.deepEqual(app.copied,[{type:'text/plain',text:'Exact text'}]);assert.equal(app.handler(),null);
});
test('failed clipboard writes report failure so draft filling can continue independently',async()=>{
  const app=setup(()=>Promise.reject(Error('denied')),{fallback:false});assert.equal(await app.copy('Question?'),false);assert.equal(app.handler(),null);
});
