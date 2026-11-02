(() => {
  if(globalThis.__meetingBridgeReceiver?.version==='0.9.0')return;
  const applied=globalThis.__meetingBridgeReceiver?.applied||new Set();
  globalThis.__meetingBridgeReceiver?.cleanup?.();
  const visible=el=>!!el && !!(el.offsetWidth||el.offsetHeight||el.getClientRects().length);
  const editables='textarea,[contenteditable="true"],[contenteditable="plaintext-only"]';
  const label=el=>['placeholder','aria-label','data-placeholder'].map(name=>el.getAttribute?.(name)||'').join(' ');
  const writable=el=>!!el&&(el instanceof HTMLTextAreaElement||el.isContentEditable)&&!el.disabled&&!el.readOnly&&el.getAttribute?.('aria-disabled')!=='true'&&
    !el.closest?.('[hidden],[inert],[aria-hidden="true"],.monaco-editor,.cm-editor,[role="search"]')&&!/search|搜索|编辑代码|code editor/i.test(label(el))&&visible(el);
  const editor=el=>writable(el)?el:[...(el?.querySelectorAll?.(editables)||[])].find(writable);
  const Sites=globalThis.MeetingBridgeSites;
  const currentSite=()=>Sites?.site(location.href);
  const composer=()=>{
    const provider=currentSite();if(!provider)return null;
    for(const selector of provider.selectors){const matches=[...new Set([...document.querySelectorAll(selector)].map(editor).filter(Boolean))];if(matches.length===1)return matches[0];}
    const candidates=[...document.querySelectorAll(editables)].filter(writable).filter(el=>!el.parentElement?.closest('[contenteditable="true"],[contenteditable="plaintext-only"]'));
    // Chat pages also contain editable code blocks, search boxes and message edits.
    // Prefer the labelled chat composer rather than requiring just one textbox.
    const named=candidates.filter(el=>/ChatGPT|DeepSeek|Qwen|千问|询问|问问|发送消息|Ask anything|Message (?:ChatGPT|DeepSeek|Qwen)/i.test(label(el)));
    if(named.length===1)return named[0];
    return candidates.length===1?candidates[0]:null;
  };
  const text=el=>('value' in el?el.value:el.innerText||el.textContent||'').trim();
  const busy=()=>!!document.querySelector('[data-testid="stop-button"],button[aria-label="Stop streaming"],button[aria-label="停止流式传输"],button[aria-label="停止生成"],button[aria-label="Stop generating"],button[title="停止生成"]');
  const normalized=s=>s.replace(/\s+/g,' ').trim();
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  let filling=false;
  async function fill(msg) {
    if(applied.has(msg.id))return {ok:true,sent:false,message:'此问题已填入，未重复追加'};
    if(filling)return {ok:false,message:'正在填入上一条问题'};
    if((!msg.expectedKey||Sites?.key(location.href)!==msg.expectedKey))return {ok:false,message:'对话地址已变化，请重新绑定'};
    if(busy())return {ok:false,message:'等待当前对话完成回答'};
    if(typeof msg.text!=='string'||!msg.text.trim()||msg.text.length>10000)return {ok:false,message:'问题内容无效'};
    filling=true;
    try {
      let el=composer();
      // SPA navigation can briefly remove/disable the editor. Yield to the page,
      // then locate the replacement; never reuse a detached element or new chat.
      for(let i=0;!el&&i<3;i++){
        await wait(120);
        if(Sites?.key(location.href)!==msg.expectedKey)return {ok:false,message:'对话地址已变化，请重新绑定'};
        if(busy())return {ok:false,message:'等待当前对话完成回答'};
        el=composer();
      }
      if(!el)return {ok:false,message:'输入框暂未就绪，正在自动重试；请确认已打开绑定的对话'};
      const before='value' in el?el.value:el.innerText||el.textContent||'';
      const appended=!!before.trim();
      const addition=(appended?'\n\n':'')+msg.text.trim();
      const expected=before+addition;
      el.focus({preventScroll:true});
      if(el instanceof HTMLTextAreaElement) {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,expected);
        el.dispatchEvent(new Event('input',{bubbles:true}));
      } else {
        const selection=window.getSelection(),range=document.createRange();range.selectNodeContents(el);range.collapse(false);selection.removeAllRanges();selection.addRange(range);
        if(!document.execCommand('insertText',false,addition))return {ok:false,message:'网页编辑器不接受输入，请复制问题后粘贴'};
      }
      // Record insertion immediately so retries cannot append the same question twice.
      applied.add(msg.id);if(applied.size>1000)applied.delete(applied.values().next().value);
      await wait(180);
      if(normalized(text(el))===normalized(before)){applied.delete(msg.id);return {ok:false,message:'网页未保留输入，请复制后粘贴，或刷新页面后重试'};}
      if(normalized(text(el))!==normalized(expected))return {ok:true,sent:false,appended,message:'已执行填入；草稿随后有变化，请检查内容'};
      if(!msg.autoSend||appended||currentSite()?.id!=='chatgpt')return {ok:true,sent:false,appended,message:appended?'已追加到现有草稿末尾':''};
      // Re-check both draft and destination immediately before an explicit opt-in send.
      if((!msg.expectedKey||Sites?.key(location.href)!==msg.expectedKey) || busy())return {ok:true,sent:false,message:'已填入；对话状态变化，未自动发送'};
      let button;
      for(let i=0;i<12;i++) {button=document.querySelector('[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label="发送提示"]');if(button&&!button.disabled)break;await wait(150);}
      if(!button||button.disabled||normalized(text(el))!==normalized(msg.text))return {ok:true,sent:false,message:'已填入，请手动发送'};
      button.click();
      for(let i=0;i<15;i++){await wait(200);if(!text(el)||busy())return {ok:true,sent:true};}
      return {ok:true,sent:false,message:'发送状态未确认，请检查页面'};
    } finally {filling=false;}
  }
  const listener=(msg,sender,reply)=>{
    if(msg.type==='probe_composer'){const same=Sites?.key(location.href)===msg.expectedKey;reply({version:'0.9.0',ready:same&&!!composer(),sameConversation:same});return false;}
    if(msg.type!=='fill_question')return false;fill(msg).then(reply).catch(e=>reply({ok:false,message:e.message}));return true;
  };
  chrome.runtime.onMessage.addListener(listener);
  // Only a queued fill needs DOM inspection. Idle tabs no longer scan the whole
  // conversation (or force layout) on every heartbeat.
  const readyTimer=setInterval(()=> {try{if(!chrome.runtime?.id){clearInterval(readyTimer);return;}if(!filling)chrome.runtime.sendMessage({type:'composer_ready'}).catch(()=>{});}catch{clearInterval(readyTimer);}},1200);
  globalThis.__meetingBridgeReceiver={version:'0.9.0',applied,cleanup(){clearInterval(readyTimer);chrome.runtime.onMessage.removeListener(listener);}};
})();
