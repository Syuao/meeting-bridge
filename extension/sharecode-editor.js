// Runs in ShareCode's MAIN world, called only by the extension service worker.
// No remote code, network access, focus changes or clipboard operations.
export function shareCodeEditor(request) {
  const roomKey = url => {
    try { const u = new URL(url); return u.origin === 'https://kode666.com' && /^\/room\/[a-zA-Z0-9-]+\/?$/.test(u.pathname) ? u.origin + u.pathname.replace(/\/$/, '') : ''; } catch { return ''; }
  };
  if (!request.roomKey || roomKey(location.href) !== request.roomKey) return {ok:false, message:'ShareCode 房间已切换，请重新绑定'};
  function findEditor() {
    const nodes = [...document.querySelectorAll('.monaco-editor')];
    const candidates = new Set();
    const add = value => {
      if (value && typeof value.getModel === 'function' && typeof value.executeEdits === 'function' && nodes.includes(value.getDomNode?.())) candidates.add(value);
    };
    for (const editor of globalThis.monaco?.editor?.getEditors?.() || []) add(editor);
    // ShareCode bundles Monaco as ES modules. Its editor ref belongs to the
    // React component containing the visible editor, not window.monaco.
    for (const node of nodes) {
      for (let element = node, depth = 0; element && depth < 5; element = element.parentElement, depth++) {
        const key = Object.keys(element).find(k => k.startsWith('__reactFiber$'));
        for (let fiber = key && element[key], count = 0; fiber && count < 30; fiber = fiber.return, count++) {
          for (let hook = fiber.memoizedState, i = 0; hook && i < 200; hook = hook.next, i++) add(hook.memoizedState?.current);
        }
      }
    }
    return candidates.size === 1 ? [...candidates][0] : null;
  }
  const editor = findEditor(), model = editor?.getModel();
  if (!model || model.isDisposed?.()) return {ok:false, message:'找不到 ShareCode 编辑器，请打开房间的「编辑器」视图'};
  if (editor.getRawOptions?.().readOnly !== false) return {ok:false, message:'ShareCode 当前不可编辑，请检查房间编辑权限和连接状态'};
  let bridge = globalThis.__meetingBridgeShareCode;
  if (!bridge || bridge.model !== model) {
    bridge = {model, token:crypto.randomUUID(), records:new Map()};
    globalThis.__meetingBridgeShareCode = bridge;
  }
  if (request.action === 'probe') return {ok:true, documentToken:bridge.token};
  if (request.documentToken !== bridge.token) return {ok:false, message:'ShareCode 页面已重新加载，请重新绑定房间后继续；未重复写入'};
  if (!/^[\w-]{1,180}$/.test(request.id || '') || typeof request.text !== 'string' || !request.text.trim() || request.text.length > 100000 || !Number.isSafeInteger(request.revision)) return {ok:false, message:'同步内容无效或超过 10 万字'};
  const id = request.id, text = request.text.replace(/\r\n?/g, '\n').split('\n').filter(line => line.trim()).join('\n');
  let record = bridge.records.get(id);
  if (record && request.revision <= record.revision) return {ok:true, duplicate:true};
  if (bridge.records.size >= 1000 && !record) return {ok:false, message:'本页同步条目已达上限，请重新加载并绑定房间'};
  let start, end, old = '';
  if (record) {
    const range = model.getDecorationRange(record.decoration);
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
  return {ok:true, characters:text.length};
}
