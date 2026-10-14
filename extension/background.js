import './sites.js';
const Sites=globalThis.MeetingBridgeSites;
const ASR_MODELS=['qwen-audio-3.0-asr-flash-streaming','paraformer-realtime-v2'];
import {translationCandidates} from './translation.js';
const sessions=new Map();
const windowSessions=new Map();
let windowMapLoaded=false;
let sessionStorageWrite=Promise.resolve();
const DEFAULT_SESSION='legacy';
const newSessionId=()=>{try{if(typeof crypto!=='undefined'&&crypto.randomUUID)return crypto.randomUUID()}catch{}return 'session-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10)};
async function loadWindowMap(){if(windowMapLoaded)return;windowMapLoaded=true;try{const saved=await chrome.storage.session.get('windowSessions');for(const [id,sid] of Object.entries(saved.windowSessions||{}))windowSessions.set(Number(id),sid)}catch{}}
async function saveWindowMap(){try{await chrome.storage.session.set({windowSessions:Object.fromEntries(windowSessions)})}catch{}}
function writeMeetingSession(sessionId,record){
  const task=sessionStorageWrite.then(async()=>{const saved=await chrome.storage.local.get('meetingSessions');const all=saved.meetingSessions||{};all[sessionId]=record;await chrome.storage.local.set({meetingSessions:all});});
  sessionStorageWrite=task.catch(()=>{});return task;
}
async function createSession(sessionId,seed=null,windowId=null){if(sessions.has(sessionId)){const s=sessions.get(sessionId);if(windowId!=null)s.setWindowId(windowId);return s}const session=createSessionImpl(sessionId,seed,windowId);sessions.set(sessionId,session);await session.ready;return session}
function createSessionImpl(sessionId,seed,windowId){
let port=null, delivering=false, saveTimer;
async function saveSession(part='all') {
  const record={config:{...state.config,autoSend:false},target:state.target,history:{transcripts:state.transcripts,questions:state.questions},updatedAt:Date.now()};
  if(sessionId==='legacy') {
    const patch={}; if(part==='all'||part==='config')patch.config=record.config; if(part==='all'||part==='target')patch.target=record.target; if(part==='all'||part==='history')patch.history=record.history;
    await chrome.storage.local.set(patch);
  } else {
    await writeMeetingSession(sessionId,record);
  }
}
async function readSession() {
  const saved=await chrome.storage.local.get(['config','target','history','meetingSessions']);
  if(sessionId==='legacy') return {config:saved.config||{},target:saved.target||null,history:saved.history||(await chrome.storage.session.get('history')).history};
  const stored=saved.meetingSessions?.[sessionId];
  return stored || {config:{...(seed?.config||{})},target:null,history:{transcripts:[],questions:[]}};
}
const state={status:'stopped',message:'准备就绪',running:false,level:0,processing:0,partial:null,liveLines:[],transcripts:[],questions:[],target:null,translation:{state:'ready',message:'正在准备中文翻译'},asr:{state:'unconfigured',message:'尚未配置阿里云百炼 API 密钥',configured:false,region:'beijing'},semantic:{state:'unconfigured',message:'尚未配置 API',configured:false},config:{autoFill:false,autoSend:false,language:'auto',asrModel:ASR_MODELS[0],source:'aliyun-all',questionMode:'manual',fontSize:14,confirmSelection:false,translationEnabled:true,translationProvider:'qwen-mt',continuousVersion:1,liveExpanded:true,hotwords:'',streamingVersion:1,manualVersion:1}};
const initialized=(async()=>{
  const saved=await readSession();
  Object.assign(state.config,saved.config||{}); state.target=saved.target||null;
  if(!ASR_MODELS.includes(state.config.asrModel))state.config.asrModel=ASR_MODELS[0];
  // The user selected cloud streaming; migrate the source once, preserving draft preferences/history.
  if(sessionId==='legacy'&&!saved.config?.streamingVersion){state.config.source='aliyun-all';state.config.questionMode='semantic';state.config.streamingVersion=1;await saveSession('config');}
  // Apply the user's new workflow once, without deleting history, bindings or API keys.
  if(sessionId==='legacy'&&!saved.config?.manualVersion){Object.assign(state.config,{questionMode:'manual',autoFill:false,autoSend:false,fontSize:16,manualVersion:1});await saveSession('config');}
  if(sessionId==='legacy'&&!saved.config?.continuousVersion){Object.assign(state.config,{fontSize:14,confirmSelection:false,continuousVersion:1});await saveSession('config');}
  // Sending is always opt-in for each browser session.
  state.config.autoSend=false;
  const history=saved.history;
  if(history) {state.transcripts=history.transcripts||[];state.questions=(history.questions||[]).map(q=>['pending','waiting'].includes(q.status)?{...q,status:'held',requested:false,detail:'历史问题，可手动填入'}:q);}
})();
function update(persist=false) {
  chrome.runtime.sendMessage({type:'state',sessionId,state}).catch(()=>{});
  if(persist&&!saveTimer){saveTimer=setTimeout(()=>{saveTimer=null;saveSession('history').catch(e=>{state.message='历史保存失败：'+e.message;update();});},200);}
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
    if(msg.type==='level'){state.level=msg.value;chrome.runtime.sendMessage({type:'level',sessionId,value:msg.value}).catch(()=>{});return;}
    if(msg.type==='status') {state.status=msg.state;state.message=msg.message;state.running=!['stopped','error','stopping'].includes(msg.state);if(!state.running){state.level=0;state.processing=0;if(msg.state!=='stopping')state.partial=null;}}
    if(msg.type==='error') state.message=msg.message;
    if(msg.type==='semantic')state.semantic=msg;
    if(msg.type==='asr_status')state.asr=msg;
    if(msg.type==='translation_status')state.translation=msg;
    if(msg.type==='translation'&&state.config.translationEnabled){
      const row=state.transcripts.find(r=>r.id===msg.id);
      if(row&&typeof msg.sourceText==='string'&&typeof msg.text==='string'&&msg.text.trim()&&msg.text.length<=10000)row.translation={text:msg.text,sourceText:msg.sourceText,model:msg.model,provider:msg.provider,complete:msg.complete!==false,at:msg.at};
    }
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
const receiverVersions=new Map();
async function sendToComposer(tabId,message){
  if(!receiverVersions.has(tabId)){
    let probe;try{probe=await chrome.tabs.sendMessage(tabId,{type:'probe_composer',expectedKey:message.expectedKey});}catch{}
    if(probe?.version!=='0.8.0')await chrome.scripting.executeScript({target:{tabId},files:['sites.js','content.js']});
    receiverVersions.set(tabId,true);
  }
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
  const previousStatus=q.status,previousDetail=q.detail;
  delivering=true;
  try {
    const tab=await chrome.tabs.get(state.target.tabId);
    if(!Sites.site(tab.url)||key(tab.url)!==key(state.target.url)) throw new Error('目标标签页已切换对话，请重新绑定。');
    const result=await sendToComposer(tab.id,{type:'fill_question',id:q.id,text:q.text,expectedKey:key(state.target.url),autoSend:q.detection==='manual'||Sites.site(tab.url)?.id!=='chatgpt'?false:state.config.autoSend});
    if(!result?.ok) {q.status='waiting';q.detail=result?.message||'输入框尚未准备好';}
    else {q.requested=false;q.appended=!!result.appended;q.status=result.sent?'sent':'filled';q.detail=result.message||'';q.latencyMs=q.speechEndedAt?Date.now()-q.speechEndedAt:null;if(q.latencyMs)port?.postMessage({type:'delivery_metrics',latencyMs:q.latencyMs,status:q.status});}
  } catch(e) {q.status='waiting';q.detail=/Receiving end|Could not establish connection/.test(e.message||'')?'无法连接目标对话页面，请刷新该页面后重试':e.message;}
  finally {delivering=false;if(q.status!==previousStatus||q.detail!==previousDetail)update(true);if(['sent','filled'].includes(q.status))void deliver();}
}
async function command(msg,sender) {
  await initialized;
  if(msg.type==='__persist_target'){await saveSession('target');update();return {ok:true};}
  if(msg.type==='__notify'){update();return {ok:true};}
  if(msg.type==='get_state') return state;
  if(msg.type==='check_composer'){
    if(!state.target)throw new Error('请先绑定目标对话。');
    const tab=await chrome.tabs.get(state.target.tabId);
    if(!Sites.site(tab.url)||key(tab.url)!==key(state.target.url))throw new Error('目标标签页已切换对话，请重新绑定。');
    receiverVersions.delete(tab.id);
    const result=await sendToComposer(tab.id,{type:'probe_composer',expectedKey:key(state.target.url)});
    return {ok:!!result?.ready,message:result?.ready?'已连接目标输入框，无需刷新网页。':'输入框暂未就绪；请在绑定的对话页显示输入框后重试。'};
  }
  if(msg.type==='translation_retry'){connect().postMessage({type:'translation_retry'});queueTranslation(state.transcripts);return {ok:true};}
  if(['configure_api','api_status','retry_api','test_api'].includes(msg.type)){connect().postMessage({type:msg.type,provider:msg.provider,...(msg.type==='configure_api'?{key:String(msg.key||'')}: {})});return {ok:true};}
  if(['configure_asr','asr_status','test_asr'].includes(msg.type)){connect().postMessage({type:msg.type,model:state.config.asrModel,...(msg.type==='configure_asr'?{key:String(msg.key||''),region:msg.region}:{})});return {ok:true};}
  if(msg.type==='get_tabs') {const query={url:Sites.matches};if(windowId!=null)query.windowId=windowId;return (await chrome.tabs.query(query)).map(t=>({id:t.id,title:t.title,url:t.url,provider:Sites.site(t.url)?.name}));}
  if(msg.type==='bind') {const tab=await chrome.tabs.get(Number(msg.tabId));if(!Sites.site(tab.url))throw new Error('请选择 ChatGPT、DeepSeek 或千问标签页');if(await targetTaken(tab.id,key(tab.url),sessionId))throw new Error('这个对话已绑定到另一个独立窗口，请选择本窗口的对话。');if(state.target&&(state.target.tabId!==tab.id||key(state.target.url)!==key(tab.url))){for(const q of state.questions)if(['pending','waiting'].includes(q.status)){q.status='held';q.requested=false;q.detail='旧对话的问题，可手动填入';}}state.target={tabId:tab.id,title:tab.title,url:tab.url,windowId:tab.windowId};await saveSession('target');update(true);void deliver();return {ok:true};}
  if(msg.type==='config') {
    const c=msg.value||{};
    if(Object.hasOwn(c,'asrModel')){
      if(!ASR_MODELS.includes(c.asrModel))throw new Error('请选择受支持的转写模型。');
      if(state.running||state.status==='stopping'||state.asr?.state==='testing')throw new Error('请先停止监听或等待连接测试结束，再切换转写模型。');
      state.config.asrModel=c.asrModel;
      state.asr={...state.asr,model:c.asrModel,state:'ready',message:'转写模型已切换，请点击测试连接或开始监听。'};
    }
    for(const k of ['autoFill','autoSend','liveExpanded','confirmSelection','translationEnabled'])if(typeof c[k]==='boolean')state.config[k]=c[k];
    if(['auto','en','zh'].includes(c.language))state.config.language=c.language;
    if(['tencent','all','tencent-text','aliyun-all','aliyun-tencent','aliyun-other'].includes(c.source))state.config.source=c.source;
    if(typeof c.hotwords==='string')state.config.hotwords=c.hotwords.slice(0,4000);
    if(['manual','rules','semantic'].includes(c.questionMode))state.config.questionMode=c.questionMode;
    if(['qwen-mt','deepseek'].includes(c.translationProvider))state.config.translationProvider=c.translationProvider;
    if(state.config.questionMode==='manual'){state.config.autoFill=false;state.config.autoSend=false;}
    if(Number.isInteger(c.fontSize)&&c.fontSize>=10&&c.fontSize<=32)state.config.fontSize=c.fontSize;
    await saveSession('config');
    if(typeof c.translationEnabled==='boolean'||['qwen-mt','deepseek'].includes(c.translationProvider)){if(state.config.translationEnabled)connect();syncTranslation();if(!state.config.translationEnabled)state.translation={state:'off',message:'中文翻译已关闭'};}
    update();void deliver();return {ok:true};
  }
  if(msg.type==='start') {if(state.running||state.status==='stopping')return {ok:true};state.liveLines=[];state.partial=null;state.startedAt=Date.now();state.status='loading';state.running=true;state.message='正在准备实时转写…';update();connect().postMessage({type:'start',source:state.config.source,language:state.config.language,questionMode:state.config.questionMode,hotwords:state.config.hotwords,asrModel:state.config.asrModel});return {ok:true};}
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
  if(msg.type==='clear') {state.transcripts=[];state.questions=[];port?.postMessage({type:'translation_clear'});await saveSession('history');update();return {ok:true};}
  if(msg.type==='composer_ready' && sender.tab?.id===state.target?.tabId) {void deliver();return {ok:true};}
  if(msg.type==='open_panel') {await openIndependentWindow();return {ok:true};}
}

  return {sessionId,state,command,receiverVersions,ready:initialized,notify:()=>update(),setWindowId:(id)=>{windowId=id},getWindowId:()=>windowId};
}

async function targetTaken(tabId, conversationKey, exceptSession){
  for(const [id,s] of sessions){if(id===exceptSession)continue;await s.ready;if(s.state.target?.tabId===tabId&&Sites.key(s.state.target.url)===conversationKey)return true;}
  const saved=await chrome.storage.local.get(['target','meetingSessions']);
  if(exceptSession!=='legacy'&&saved.target?.tabId===tabId&&Sites.key(saved.target.url)===conversationKey)return true;
  for(const [id,record] of Object.entries(saved.meetingSessions||{})){if(id!==exceptSession&&record.target?.tabId===tabId&&Sites.key(record.target.url)===conversationKey)return true;}
  return false;
}
async function openIndependentWindow(){
  const id=newSessionId();
  const url=chrome.runtime.getURL(`panel.html?session=${encodeURIComponent(id)}`);
  const win=await chrome.windows.create({url,type:'normal',focused:true});
  if(win?.id!=null){windowSessions.set(win.id,id);await saveWindowMap();}
  await createSession(id,null,win?.id??null);
  return {sessionId:id,windowId:win?.id};
}
async function resolveSession(msg,sender){
  await loadWindowMap();
  if(msg.type==='session_context'){
    const requested=typeof msg.sessionId==='string'&&/^[a-zA-Z0-9_-]{8,100}$/.test(msg.sessionId)?msg.sessionId:null;
    const wid=Number.isInteger(msg.windowId)?msg.windowId:(Number.isInteger(sender.windowId)?sender.windowId:null);
    let id=requested||(wid!=null?windowSessions.get(wid):null);
    if(!id){
      const legacy=await chrome.storage.local.get(['config','history','target']);const hasLegacy=!!(legacy.config||legacy.history||legacy.target);
      id=hasLegacy&&![...windowSessions.values()].includes(DEFAULT_SESSION)?DEFAULT_SESSION:newSessionId();
      if(wid!=null){windowSessions.set(wid,id);await saveWindowMap();}
    }
    const s=await createSession(id,null,wid);return {session:s,sessionId:id,windowId:wid};
  }
  if(typeof msg.sessionId==='string'&&msg.sessionId){const s=await createSession(msg.sessionId,null,Number.isInteger(sender.windowId)?sender.windowId:null);return {session:s,sessionId:msg.sessionId};}
  if(msg.type==='composer_ready'&&sender.tab?.id){for(const s of sessions.values()){await s.ready;if(s.state.target?.tabId===sender.tab.id)return {session:s,sessionId:s.sessionId};}}
  const s=await createSession(DEFAULT_SESSION,null,Number.isInteger(sender.windowId)?sender.windowId:null);return {session:s,sessionId:DEFAULT_SESSION};
}
chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
  if(msg.type==='state')return false;
  if(sender.tab&& !sender.url?.startsWith(chrome.runtime.getURL?.('')||'chrome-extension://') && msg.type!=='composer_ready')return false;
  resolveSession(msg,sender).then(ctx=>msg.type==='session_context'?{sessionId:ctx.sessionId,windowId:ctx.windowId}:ctx.session.command(msg,sender)).then(reply).catch(e=>reply({error:e.message}));return true;
});
chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true}).catch(()=>{});
chrome.tabs.onUpdated.addListener(async(id,change,tab)=>{
  for(const session of sessions.values()){await session.ready;session.receiverVersions.delete(id);const target=session.state.target;if(id!==target?.tabId||!change.url)continue;if(Sites.adopt(target.url,tab.url)){target.url=tab.url;target.title=tab.title;await session.command({type:'__persist_target'},{});}}
});
chrome.tabs.onRemoved.addListener(async id=>{for(const session of sessions.values()){await session.ready;session.receiverVersions.delete(id);if(id===session.state.target?.tabId){session.state.message='目标对话已关闭，请重新绑定';session.notify();}}});
chrome.windows?.onRemoved?.addListener(async id=>{const sid=windowSessions.get(id);windowSessions.delete(id);await saveWindowMap();if(sid&&sessions.has(sid)){const session=sessions.get(sid);await session.ready;if(session.state.running||session.state.status==='stopping')await session.command({type:'stop'},{});}});
