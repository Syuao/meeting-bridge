import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {Schema} from 'prosemirror-model';
import {EditorState} from 'prosemirror-state';
import {shareCodeEditor} from '../extension/sharecode-editor.js';
function setup(){
 const schema=new Schema({nodes:{doc:{content:'paragraph+'},paragraph:{content:'inline*',group:'block'},text:{group:'inline'},hardbreak:{inline:true,group:'inline'}}});
 const p=text=>schema.nodes.paragraph.create(null,text?schema.text(text):null);
 const root={};
 const view={dom:root,editable:true,state:EditorState.create({schema,doc:schema.nodes.doc.create(null,p('Existing text'))}),dispatch(tr){this.state=this.state.apply(tr)}};
 root.__reactFiber$test={memoizedState:{memoizedState:{current:{action:fn=>fn({get:key=>{assert.equal(key,'editorView');return view}})}}}};
 const context=vm.createContext({URL,crypto,location:{href:'https://kode666.com/room/test'},document:{querySelectorAll:s=>s==='.md-editor .ProseMirror'?[root]:[]}});
 const run=request=>{context.request={roomKey:context.location.href,...request};return vm.runInContext('('+shareCodeEditor.toString()+')(request)',context)};
 const token=run({action:'probe'}).documentToken;
 return {view,schema,p,call:r=>run({action:'write',documentToken:token,revision:1,...r}),text:()=>view.state.doc.textBetween(0,view.state.doc.content.size,'\n','\n')};
}
test('Markdown streams into one paragraph and keeps existing text and explicit line breaks',()=>{
 const s=setup();assert.equal(s.call({id:'a',text:'First'}).ok,true);
 assert.equal(s.call({id:'a',revision:2,text:'First line\n  code'}).ok,true);
 assert.equal(s.text(),'Existing text\nFirst line\n  code');assert.equal(s.view.state.doc.childCount,2);
 assert.equal(s.call({id:'manual',text:'Selected next'}).ok,true);
 assert.equal(s.text(),'Existing text\nFirst line\n  code\nSelected next');
 assert.equal(s.call({id:'a',revision:3,text:'First changed line\n  code'}).ok,true);
 assert.equal(s.text(),'Existing text\nFirst changed line\n  code\nSelected next');
});
test('Markdown updates follow their own paragraph after unrelated edits and protect manual changes',()=>{
 const s=setup();s.call({id:'a',text:'Live'});s.view.dispatch(s.view.state.tr.insert(0,s.p('Collaborator note')));
 assert.equal(s.call({id:'a',revision:2,text:'Live answer'}).ok,true);
 const last=s.view.state.doc.content.size-2;s.view.dispatch(s.view.state.tr.insertText('!',last));const before=s.text();
 assert.equal(s.call({id:'a',revision:3,text:'Live answer continued'}).ok,false);assert.equal(s.text(),before);
});
test('Markdown rejects stale page tokens, read-only pages and duplicate revisions',()=>{
 const s=setup();assert.equal(s.call({id:'a',text:'No',documentToken:'stale'}).ok,false);
 s.view.editable=false;assert.equal(s.call({id:'a',text:'No'}).ok,false);s.view.editable=true;
 s.call({id:'a',text:'Yes'});assert.equal(s.call({id:'a',text:'No'}).duplicate,true);assert.equal(s.text(),'Existing text\nYes');
});
