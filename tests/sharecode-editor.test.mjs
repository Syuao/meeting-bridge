import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {shareCodeEditor} from '../extension/sharecode-editor.js';
function setup(initial='Existing room text'){
 let value=initial,serial=0,readonly=false;const decorations=new Map(),edits=[],disposed=new Set(),disposeCallbacks=new Map();const root={};
 const pos=o=>{const parts=value.slice(0,o).split('\n');return{lineNumber:parts.length,column:parts.at(-1).length+1}};
 const offset=p=>value.split('\n').slice(0,p.lineNumber-1).reduce((n,s)=>n+s.length+1,0)+p.column-1;
 const bounds=r=>[offset({lineNumber:r.startLineNumber,column:r.startColumn}),offset({lineNumber:r.endLineNumber,column:r.endColumn})];
 const range=(a,b)=>{const x=pos(a),y=pos(b);return{startLineNumber:x.lineNumber,startColumn:x.column,endLineNumber:y.lineNumber,endColumn:y.column}};
 let model={isDisposed(){return disposed.has(this)},getValue:()=>value,onWillDispose(fn){const self=this;disposeCallbacks.set(self,fn);return {dispose:()=>disposeCallbacks.delete(self)}},getValueLength:()=>value.length,getPositionAt:pos,getOffsetAt:offset,getValueInRange:r=>{const[a,b]=bounds(r);return value.slice(a,b)},getDecorationRange:id=>{const r=decorations.get(id);return r?range(...r):null},deltaDecorations(old,next){old.forEach(id=>decorations.delete(id));return next.map(d=>{const id=String(++serial);decorations.set(id,bounds(d.range));return id})}};
 const editor={getModel:()=>model,getDomNode:()=>root,getRawOptions:()=>({readOnly:readonly}),executeEdits(source,changes){edits.push(changes);for(const c of changes){const[a,b]=bounds(c.range),delta=c.text.length-(b-a);value=value.slice(0,a)+c.text+value.slice(b);for(const [id,[x,y]] of decorations){decorations.set(id,[a<=x?x+delta:x,a<y?y+delta:y])}}return true}};
 const context=vm.createContext({location:{href:'https://kode666.com/room/test'},URL,crypto,document:{querySelectorAll:s=>s==='.monaco-editor'?[root]:[]},monaco:{editor:{getEditors:()=>[editor]}}});
 const run=request=>vm.runInContext('('+shareCodeEditor.toString()+')(request)',vm.createContext({...context,request}));
 // Keep one MAIN-world global across calls.
 const call=request=>{context.request={roomKey:'https://kode666.com/room/test',...request};return vm.runInContext('('+shareCodeEditor.toString()+')(request)',context)};
 const token=call({action:'probe'}).documentToken;
 return {call:r=>call({documentToken:token,action:'write',revision:1,...r}),value:()=>value,edit:(a,b,text)=>editor.executeEdits('human',[{range:range(a,b),text}]),readonly:()=>{readonly=true},remount(content=value){disposeCallbacks.get(model)?.();disposed.add(model);model={...model};decorations.clear();value=content;},edits};
}
test('streaming updates only one appended answer, retains code and never replaces room contents',()=>{
 const app=setup();assert.ok(app.call({id:'a',text:'Hello'}).ok);assert.equal(app.value(),'Existing room text\nHello');
 assert.ok(app.call({id:'a',text:'Hello world\nSELECT 1;',revision:2}).ok);
 assert.equal(app.value(),'Existing room text\nHello world\nSELECT 1;');
 assert.equal(app.edits.at(-1)[0].text,' world\nSELECT 1;');
 app.call({id:'a',text:'Old stale update',revision:1});assert.ok(!app.value().includes('stale'));
 app.call({id:'b',text:'Next selection'});assert.ok(app.value().endsWith('\nNext selection'));
});
test('editing the synchronized paragraph pauses instead of overwriting the change',()=>{
 const app=setup();app.call({id:'a',text:'Hello'});app.edit(app.value().length-2,app.value().length,'YY');
 const before=app.value();assert.match(app.call({id:'a',text:'Hello world',revision:2}).message,/手工修改/);assert.equal(app.value(),before);
});
test('edits elsewhere in the room are preserved while the stream continues',()=>{
 const app=setup();app.call({id:'a',text:'Hello'});app.edit(0,0,'Note\n');
 assert.ok(app.call({id:'a',text:'Hello world',revision:2}).ok);assert.equal(app.value(),'Note\nExisting room text\nHello world');
});
test('a changed room, reloaded document or read-only editor never receives text',()=>{
 const app=setup();const before=app.value();
 assert.equal(app.call({id:'a',text:'x',roomKey:'https://kode666.com/room/other'}).ok,false);
 assert.equal(app.call({id:'a',text:'x',documentToken:'old'}).ok,false);
 app.readonly();assert.equal(app.call({id:'a',text:'x'}).ok,false);assert.equal(app.value(),before);
});
test('both streaming and selected excerpts omit blank lines while preserving code indentation',()=>{
 const app=setup('Existing\n');app.call({id:'a',text:'\nHeading\n\n\nSELECT\n    user_id\n  \nFROM users;\n'});
 assert.equal(app.value(),'Existing\nHeading\nSELECT\n    user_id\nFROM users;');
 app.call({id:'a',revision:2,text:'Heading\n\nSELECT\n    user_id\n\nFROM users;\n\nDone'});
 app.call({id:'manual',text:'Selected\n\nwords'});
 assert.equal(app.value(),'Existing\nHeading\nSELECT\n    user_id\nFROM users;\nDone\nSelected\nwords');
});

test('switching language and recreating the model preserves binding and streaming ranges',()=>{
 const app=setup();app.call({id:'a',text:'Half'});app.edit(0,0,'Collaborator note\n');app.remount();
 assert.equal(app.call({id:'a',text:'Half an answer',revision:2}).ok,true);
 assert.equal(app.value(),'Collaborator note\nExisting room text\nHalf an answer');
 assert.equal(app.call({id:'manual',text:'Selected next'}).ok,true);
 assert.ok(app.value().endsWith('Half an answer\nSelected next'));
});
test('model recreation with changed content cannot overwrite or duplicate the old stream',()=>{
 const app=setup();app.call({id:'a',text:'Old answer'});app.remount('Different room document text');
 const before=app.value();assert.equal(app.call({id:'a',text:'Old answer continued',revision:2}).ok,false);assert.equal(app.value(),before);
 assert.equal(app.call({id:'new-selection',text:'New selected text'}).ok,true);
 assert.equal(app.value(),'Different room document text\nNew selected text');
});
