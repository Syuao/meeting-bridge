// Runs in ShareCode's MAIN world, called only by the extension service worker.
// No remote code, network access, focus changes or clipboard operations.
export function shareCodeEditor(request) {
  const roomKey = url => {
    try { const u = new URL(url); return u.origin === 'https://kode666.com' && /^\/room\/[a-zA-Z0-9-]+\/?$/.test(u.pathname) ? u.origin + u.pathname.replace(/\/$/, '') : ''; } catch { return ''; }
  };
  if (!request.roomKey || roomKey(location.href) !== request.roomKey) return {ok:false, message:'ShareCode 房间已切换，请重新绑定'};
  let documentBridge=globalThis.__meetingBridgeShareCodeDocument;
  if(!documentBridge||documentBridge.roomKey!==request.roomKey){
    const old=globalThis.__meetingBridgeShareCode;
    documentBridge={roomKey:request.roomKey,token:old?.roomKey===request.roomKey?old.token:crypto.randomUUID(),owners:new Map()};
    globalThis.__meetingBridgeShareCodeDocument=documentBridge;
  }
  function reactRefs(nodes,add){
    for(const node of nodes)for(let element=node,depth=0;element&&depth<8;element=element.parentElement,depth++){
      const key=Object.keys(element).find(k=>k.startsWith('__reactFiber$'));
      for(let fiber=key&&element[key],count=0;fiber&&count<40;fiber=fiber.return,count++){
        for(let hook=fiber.memoizedState,i=0;hook&&i<200;hook=hook.next,i++)add(hook.memoizedState?.current);
      }
    }
  }
  function markdownEditor(roots){
    const views=new Set();
    const add=value=>{
      if(!value)return;
      if(value.state?.doc&&typeof value.dispatch==='function'&&roots.includes(value.dom))views.add(value);
      if(typeof value.action==='function')try{add(value.action(ctx=>ctx.get('editorView')));}catch{}
    };
    reactRefs(roots,add);
    if(views.size!==1)return {ok:false,message:'Markdown 编辑器正在准备，请稍后再试',retryable:true};
    const view=[...views][0];
    if(view.isDestroyed||!view.editable)return {ok:false,message:'Markdown 当前不可编辑，请检查房间权限'};
    const {schema,doc}=view.state;
    const paragraph=schema.nodes.paragraph,br=schema.nodes.hardbreak||schema.nodes.hard_break;
    if(!paragraph||!br)return {ok:false,message:'Markdown 编辑器结构已变化，暂不能同步'};
    let bridge=globalThis.__meetingBridgeShareCodeMarkdown;
    if(!bridge||bridge.token!==documentBridge.token){bridge={token:documentBridge.token,records:new Map()};globalThis.__meetingBridgeShareCodeMarkdown=bridge;}
    if(request.action==='probe')return {ok:true,documentToken:bridge.token,editor:'markdown'};
    if(request.documentToken!==bridge.token)return {ok:false,message:'ShareCode 页面已重新加载，请重新连接'};
    if(!/^[\w-]{1,180}$/.test(request.id||'')||typeof request.text!=='string'||!request.text.trim()||request.text.length>100000||!Number.isSafeInteger(request.revision))return {ok:false,message:'同步内容无效或超过 10 万字'};
    if(documentBridge.owners.get(request.id)==='monaco')return {ok:false,message:'编辑器类型已切换，已保留此前回答；请在新回答或新划选中继续'};
    const text=request.text.replace(/\r\n?/g,'\n').split('\n').filter(line=>line.trim()).join('\n');
    const record=bridge.records.get(request.id);
    if(record&&request.revision<=record.revision)return {ok:true,duplicate:true};
    if(!record&&bridge.records.size>=1000)return {ok:false,message:'本页同步条目已达上限，请重新加载房间'};
    const inline=value=>{const result=[];value.split('\n').forEach((line,i)=>{if(i)result.push(br.create());if(line)result.push(schema.text(line));});return result;};
    let from=doc.content.size,to=from;
    const tr=view.state.tr;
    if(record){
      let found=-1;doc.forEach((node,pos)=>{if(node===record.node)found=pos;});
      if(found<0)return {ok:false,message:'同步段落已被修改或编辑器已重建，已暂停以保留修改'};
      from=found;to=from+record.node.nodeSize;
      let left=0,right=0;
      while(left<text.length&&left<record.text.length&&text[left]===record.text[left])left++;
      while(right<text.length-left&&right<record.text.length-left&&text[text.length-1-right]===record.text[record.text.length-1-right])right++;
      if(text===record.text){record.revision=request.revision;return {ok:true};}
      tr.replaceWith(from+1+left,from+1+record.text.length-right,inline(text.slice(left,text.length-right)));
      tr.setMeta('addToHistory',false);
    }else{
      if(doc.childCount===1&&doc.firstChild.type===paragraph&&!doc.firstChild.content.size){from=0;to=doc.content.size;}
      tr.replaceWith(from,to,paragraph.create(null,inline(text)));
    }
    view.dispatch(tr);
    const written=view.state.doc.nodeAt(from);
    if(!written||written.textBetween(0,written.content.size,'\n','\n')!==text)return {ok:false,message:'Markdown 写入结果无法确认，已暂停同步'};
    bridge.records.set(request.id,{node:written,text,revision:request.revision});documentBridge.owners.set(request.id,'markdown');
    return {ok:true,characters:text.length};
  }
  const markdownRoots=[...document.querySelectorAll('.md-editor .ProseMirror')];
  if(markdownRoots.length)return markdownEditor(markdownRoots);
  function findEditor() {
    const nodes = [...document.querySelectorAll('.monaco-editor')];
    const candidates = new Set();
    const add = value => {
      if (value && typeof value.getModel === 'function' && typeof value.executeEdits === 'function' && nodes.includes(value.getDomNode?.())) candidates.add(value);
    };
    for (const editor of globalThis.monaco?.editor?.getEditors?.() || []) add(editor);
    // ShareCode bundles Monaco as ES modules. Its editor ref belongs to the
    // React component containing the visible editor, not window.monaco.
    reactRefs(nodes,add);
    return candidates.size === 1 ? [...candidates][0] : null;
  }
  const editor = findEditor(), model = editor?.getModel();
  if (!model || model.isDisposed?.()) return {ok:false, message:'找不到 ShareCode 编辑器，请打开房间的「编辑器」视图',retryable:true};
  if (editor.getRawOptions?.().readOnly !== false) return {ok:false, message:'ShareCode 当前不可编辑，请检查房间编辑权限和连接状态'};
  let bridge = globalThis.__meetingBridgeShareCode;
  if (!bridge || bridge.roomKey !== request.roomKey) {
    bridge?.disposeWatch?.dispose();
    bridge = {roomKey:request.roomKey, model, token:documentBridge.token, records:new Map()};
    globalThis.__meetingBridgeShareCode = bridge;
  }
  const snapshot = () => {
    const previous=bridge.model;
    if(previous.isDisposed?.())return bridge.snapshot;
    const positions=new Map();
    for(const [id,record] of bridge.records){
      const range=record.decoration&&previous.getDecorationRange(record.decoration);
      if(range&&previous.getValueInRange(range)===record.text)positions.set(id,{
        start:previous.getOffsetAt({lineNumber:range.startLineNumber,column:range.startColumn}),
        end:previous.getOffsetAt({lineNumber:range.endLineNumber,column:range.endColumn})
      });
    }
    return {text:previous.getValue(),positions};
  };
  if(bridge.model!==model){
    // Changing the syntax language may replace Monaco's model without changing
    // the room/page. Keep the binding token and migrate only verified ranges.
    const saved=snapshot(),sameText=saved?.text===model.getValue();
    bridge.disposeWatch?.dispose();bridge.disposeWatch=null;
    for(const [id,record] of bridge.records){
      const position=sameText&&saved.positions.get(id);
      record.decoration=null;
      if(position){
        const a=model.getPositionAt(position.start),b=model.getPositionAt(position.end);
        [record.decoration]=model.deltaDecorations([],[{range:{startLineNumber:a.lineNumber,startColumn:a.column,endLineNumber:b.lineNumber,endColumn:b.column},options:{description:'Meeting Bridge answer',stickiness:1}}]);
      }
    }
    bridge.model=model;bridge.snapshot=null;
  }
  if(!bridge.disposeWatch&&model.onWillDispose)bridge.disposeWatch=model.onWillDispose(()=>{bridge.snapshot=snapshot();});
  if (request.action === 'probe') return {ok:true, documentToken:bridge.token};
  if (request.documentToken !== bridge.token) return {ok:false, message:'ShareCode 页面已重新加载，请重新绑定房间后继续；未重复写入'};
  if(documentBridge.owners.get(request.id)==='markdown')return {ok:false,message:'编辑器类型已切换，已保留此前回答；请在新回答或新划选中继续'};
  if (!/^[\w-]{1,180}$/.test(request.id || '') || typeof request.text !== 'string' || !request.text.trim() || request.text.length > 100000 || !Number.isSafeInteger(request.revision)) return {ok:false, message:'同步内容无效或超过 10 万字'};
  const id = request.id, text = request.text.replace(/\r\n?/g, '\n').split('\n').filter(line => line.trim()).join('\n');
  let record = bridge.records.get(id);
  if (record && request.revision <= record.revision) return {ok:true, duplicate:true};
  if (bridge.records.size >= 1000 && !record) return {ok:false, message:'本页同步条目已达上限，请重新加载并绑定房间'};
  let start, end, old = '';
  if (record) {
    const range = record.decoration&&model.getDecorationRange(record.decoration);
    if (!range || model.getValueInRange(range) !== record.text) return {ok:false, message:'同步段落已被手工修改，已暂停，避免覆盖修改'};
    start = model.getOffsetAt({lineNumber:range.startLineNumber,column:range.startColumn});
    end = model.getOffsetAt({lineNumber:range.endLineNumber,column:range.endColumn});
    old = record.text;
  } else {
    start = end = model.getValueLength();
  }
  const last = model.getPositionAt(Math.max(0,start-1)), tail = model.getPositionAt(start);
  const endsWithNewline = start && model.getValueInRange({startLineNumber:last.lineNumber,startColumn:last.column,endLineNumber:tail.lineNumber,endColumn:tail.column}) === '\n';
  const prefix = record ? record.prefix : (start && !endsWithNewline ? '\n' : '');
  const next = prefix + text;
  if (old === next) { record.revision = request.revision; return {ok:true}; }
  // Replace only the changed suffix/interior, keeping collaborative cursors and
  // the rest of the room intact even during fast token streaming.
  let left = 0, right = 0;
  while (left < old.length && left < next.length && old[left] === next[left]) left++;
  while (right < old.length-left && right < next.length-left && old[old.length-1-right] === next[next.length-1-right]) right++;
  const from = model.getPositionAt(start+left), to = model.getPositionAt(end-right);
  const range = {startLineNumber:from.lineNumber,startColumn:from.column,endLineNumber:to.lineNumber,endColumn:to.column};
  const accepted = editor.executeEdits('meeting-bridge', [{range,text:next.slice(left,next.length-right),forceMoveMarkers:true}]);
  if (accepted === false) return {ok:false, message:'ShareCode 编辑器拒绝写入，请检查编辑权限'};
  const a = model.getPositionAt(start), b = model.getPositionAt(start+next.length);
  const whole = {startLineNumber:a.lineNumber,startColumn:a.column,endLineNumber:b.lineNumber,endColumn:b.column};
  if (model.getValueInRange(whole) !== next) return {ok:false, message:'ShareCode 写入结果无法确认，已暂停同步'};
  const [decoration] = model.deltaDecorations(record ? [record.decoration] : [], [{range:whole,options:{description:'Meeting Bridge answer',stickiness:1}}]);
  bridge.records.set(id,{decoration,prefix,text:next,revision:request.revision});
  documentBridge.owners.set(id,'monaco');
  return {ok:true, characters:text.length};
}
