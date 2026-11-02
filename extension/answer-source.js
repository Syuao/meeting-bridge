(() => {
  const VERSION='0.9.0';
  // Rebinding also replaces a receiver left behind by an extension reload.
  globalThis.__meetingBridgeAnswers?.cleanup();
  const Sites=globalThis.MeetingBridgeSites;
  const selector='[data-message-author-role="assistant"],[data-content-search-unit-key$=":assistant"]';
  let config={enabled:false},observer,timer,handshakeTimer,selectionTimer,disposed=false;
  let wasBusy=false,submitted=false,current=null,baseline=null,dragging=false,lastManual='';
  const nodes=()=>[...document.querySelectorAll(selector)].filter(node=>!node.parentElement?.closest(selector));
  const key=node=>node?.getAttribute('data-message-id')||node?.getAttribute('data-chatgpt-search-message-ids')||node?.closest('[data-turn-id]')?.getAttribute('data-turn-id')||node?.closest('[data-turn-key]')?.getAttribute('data-turn-key')||node;
  const busy=()=>!!document.querySelector('[data-testid="stop-button"],button[aria-label="Stop"],button[aria-label="停止"],button[title="停止"],button[aria-label="Stop streaming"],button[aria-label="Stop generating"],button[aria-label="停止生成"],button[aria-label="停止流式传输"]');
  const same=()=>config.enabled&&Sites?.key(location.href)===config.expectedKey;
  function plain(node) {
    if(node.nodeType===3)return node.textContent||'';
    if(node.nodeType!==1 && node.nodeType!==11)return '';
    if(node.nodeType===1 && node.matches('button,svg,script,style,[aria-hidden="true"],[data-testid*="thought"],[class*="thinking"]'))return '';
    if(node.nodeName==='PRE')return '\n\n'+(node.querySelector('code')||node).textContent+'\n\n';
    if(node.nodeName==='BR')return '\n';
    const text=[...node.childNodes].map(plain).join('');
    if(/^(P|DIV|H[1-6]|UL|OL|BLOCKQUOTE|TABLE)$/.test(node.nodeName))return '\n'+text+'\n';
    if(node.nodeName==='LI')return '\n• '+text+'\n';
    if(node.nodeName==='TR')return text+'\n';
    if(/^(TD|TH)$/.test(node.nodeName))return text+'\t';
    return text;
  }
  const clean=text=>text.replace(/\r\n?/g,'\n').replace(/\u00a0/g,' ').split('\n').filter(line=>line.trim()).join('\n').trim();
  const answerText=node=>{
    const parts=[...node.querySelectorAll('.markdown,[data-markdown-text-style="assistant-message"]')];
    return clean(parts.length?parts.filter(part=>!part.parentElement?.closest('.markdown,[data-markdown-text-style="assistant-message"]')).map(plain).join('\n\n'):plain(node));
  };
  function notice(text,error=false) {
    let el=document.getElementById('meeting-bridge-answer-notice');
    if(!el){el=document.createElement('div');el.id='meeting-bridge-answer-notice';el.setAttribute('role','status');el.style.cssText='position:fixed;bottom:100px;right:24px;z-index:2147483647;padding:9px 13px;border-radius:8px;max-width:340px;font:13px system-ui;pointer-events:none;box-shadow:0 3px 12px #0003';document.body.append(el);}
    el.style.background=error?'#713821':'#193e31';el.style.color='#fff';el.textContent=text;
    clearTimeout(el._mbTimer);el._mbTimer=setTimeout(()=>el.remove(),2600);
  }
  function send(message,manual=false) {
    const epoch=config.epoch;
    chrome.runtime.sendMessage({...message,epoch}).then(result=>{
      if(disposed||epoch!==config.epoch)return;
      if(manual)notice(result?.ok?'已誊写到 ShareCode':result?.message||'誊写失败，请检查绑定',!result?.ok);
      if(!result?.ok)config.enabled=false;
    }).catch(()=>{if(disposed||epoch!==config.epoch)return;config.enabled=false;if(manual)notice('扩展已重载，请重新绑定 ShareCode',true);});
  }
  function scan() {
    timer=null;if(!same()||!config.automatic)return;
    const all=nodes(),last=all.at(-1),streaming=busy();
    if(streaming&&!wasBusy){current=null;submitted=true;}
    wasBusy=streaming;
    if(!last)return;
    const identity=key(last);
    if(!current){
      if(!submitted)return;
      const text=answerText(last);
      if(identity===baseline?.id&&text===baseline?.text)return;
      current={nodeKey:identity,id:crypto.randomUUID(),revision:0,text:''};submitted=false;
    }
    if(current.nodeKey!==identity){if(!streaming)return;current={nodeKey:identity,id:crypto.randomUUID(),revision:0,text:''};}
    const text=answerText(last);
    if(!text||text===current.text)return;
    current.text=text;
    send({type:'answer_update',id:current.id,revision:++current.revision,text});
  }
  const schedule=()=>{if(same()&&config.automatic&&!timer)timer=setTimeout(scan,400);};
  function configure(next) {
    if(disposed)return;
    if(config.epoch===next.epoch&&config.enabled===next.enabled&&config.expectedKey===next.expectedKey&&config.automatic===next.automatic)return;
    config=next;observer?.disconnect();clearTimeout(timer);clearTimeout(selectionTimer);timer=null;current=null;lastManual='';submitted=false;wasBusy=false;
    if(!same())return;
    const last=nodes().at(-1);baseline=last?{id:key(last),text:answerText(last)}:null;
    if(config.automatic){
      // Starting in the middle of a reply includes its already-visible prefix.
      if(busy()){baseline=null;submitted=true;}
      observer=new MutationObserver(schedule);
      observer.observe(document.querySelector('main')||document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['data-testid','aria-label']});
      schedule();
    }
  }
  function selectedText() {
    const selection=window.getSelection();if(!selection?.rangeCount||selection.isCollapsed)return '';
    const range=selection.getRangeAt(0),start=range.startContainer.nodeType===1?range.startContainer:range.startContainer.parentElement;
    const end=range.endContainer.nodeType===1?range.endContainer:range.endContainer.parentElement;
    const answer=start?.closest(selector);
    if(!answer||answer!==end?.closest(selector))return '';
    return clean(plain(range.cloneContents()));
  }
  function manualSelection() {
    if(!same()||config.automatic)return;
    // Capture immediately while the range is valid: the next streamed token
    // can replace DOM nodes. Sending never waits for generation to finish.
    const text=selectedText();if(!text||text===lastManual)return;
    clearTimeout(selectionTimer);
    selectionTimer=setTimeout(()=>{
      if(!same()||config.automatic)return;
      lastManual=text;
      send({type:'answer_selection',id:crypto.randomUUID(),revision:1,text},true);
    },160);
  }
  const pointerDown=event=>{if(event.button===0){dragging=true;lastManual='';clearTimeout(selectionTimer);}};
  const pointerUp=()=>{if(!dragging)return;dragging=false;manualSelection();};
  const keyUp=event=>{if(event.key==='Shift')manualSelection();};
  const submit=()=>{if(same()&&config.automatic){const last=nodes().at(-1);baseline=last?{id:key(last),text:answerText(last)}:null;submitted=true;current=null;schedule();}};
  const click=event=>{if(event.isTrusted&&event.target.closest?.('[data-testid="send-button"],button[aria-label="发送"],button[aria-label="Send"],button[aria-label="Send message"]'))submit();};
  const keyDown=event=>{if(event.isTrusted&&event.key==='Enter'&&!event.shiftKey&&event.target.closest?.('#prompt-textarea,[contenteditable="true"][role="textbox"],textarea'))submit();};
  const listener=(msg,sender,reply)=>{if(msg.type!=='answer_relay_config')return false;configure(msg);reply({ok:true,version:VERSION});return false;};
  async function handshake(){const before=config;try{const result=await chrome.runtime.sendMessage({type:'answer_source_ready'});if(result?.config&&config===before)configure(result.config);}catch{cleanup();}}
  function cleanup(){disposed=true;observer?.disconnect();clearTimeout(timer);clearTimeout(selectionTimer);clearInterval(handshakeTimer);chrome.runtime.onMessage.removeListener(listener);document.removeEventListener('pointerdown',pointerDown,true);document.removeEventListener('pointerup',pointerUp,true);document.removeEventListener('keyup',keyUp,true);document.removeEventListener('keydown',keyDown,true);document.removeEventListener('click',click,true);document.getElementById('meeting-bridge-answer-notice')?.remove();}
  chrome.runtime.onMessage.addListener(listener);
  document.addEventListener('pointerdown',pointerDown,true);document.addEventListener('pointerup',pointerUp,true);document.addEventListener('keyup',keyUp,true);document.addEventListener('keydown',keyDown,true);document.addEventListener('click',click,true);
  handshakeTimer=setInterval(handshake,5000);void handshake();
  globalThis.__meetingBridgeAnswers={version:VERSION,cleanup};
})();
