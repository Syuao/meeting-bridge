import './sites.js';
const Sites=globalThis.MeetingBridgeSites;
import {translationCandidates} from './translation.js';
let port=null, delivering=false, saveTimer;
const state={status:'stopped',message:'准备就绪',running:false,level:0,processing:0,partial:null,liveLines:[],transcripts:[],questions:[],target:null,translation:{state:'ready',message:'正在准备中文翻译'},asr:{state:'unconfigured',message:'尚未配置阿里云百炼 API 密钥',configured:false,region:'beijing'},semantic:{state:'unconfigured',message:'尚未配置 API',configured:false},config:{autoFill:false,autoSend:false,language:'auto',source:'aliyun-all',questionMode:'manual',fontSize:14,confirmSelection:false,translationEnabled:true,translationProvider:'qwen-mt',continuousVersion:1,liveExpanded:true,hotwords:'',streamingVersion:1,manualVersion:1}};
const initialized=(async()=>{
  const saved=await chrome.storage.local.get(['config','target','history']);
  Object.assign(state.config,saved.config||{}); state.target=saved.target||null;
  // The user selected cloud streaming; migrate the source once, preserving draft preferences/history.
  if(!saved.config?.streamingVersion){state.config.source='aliyun-all';state.config.questionMode='semantic';state.config.streamingVersion=1;await chrome.storage.local.set({config:{...state.config,autoSend:false}});}
  // Apply the user's new workflow once, without deleting history, bindings or API keys.
  if(!saved.config?.manualVersion){Object.assign(state.config,{questionMode:'manual',autoFill:false,autoSend:false,fontSize:16,manualVersion:1});await chrome.storage.local.set({config:state.config});}
  if(!saved.config?.continuousVersion){Object.assign(state.config,{fontSize:14,confirmSelection:false,continuousVersion:1});await chrome.storage.local.set({config:state.config});}
  // Sending is always opt-in for each browser session.
  state.config.autoSend=false;
  const history=saved.history||(await chrome.storage.session.get('history')).history;
  if(history) {state.transcripts=history.transcripts||[];state.questions=(history.questions||[]).map(q=>['pending','waiting'].includes(q.status)?{...q,status:'held',requested:false,detail:'历史问题，可手动填入'}:q);}
})();
function update(persist=false) {
  chrome.runtime.sendMessage({type:'state',state}).catch(()=>{});
  if(persist&&!saveTimer){saveTimer=setTimeout(()=>{saveTimer=null;chrome.storage.local.set({history:{transcripts:state.transcripts,questions:state.questions}}).catch(e=>{state.message='历史保存失败：'+e.message;update();});},200);}
}
function error(message) {state.message=message;update();}
function queueTranslation(rows){
  if(!state.config.translationEnabled||!port)return;
  const candidates=translationCandidates(rows);if(candidates.length)port.postMessage({type:'translate',rows:candidates});
}
function syncTranslation(){port?.postMessage({type:'translation_config',enabled:state.config.translationEnabled,provider:state.config.translationProvider});if(state.config.translationEnabled)queueTranslation(state.transcripts);}
function connect() {
  if(port) return port;
  port=chrome.runtime.connectNative('local.meetingbridge');
  port.onMessage.addListener(msg=>{
    if(msg.type==='status') {state.status=msg.state;state.message=msg.message;state.running=!['stopped','error','stopping'].includes(msg.state);if(!state.running){state.level=0;state.processing=0;if(msg.state!=='stopping')state.partial=null;}}
    if(msg.type==='error') state.message=msg.message;
    if(msg.type==='semantic')state.semantic=msg;
    if(msg.type==='asr_status')state.asr=msg;
    if(msg.type==='translation_status')state.translation=msg;
    if(msg.type==='translation'&&state.config.translationEnabled){
      const row=state.transcripts.find(r=>r.id===msg.id);
      if(row&&typeof msg.sourceText==='string'&&typeof msg.text==='string'&&msg.text.trim()&&msg.text.length<=10000)row.translation={text:msg.text,sourceText:msg.sourceText,model:msg.model,provider:msg.provider,complete:msg.complete!==false,at:msg.at};
    }
    if(msg.type==='level') state.level=msg.value;
    if(msg.type==='processing') state.processing=msg.queue;
    if(msg.type==='partial')state.partial=msg;
    if(msg.type==='transcript') {if(state.partial?.piece===msg.piece&&msg.final!==false)state.partial=null;const i=state.transcripts.findIndex(x=>x.id===msg.id);const old=i>=0?state.transcripts[i]:null;const row={...msg,...(old?.translation?{translation:old.translation}:{})};if(i>=0)state.transcripts[i]=row;else state.transcripts.push(row);if(msg.source!=='tencent-text'&&msg.final!==false&&!(old?.final)){state.liveLines.push(msg.text);state.liveLines=state.liveLines.slice(-2);}state.processing=Math.max(0,state.processing-1);queueTranslation([row]);}
    if(msg.type==='question') {state.questions.push({...msg,status:'pending'});void deliver();}
    update(['transcript','question','translation'].includes(msg.type));
  });
  port.onDisconnect.addListener(()=>{const reason=chrome.runtime.lastError?.message;port=null;state.running=false;state.status='stopped';state.level=0;state.message=reason?'本机连接中断：'+reason:'本机连接已关闭';update();});
  syncTranslation();
  return port;
}
const key=Sites.key;
async function sendToComposer(tabId,message){
  try{
    const result=await chrome.tabs.sendMessage(tabId,message);
    if(result)return result;
  }catch(e){
    if(!/Receiving end does not exist|Could not establish connection/.test(e.message||''))throw e;
  }
  // Reloading an extension leaves already-open pages without its content receiver.
  // Reconnect only the bound ChatGPT tab, keeping its current draft intact.
  await chrome.scripting.executeScript({target:{tabId},files:['sites.js','content.js']});
  return await chrome.tabs.sendMessage(tabId,message);
}
async function deliver(id=null) {
  await initialized;
  if(id){const chosen=state.questions.find(x=>x.id===id);if(chosen&&!['filled','sent'].includes(chosen.status)){chosen.requested=true;chosen.status='waiting';}}
  if(delivering)return;
  const automatic=state.running&&state.config.autoFill&&state.config.questionMode!=='manual';
  const q=state.questions.find(x=>['pending','waiting'].includes(x.status)&&(x.requested||automatic));
  if(!q) return;
  if(!state.target) {q.status='waiting';q.detail='先绑定一个目标对话';update(true);return;}
  delivering=true;
  try {
    const tab=await chrome.tabs.get(state.target.tabId);
    if(!Sites.site(tab.url)||key(tab.url)!==key(state.target.url)) throw new Error('目标标签页已切换对话，请重新绑定。');
    const result=await sendToComposer(tab.id,{type:'fill_question',id:q.id,text:q.text,expectedKey:key(state.target.url),autoSend:q.detection==='manual'||Sites.site(tab.url)?.id!=='chatgpt'?false:state.config.autoSend});
    if(!result?.ok) {q.status='waiting';q.detail=result?.message||'输入框尚未准备好';}
    else {q.requested=false;q.appended=!!result.appended;q.status=result.sent?'sent':'filled';q.detail=result.message||'';q.latencyMs=q.speechEndedAt?Date.now()-q.speechEndedAt:null;if(q.latencyMs)port?.postMessage({type:'delivery_metrics',latencyMs:q.latencyMs,status:q.status});}
  } catch(e) {q.status='waiting';q.detail=/Receiving end|Could not establish connection/.test(e.message||'')?'无法连接目标对话页面，请刷新该页面后重试':e.message;}
  finally {delivering=false;update(true);if(['sent','filled'].includes(q.status))void deliver();}
}
async function command(msg,sender) {
  await initialized;
  if(msg.type==='get_state') return state;
  if(msg.type==='translation_retry'){connect().postMessage({type:'translation_retry'});queueTranslation(state.transcripts);return {ok:true};}
  if(['configure_api','api_status','retry_api','test_api'].includes(msg.type)){connect().postMessage({type:msg.type,provider:msg.provider,...(msg.type==='configure_api'?{key:String(msg.key||'')}: {})});return {ok:true};}
  if(['configure_asr','asr_status','test_asr'].includes(msg.type)){connect().postMessage({type:msg.type,...(msg.type==='configure_asr'?{key:String(msg.key||''),region:msg.region}:{})});return {ok:true};}
  if(msg.type==='get_tabs') return (await chrome.tabs.query({url:Sites.matches})).map(t=>({id:t.id,title:t.title,url:t.url,provider:Sites.site(t.url)?.name}));
  if(msg.type==='bind') {const tab=await chrome.tabs.get(Number(msg.tabId));if(!Sites.site(tab.url))throw new Error('请选择 ChatGPT、DeepSeek 或千问标签页');if(state.target&&(state.target.tabId!==tab.id||key(state.target.url)!==key(tab.url))){for(const q of state.questions)if(['pending','waiting'].includes(q.status)){q.status='held';q.requested=false;q.detail='旧对话的问题，可手动填入';}}state.target={tabId:tab.id,title:tab.title,url:tab.url};await chrome.storage.local.set({target:state.target});update(true);void deliver();return {ok:true};}
  if(msg.type==='config') {
    const c=msg.value||{};
    for(const k of ['autoFill','autoSend','liveExpanded','confirmSelection','translationEnabled'])if(typeof c[k]==='boolean')state.config[k]=c[k];
    if(['auto','en','zh'].includes(c.language))state.config.language=c.language;
    if(['tencent','all','tencent-text','aliyun-all','aliyun-tencent'].includes(c.source))state.config.source=c.source;
    if(typeof c.hotwords==='string')state.config.hotwords=c.hotwords.slice(0,4000);
    if(['manual','rules','semantic'].includes(c.questionMode))state.config.questionMode=c.questionMode;
    if(['qwen-mt','deepseek'].includes(c.translationProvider))state.config.translationProvider=c.translationProvider;
    if(state.config.questionMode==='manual'){state.config.autoFill=false;state.config.autoSend=false;}
    if(Number.isInteger(c.fontSize)&&c.fontSize>=10&&c.fontSize<=32)state.config.fontSize=c.fontSize;
    await chrome.storage.local.set({config:{...state.config,autoSend:false}});
    if(typeof c.translationEnabled==='boolean'||['qwen-mt','deepseek'].includes(c.translationProvider)){if(state.config.translationEnabled)connect();syncTranslation();if(!state.config.translationEnabled)state.translation={state:'off',message:'中文翻译已关闭'};}
    update();void deliver();return {ok:true};
  }
  if(msg.type==='start') {if(state.running||state.status==='stopping')return {ok:true};state.liveLines=[];state.partial=null;state.startedAt=Date.now();state.status='loading';state.running=true;state.message='正在准备实时转写…';update();connect().postMessage({type:'start',source:state.config.source,language:state.config.language,questionMode:state.config.questionMode,hotwords:state.config.hotwords});return {ok:true};}
  if(msg.type==='stop') {state.running=false;port?.postMessage({type:'stop'});state.status=port?'stopping':'stopped';state.message='正在停止并保存末段文字…';state.level=0;update();return {ok:true};}
  if(msg.type==='fill') {await deliver(msg.id);return {ok:true};}
  if(msg.type==='fill_selection') {
    const text=String(msg.text||'').trim(),id=String(msg.id||'');
    if(!/^manual-[a-zA-Z0-9-]{1,100}$/.test(id)||!text||text.length>10000)throw new Error('请选择 1–10000 字的转写内容。');
    let q=state.questions.find(x=>x.id===id);
    if(q&&q.text!==text)throw new Error('选句已变化，请重新选择后填入。');
    if(!q){q={id,text,at:Date.now(),detection:'manual',status:'waiting',requested:true};state.questions.push(q);update(true);}
    if(!['filled','sent'].includes(q.status))await deliver(id);
    const blocker=state.questions.find(x=>['pending','waiting'].includes(x.status)&&x.requested);
    return {ok:true,id,status:q.status,message:['filled','sent'].includes(q.status)?'已追加到目标对话草稿，未发送':'尚未填入：'+(q.detail||blocker?.detail||'正在处理前一条选句')};
  }
  if(msg.type==='dismiss') {const q=state.questions.find(x=>x.id===msg.id);if(q)q.status='dismissed';update(true);return {ok:true};}
  if(msg.type==='edit') {const q=state.questions.find(x=>x.id===msg.id);if(q){q.text=String(msg.text).slice(0,10000);q.status='pending';}update(true);return {ok:true};}
  if(msg.type==='clear') {state.transcripts=[];state.questions=[];port?.postMessage({type:'translation_clear'});await chrome.storage.local.set({history:{transcripts:[],questions:[]}});update();return {ok:true};}
  if(msg.type==='composer_ready' && sender.tab?.id===state.target?.tabId) {void deliver();return {ok:true};}
  if(msg.type==='open_panel') {await chrome.tabs.create({url:chrome.runtime.getURL('panel.html')});return {ok:true};}
}
chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
  if(msg.type==='state')return false;
  // Content scripts can only announce input readiness; controls belong to extension pages.
  if(sender.tab&& !sender.url?.startsWith(chrome.runtime.getURL?.('')||'chrome-extension://') && msg.type!=='composer_ready')return false;
  command(msg,sender).then(reply).catch(e=>reply({error:e.message}));return true;
});
chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true}).catch(()=>{});
chrome.tabs.onUpdated.addListener(async(id,change,tab)=>{
  await initialized;
  if(id!==state.target?.tabId || !change.url)return;
  // Adopt the first conversation created in a deliberately bound new-chat tab.
  if(Sites.adopt(state.target.url,tab.url)) {
    state.target.url=tab.url;state.target.title=tab.title;await chrome.storage.local.set({target:state.target});update();
  }
});
chrome.tabs.onRemoved.addListener(id=>{if(id===state.target?.tabId){state.message='目标对话已关闭，请重新绑定';update();}});
