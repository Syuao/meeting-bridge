import './sites.js';
import {selectedTranscript} from './selection.js';
import {transcriptRows} from './transcript.js';
import {writeClipboard} from './clipboard.js';
import {translationText,translationPending} from './translation.js';
const $=id=>document.getElementById(id);
const api=async msg=>{const result=await chrome.runtime.sendMessage(msg);if(result?.error)throw new Error(result.error);return result;};
const time=at=>new Date(at).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
let state,view='transcripts',renderedView='',questionSignature='',transcriptSignature='',historyStart=null,questionLimit=200;
let setupInitialized=false,asrSetupInitialized=false,toastTimer,fontTimer,pendingFont=null;
let selectionId=null,selectionRange=null,selectionBusy=false,draggingText=false,gestureStarted=false,autoTimer=null;
let followLive=true,resumeFollowing=false,pausedCount=0;
let selectionCopy=null,lastSelectionId=null,selectionNotice='',selectionResultStatus=null;
const transcriptNodes=new Map();
function toast(text){$('toast').textContent=text;$('toast').style.display='block';clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').style.display='none',2600);}
async function copy(text){toast(await writeClipboard(text)?'已复制':'复制失败，请选中文字后按 ⌘C');}
function copyCurrentSelection(){
  const text=$('selectedText').value.trim(),id=selectionId;
  if(!text)return Promise.resolve(false);
  if(selectionCopy?.id===id&&selectionCopy.text===text)return selectionCopy.promise;
  const record={id,text};selectionCopy=record;
  record.promise=writeClipboard(text).then(ok=>{record.ok=ok;if(selectionId===id)selectionControls();return ok;});
  return record.promise;
}
function button(label,fn){const b=document.createElement('button');b.textContent=label;b.onclick=()=>Promise.resolve(fn()).catch(e=>toast(e.message));return b;}
function cancelAuto(){clearTimeout(autoTimer);autoTimer=null;}
function hasSelection(){return !!selectionId||draggingText;}
function protect(element){try{return selectionRange?.intersectsNode(element)}catch{return false}}
function pauseFollowing(){if(followLive){pausedCount=state?.transcripts.length||0;followLive=false;}updateFollow();}
function updateFollow(){
  $('followLatest').hidden=view!=='transcripts'||followLive;
  const added=Math.max(0,(state?.transcripts.length||0)-pausedCount);
  $('followLatest').textContent='↓ 回到最新'+(added?` · ${added} 段新文字`:'');
  $('historyNote').textContent=state?.running?(followLive?'跟随最新 · 自动保存':'已暂停滚动 · 继续转写'):'历史自动保存';
}
function positionSelection(){
  const tray=$('selectionTray');if(tray.hidden)return;
  const feed=$('feed'),bounds=feed.getBoundingClientRect();
  let rect;try{const rects=[...selectionRange.getClientRects()];rect=rects.at(-1)}catch{}
  const x=rect?.left??bounds.left+8,y=rect?.bottom??bounds.top+24;
  const width=tray.offsetWidth,height=tray.offsetHeight,topLimit=Math.min(bounds.top+4,window.innerHeight-height-8);
  let top=y+7;if(top+height>window.innerHeight-34)top=(rect?.top??y)-height-7;
  tray.style.left=Math.max(8,Math.min(x,window.innerWidth-width-8))+'px';
  tray.style.top=Math.max(8,Math.min(Math.max(top,topLimit),window.innerHeight-height-8))+'px';
}
function selectionControls(){
  $('selectionTray').hidden=!state?.config.confirmSelection||!selectionId||draggingText;
  const length=$('selectedText').value.trim().length;
  $('selectionCount').textContent=`已选 ${length} 字`;
  $('appendSelection').disabled=selectionBusy||!length||length>10000;
  const copied=selectionCopy?.id===selectionId?selectionCopy.ok:undefined;
  $('selectionHint').textContent=(copied===true?'已复制 · ':copied===false?'复制失败，可按 ⌘C · ':'')+(autoTimer?'即将填入 · Esc 取消':'追加到原草稿，由你发送');
}
function stageSelection(text,range){
  if(!text)return false;
  if(text.length>10000){cancelAuto();toast('选句过长，请分成几段加入');return false;}
  if(!selectionId||$('selectedText').value!==text){
    cancelAuto();selectionId='manual-'+crypto.randomUUID();$('selectedText').value=text;
    $('selectedText').hidden=true;$('selectionTray').classList.remove('editing');
  }
  selectionRange=range.cloneRange();selectionControls();positionSelection();return true;
}
function clearSelection({resume=true}={}){
  cancelAuto();selectionId=null;selectionRange=null;draggingText=false;
  $('selectionTray').hidden=true;$('selectedText').hidden=true;$('selectedText').value='';
  $('selectionTray').classList.remove('editing');window.getSelection()?.removeAllRanges();
  if(resume&&resumeFollowing)followLive=true;resumeFollowing=false;
  questionSignature='';if(state)render(state);
}
function readSelection({automatic=false}={}){
  if(draggingText||document.activeElement?.closest('#selectionTray'))return;
  const selection=window.getSelection();
  const text=selectedTranscript(selection,$('feed').querySelectorAll('.entry-text'));
  if(!text){if(!selectionBusy&&selectionId&&!$('selectionTray').classList.contains('editing'))clearSelection();return;}
  if(!selectionId){if(!gestureStarted)resumeFollowing=followLive;pauseFollowing();}
  if(!stageSelection(text,selection.getRangeAt(0)))return;
  if(automatic)void copyCurrentSelection();
  if(automatic&&!state.config.confirmSelection){
    cancelAuto();const id=selectionId;
    // Wait only for a completed gesture; this also coalesces double/triple clicks.
    autoTimer=setTimeout(()=>{autoTimer=null;if(selectionId===id)void appendSelection();},320);
    selectionControls();
  }
}
async function appendSelection(){
  cancelAuto();if(selectionBusy||!selectionId)return;
  const id=selectionId,text=$('selectedText').value.trim();if(!text||text.length>10000)return;
  const copied=copyCurrentSelection();lastSelectionId=id;
  selectionBusy=true;selectionResultStatus=null;selectionNotice='正在复制并填入…';selectionControls();renderDelivery();
  try{const result=await api({type:'fill_selection',id,text});const didCopy=await copied;selectionResultStatus=result.status;selectionNotice=(didCopy?'已复制；':'复制未成功；')+result.message;if(selectionId===id)clearSelection();renderDelivery();}
  catch(e){selectionNotice='尚未填入：'+e.message;renderDelivery();}
  finally{selectionBusy=false;selectionControls();}
}
document.addEventListener('selectionchange',()=>readSelection());
document.addEventListener('pointerdown',event=>{
  if(event.target.closest('#feed .entry-text')){
    cancelAuto();if(!selectionId)resumeFollowing=followLive;
    draggingText=true;gestureStarted=true;pauseFollowing();$('selectionTray').hidden=true;
  }else if(!event.target.closest('#selectionTray')){
    if(selectionId)clearSelection({resume:false});
    if(event.target===$('feed')){resumeFollowing=false;pauseFollowing();}
  }
});
document.addEventListener('pointerup',()=>{if(!draggingText)return;draggingText=false;readSelection({automatic:true});gestureStarted=false;if(state)render(state);});
document.addEventListener('pointercancel',()=>{draggingText=false;gestureStarted=false;cancelAuto();if(state)render(state);});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&hasSelection()){event.preventDefault();clearSelection();return;}
  if((event.metaKey||event.ctrlKey)&&event.key==='Enter'&&selectionId){event.preventDefault();event.stopPropagation();void appendSelection();}
});
document.addEventListener('keyup',event=>{
  if(event.key==='Shift'&&$('feed').contains(window.getSelection()?.anchorNode))readSelection({automatic:true});
});
// Clicking a floating action should not collapse the selection before it is copied.
$('selectionTray').addEventListener('mousedown',event=>{if(event.target.closest('button'))event.preventDefault();});
$('feed').addEventListener('wheel',()=>{resumeFollowing=false;},{passive:true});
$('feed').addEventListener('scroll',()=>{
  if(view!=='transcripts')return;
  const feed=$('feed');
  if(!hasSelection()){
    const bottom=feed.scrollHeight-feed.clientHeight-feed.scrollTop<32;
    if(!bottom&&followLive)pauseFollowing();else if(bottom)followLive=true;
  }
  updateFollow();positionSelection();
},{passive:true});
window.addEventListener('resize',positionSelection);
function renderTranscripts(){
  const rows=transcriptRows(state),feed=$('feed');
  if(historyStart===null||historyStart>rows.length)historyStart=Math.max(0,rows.length-200);
  $('older').hidden=historyStart===0;
  if(draggingText)return;
  const signature=JSON.stringify([historyStart,state.running,state.config.translationEnabled,selectionId,rows]);
  if(signature===transcriptSignature)return;transcriptSignature=signature;
  const visible=rows.slice(historyStart),ids=new Set(visible.map(row=>row.id));
  for(const [id,node] of transcriptNodes){if(!ids.has(id)&&!protect(node)){node.remove();transcriptNodes.delete(id);}}
  if(!visible.length){if(!feed.querySelector('.empty')){feed.replaceChildren();const empty=document.createElement('div');empty.className='empty';empty.innerHTML='<strong>声音会接成一篇正文</strong>开始监听后，直接划出需要的问题。<br>旧文字保留在这里，可以向上翻。';feed.append(empty);}return;}
  feed.querySelector('.empty')?.remove();
  const anchor=!followLive?[...feed.children].find(node=>node.getBoundingClientRect().bottom>feed.getBoundingClientRect().top):null;
  const anchorTop=anchor?.getBoundingClientRect().top;
  let cursor=feed.firstElementChild;
  for(let i=0;i<visible.length;i++){
    const row=visible[i];let node=transcriptNodes.get(row.id);
    if(!node){node=document.createElement('div');node.className='stream-paragraph';node.dataset.id=row.id;const stamp=document.createElement('div');stamp.className='time-break';const text=document.createElement('div');text.className='entry-text';const translated=document.createElement('div');translated.className='translation-text';node.append(stamp,text,translated);transcriptNodes.set(row.id,node);}
    const [stamp,text,translated]=node.children;
    const previous=rows[historyStart+i-1];stamp.hidden=!!previous&&Math.abs(row.at-previous.at)<120000;if(stamp.textContent!==time(row.at))stamp.textContent=time(row.at);
    node.classList.toggle('live',row.final===false&&state.running);node.title=row.final===false?(state.running?'这段文字仍在修订':'未确认的末段'):time(row.at);
    if(text.textContent!==row.text&&!protect(text))text.textContent=row.text;
    if(!protect(node)){
      const chinese=translationText(row),pending=translationPending(row);
      translated.hidden=!state.config.translationEnabled||!chinese;
      const value=chinese+(pending?' （译文更新中）':'');if(translated.textContent!==value)translated.textContent=value;
      translated.classList.toggle('pending',pending);translated.title='中文仅供阅读，划选和自动复制只取英文原文';
    }
    if(node!==cursor)feed.insertBefore(node,cursor);cursor=node.nextElementSibling;
  }
  if(anchor?.isConnected)feed.scrollTop+=anchor.getBoundingClientRect().top-anchorTop;
  if(followLive&&!hasSelection())feed.scrollTop=feed.scrollHeight;
}
function renderQuestions(){
  const items=state.questions.slice(-questionLimit),feed=$('feed');$('older').hidden=state.questions.length<=questionLimit;
  const signature=JSON.stringify(items);if(signature===questionSignature||hasSelection()||feed.querySelector('textarea'))return;
  questionSignature=signature;feed.replaceChildren();
  if(!items.length){const e=document.createElement('div');e.className='empty';e.textContent='你划选并填入的文字会保存在这里。';feed.append(e);return;}
  const names={held:'历史',pending:'待填入',waiting:'等待追加',filled:'已填入',sent:'已发送',dismissed:'已忽略'};
  for(const item of items){
    const card=document.createElement('article');card.className='entry';const head=document.createElement('div');head.className='entry-head';
    const clock=document.createElement('span');clock.textContent=time(item.at);const badge=document.createElement('span');badge.className='badge';badge.textContent=names[item.status]||'';head.append(clock,badge);
    const text=document.createElement('div');text.className='entry-text';text.textContent=item.text;card.append(head,text);
    if(item.detail){const detail=document.createElement('div');detail.className='detail';detail.textContent=item.detail;card.append(detail);}
    const actions=document.createElement('div');actions.className='entry-actions';actions.append(button('复制',()=>copy(item.text)),button('填入',()=>api({type:'fill',id:item.id})),button('编辑',()=>{
      const area=document.createElement('textarea');area.value=item.text;text.replaceWith(area);actions.replaceChildren(button('保存',async()=>{await api({type:'edit',id:item.id,text:area.value});area.replaceWith(text);questionSignature='';render(await api({type:'get_state'}));}));area.focus();
    }));
    if(!['sent','filled','dismissed'].includes(item.status))actions.append(button('忽略',()=>api({type:'dismiss',id:item.id})));
    card.append(actions);feed.append(card);
  }
}
function renderDelivery(){
  const waiting=state.questions.filter(q=>q.requested&&['pending','waiting'].includes(q.status));
  const last=state.questions.find(q=>q.id===lastSelectionId),el=$('deliveryStatus');
  el.hidden=!waiting.length&&!last&&!selectionNotice;
  el.classList.toggle('waiting',!!waiting.length);
  el.textContent=waiting.length?`尚未填入 ${waiting.length} 条：${waiting[0].detail||'正在连接目标对话…'}。已复制的选句可用 ⌘V 粘贴。`:last&&['filled','sent'].includes(last.status)?(selectionResultStatus===last.status?selectionNotice:'已追加到目标对话草稿 · 未发送'):selectionNotice;
}
function render(next){
  state=next;if(!setupInitialized){$('setup').open=!state.target;setupInitialized=true;}
  $('status').textContent=({stopped:'已停止',stopping:'保存末段',loading:'正在连接',permission:'准备采集',listening:'监听中',error:'需要处理'})[state.status]||'准备就绪';
  $('statusMessage').textContent=state.message;$('statusMessage').title=state.message;
  $('level').style.width=Math.round(state.level*100)+'%';$('dot').classList.toggle('active',state.running);
  $('start').disabled=state.running||state.status==='stopping'||state.asr?.state==='testing';$('stop').disabled=!state.running&&state.status!=='error';
  $('bound').textContent=state.target?`已绑定：${state.target.title||'目标对话'}`:'尚未绑定';
  for(const key of ['autoFill','autoSend','confirmSelection','translationEnabled'])$(key).checked=!!state.config[key];
  $('translationStatus').textContent=state.config.translationEnabled?(state.translation?.message||'正在准备中文翻译'):'中文翻译已关闭';
  $('translationStatus').title=$('translationStatus').textContent;
  $('retryTranslation').hidden=!state.config.translationEnabled||!['error','retrying'].includes(state.translation?.state);
  for(const key of ['language','source','questionMode','translationProvider'])$(key).value=String(state.config[key]);
  if(pendingFont===state.config.fontSize)pendingFont=null;
  if(document.activeElement!==$('fontSize'))$('fontSize').value=String(pendingFont??state.config.fontSize);
  if(document.activeElement!==$('hotwords'))$('hotwords').value=state.config.hotwords||'';
  for(const key of ['language','source','hotwords','questionMode'])$(key).disabled=state.running||state.status==='stopping';
  if(!asrSetupInitialized&&state.asr?.configured){$('asrRegion').value=state.asr.region;asrSetupInitialized=true;}
  $('asrStatus').hidden=!['error'].includes(state.asr?.state);$('asrStatus').textContent=state.asr?.message||'';
  $('asrKeyStatus').textContent=state.asr?.message||'';
  for(const key of ['saveAsr','testAsr','asrRegion','asrKey'])$(key).disabled=state.running||state.status==='stopping'||state.asr?.state==='testing';
  const font=document.activeElement===$('fontSize')&&$('fontSize').validity.valid?Number($('fontSize').value):(pendingFont??state.config.fontSize);
  document.documentElement.style.setProperty('--font',font+'px');
  $('semanticStatus').hidden=state.config.questionMode!=='semantic';$('semanticStatus').textContent=state.semantic?.message||'';
  $('deepseekSettings').hidden=state.config.questionMode!=='semantic'&&!(state.config.translationEnabled&&state.config.translationProvider==='deepseek');$('autoControls').hidden=state.config.questionMode==='manual';
  $('keyStatus').textContent=state.semantic?.message||'';$('testApi').disabled=['processing','testing'].includes(state.semantic?.state);
  $('questionCount').textContent=state.questions.length;$('transcriptCount').textContent=state.transcripts.length;
  $('hint').textContent=state.config.confirmSelection?'松手即复制 · 确认后填入':'松手即复制并填入';
  renderDelivery();
  if(renderedView!==view){$('feed').replaceChildren();transcriptNodes.clear();questionSignature='';transcriptSignature='';renderedView=view;}
  $('feed').className=view;
  if(view==='transcripts'){renderTranscripts();if(followLive&&!hasSelection())$('feed').scrollTop=$('feed').scrollHeight;}else renderQuestions();
  updateFollow();selectionControls();positionSelection();
}
async function refreshTabs(){const tabs=await api({type:'get_tabs'});$('tabs').replaceChildren();if(!tabs.length)$('tabs').append(new Option('请先打开 ChatGPT、DeepSeek 或千问网页',''));for(const tab of tabs)$('tabs').append(new Option(`[${tab.provider||'对话'}] ${tab.title||tab.url}`,tab.id));if(state?.target&&tabs.some(tab=>tab.id===state.target.tabId))$('tabs').value=String(state.target.tabId);}
for(const [id,type] of [['start','start'],['stop','stop'],['wide','open_panel']])$(id).onclick=()=>api({type}).catch(e=>toast(e.message));
$('refresh').onclick=()=>refreshTabs().catch(e=>toast(e.message));
$('bind').onclick=()=>{if(!$('tabs').value){toast('请先打开支持的对话网页');return;}api({type:'bind',tabId:Number($('tabs').value)}).catch(e=>toast(e.message));};
for(const key of ['autoFill','autoSend','confirmSelection','translationEnabled','language','source','questionMode','translationProvider','hotwords'])$(key).onchange=()=>{if(key==='confirmSelection')cancelAuto();api({type:'config',value:{[key]:['autoFill','autoSend','confirmSelection','translationEnabled'].includes(key)?$(key).checked:$(key).value}}).catch(e=>toast(e.message));};
function setFont(value){
  const size=Math.max(10,Math.min(32,Math.round(value)));if(!Number.isFinite(size))return;
  pendingFont=size;$('fontSize').value=String(size);document.documentElement.style.setProperty('--font',size+'px');clearTimeout(fontTimer);
  fontTimer=setTimeout(()=>api({type:'config',value:{fontSize:size}}).catch(e=>toast(e.message)),180);
}
$('fontSize').oninput=()=>{if($('fontSize').value&&$('fontSize').validity.valid)setFont(Number($('fontSize').value));};
$('fontSize').onblur=()=>setFont($('fontSize').value?Number($('fontSize').value):state.config.fontSize);
$('fontSmaller').onclick=()=>setFont(Number($('fontSize').value)-1);$('fontLarger').onclick=()=>setFont(Number($('fontSize').value)+1);
for(const [id,name] of [['showQuestions','questions'],['showTranscript','transcripts']])$(id).onclick=()=>{
  clearSelection({resume:false});view=name;questionLimit=200;followLive=true;
  $('showQuestions').classList.toggle('selected',name==='questions');$('showTranscript').classList.toggle('selected',name==='transcripts');render(state);
};
$('followLatest').onclick=()=>{clearSelection({resume:false});followLive=true;render(state);};
$('older').onclick=()=>{
  clearSelection({resume:false});const feed=$('feed'),before=feed.scrollHeight,position=feed.scrollTop;pauseFollowing();
  if(view==='transcripts')historyStart=Math.max(0,historyStart-200);else questionLimit+=200;
  questionSignature='';render(state);feed.scrollTop=position+feed.scrollHeight-before;
};
const allText=()=>(view==='questions'?state.questions:state.transcripts).map(row=>`[${time(row.at)}] ${row.text}`).join('\n\n');
$('copyAll').onclick=()=>copy(allText());$('export').onclick=()=>{const url=URL.createObjectURL(new Blob([allText()],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=`MeetingBridge-${view}-${new Date().toISOString().slice(0,10)}.txt`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$('selectedText').oninput=()=>{cancelAuto();selectionId='manual-'+crypto.randomUUID();selectionControls();};
$('cancelSelection').onclick=()=>clearSelection();$('copySelection').onclick=()=>{cancelAuto();copy($('selectedText').value);selectionControls();};
$('editSelection').onclick=()=>{cancelAuto();$('selectedText').hidden=false;$('selectionTray').classList.add('editing');selectionControls();positionSelection();$('selectedText').focus();};
$('appendSelection').onclick=appendSelection;
$('clear').onclick=()=>{if(confirm('永久清空本机保存的全部转写和问题历史？')){selectionNotice='';lastSelectionId=null;clearSelection();historyStart=0;api({type:'clear'});}};
chrome.runtime.onMessage.addListener(msg=>{if(msg.type==='state')render(msg.state);});
$('saveKey').onclick=async()=>{try{await api({type:'configure_api',provider:'deepseek',key:$('apiKey').value});$('apiKey').value='';toast('已提交本机保存');}catch(e){toast(e.message)}};
$('testApi').onclick=()=>api({type:'test_api',provider:'deepseek'}).catch(e=>toast(e.message));$('retryApi').onclick=()=>api({type:'retry_api'});
$('saveAsr').onclick=async()=>{try{await api({type:'configure_asr',key:$('asrKey').value,region:$('asrRegion').value});$('asrKey').value='';toast('已提交本机保存');}catch(e){toast(e.message);}};
$('testAsr').onclick=()=>api({type:'test_asr'}).catch(e=>toast(e.message));
$('retryTranslation').onclick=()=>api({type:'translation_retry'}).catch(e=>toast(e.message));
render(await api({type:'get_state'}));await refreshTabs();if(state.config.questionMode==='semantic'||(state.config.translationEnabled&&state.config.translationProvider==='deepseek'))await api({type:'api_status'});await api({type:'asr_status'});
