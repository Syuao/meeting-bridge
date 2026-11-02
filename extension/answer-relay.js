import {shareCodeEditor} from './sharecode-editor.js';
export const SHARECODE_MATCH = 'https://kode666.com/room/*';
export function roomKey(url) {
  try { const u = new URL(url); return u.origin === 'https://kode666.com' && /^\/room\/[a-zA-Z0-9-]+\/?$/.test(u.pathname) ? u.origin + u.pathname.replace(/\/$/, '') : ''; } catch { return ''; }
}
export function createAnswerRelay({chrome, sites, sessionId, getTarget, getConfig, saveConfig, notify}) {
  let generation = 0, active = false, draining = false, pending = new Map();
  let status = {state:'unbound',message:'先绑定 ShareCode 房间'};
  const report = (state,message) => { status={state,message}; notify(status); };
  const config = () => getConfig() || {};
  async function rooms() {
    const tabs=(await chrome.tabs.query({url:SHARECODE_MATCH})).filter(tab=>roomKey(tab.url));
    return Promise.all(tabs.map(async tab=>{
      let name='';
      try {
        const result=await chrome.scripting.executeScript({target:{tabId:tab.id},func:expectedKey=>{
          const url=new URL(location.href);
          if(url.origin+url.pathname.replace(/\/$/,'')!==expectedKey)return '';
          const title=document.querySelector('header.editor-toolbar .editor-room-navigation > span[title]');
          return (title?.getAttribute('title')||title?.textContent||'').trim().slice(0,200);
        },args:[roomKey(tab.url)]});
        if(typeof result?.[0]?.result==='string')name=result[0].result;
      } catch {}
      return {id:tab.id,title:tab.title,url:tab.url,name};
    }));
  }
  async function runEditor(room, action, data={}, expectedGeneration=generation) {
    const tab = await chrome.tabs.get(room.tabId);
    if(action==='write' && (!active || expectedGeneration!==generation))throw Error('同步模式已变化，已取消待写入内容');
    if (roomKey(tab.url) !== room.key) throw Error('ShareCode 房间已切换，请重新绑定');
    const result = await chrome.scripting.executeScript({target:{tabId:room.tabId},world:'MAIN',func:shareCodeEditor,args:[{action,roomKey:room.key,documentToken:room.documentToken,...data}]});
    const value = result?.[0]?.result;
    if (!value?.ok) throw Error(value?.message || '无法连接 ShareCode 编辑器');
    return value;
  }
  function sourceConfig() {
    const target=getTarget(), c=config();
    return {enabled:!!(active && c.room && target),automatic:!!c.automatic,epoch:c.epoch,expectedKey:target ? sites.key(target.url) : ''};
  }
  function verifySource(health) {
    const expected=sourceConfig();
    if(!expected.enabled||!health?.ok||!health.enabled||!health.sameConversation||health.epoch!==expected.epoch||health.automatic!==expected.automatic)
      throw Error('网页划词监听尚未连接，请点击「绑定 / 重连」');
  }
  async function connectSource() {
    const target=getTarget(); if (!target) throw Error('请先绑定大模型对话');
    if (sites.site(target.url)?.id !== 'chatgpt') throw Error('回答同步首版支持 ChatGPT；其他网页仍可接收转写草稿');
    const tab=await chrome.tabs.get(target.tabId);
    if (sites.key(tab.url)!==sites.key(target.url)) throw Error('大模型对话已切换，请重新绑定');
    await chrome.scripting.executeScript({target:{tabId:target.tabId},files:['sites.js','answer-source.js']});
    const health=await chrome.tabs.sendMessage(target.tabId,{type:'answer_relay_config',...sourceConfig()});
    verifySource(health);
  }
  async function suspend(message='同步已暂停') {
    generation++; active=false; pending.clear();
    report('paused',message);
    const target=getTarget();
    if(target) await chrome.tabs.sendMessage(target.tabId,{type:'answer_relay_config',enabled:false}).catch(()=>{});
  }
  async function bind(tabId, taken) {
    const tab=await chrome.tabs.get(Number(tabId)), key=roomKey(tab.url);
    if (!key) throw Error('请选择 kode666.com 的 ShareCode 房间');
    if (await taken(key)) throw Error('此 ShareCode 房间已绑定到另一个窗口，请先在原窗口解除绑定');
    const room={tabId:tab.id,url:tab.url,key,title:tab.title};
    room.documentToken=(await runEditor(room,'probe')).documentToken;
    await suspend();
    await saveConfig({room,automatic:!!config().automatic,epoch:crypto.randomUUID()});
    active=true;
    try { await connectSource(); report('ready',config().automatic?'自动同步已开启，等待新回答':'划选同步已就绪：在回答中划词，松手即誊写'); }
    catch(e) { await suspend(e.message); throw e; }
    return {ok:true};
  }
  async function setMode(automatic) {
    await suspend();
    await saveConfig({...config(),automatic:!!automatic,epoch:crypto.randomUUID()});
    if(!config().room) { report('unbound','先绑定 ShareCode 房间'); return {ok:true}; }
    active=true;
    try { const probe=await runEditor(config().room,'probe'); if(probe.documentToken!==config().room.documentToken)throw Error('ShareCode 页面已重新加载，请点击「绑定 / 重连」'); await connectSource(); report('ready',automatic?'自动同步已开启，等待新回答':'划选同步已就绪：生成中也可以划词誊写'); }
    catch(e) {await suspend(e.message);throw e;}
    return {ok:true};
  }
  async function drain() {
    if(draining)return;
    draining=true;
    try {
      while(active && pending.size) {
        const [id,item]=pending.entries().next().value; pending.delete(id);
        if(item.generation!==generation)continue;
        const room=config().room;
        try {
          await runEditor(room,'write',item.payload,item.generation);
          if(item.generation===generation)report('syncing',item.manual?'划选内容已追加到 ShareCode':'正在流式同步到 ShareCode');
        } catch(e) {if(item.generation===generation)await suspend(e.message);}
      }
    } finally {draining=false;}
  }
  async function receive(msg,sender) {
    const target=getTarget(), c=config();
    if(!active || !target || !c.room || sender.frameId>0 || sender.tab?.id!==target.tabId || sites.key(sender.url||sender.tab.url)!==sites.key(target.url) || msg.epoch!==c.epoch) return {ok:false,message:'同步绑定已变化，请重新绑定房间'};
    const manual=msg.type==='answer_selection';
    if(manual === !!c.automatic) return {ok:false,message:'同步模式已变化'};
    if(typeof msg.text!=='string'||!msg.text.trim()||msg.text.length>100000||!/^[\w-]{1,100}$/.test(msg.id||'')||!Number.isSafeInteger(msg.revision))return {ok:false,message:'回答内容无效'};
    const id=c.epoch+'-'+msg.id;
    const previous=pending.get(id);
    if(!previous || previous.payload.revision<msg.revision) pending.set(id,{generation,manual,payload:{id,text:msg.text,revision:msg.revision}});
    if(pending.size>30){await suspend('待同步内容过多，请检查 ShareCode 页面');return {ok:false,message:status.message};}
    await drain();
    return {ok:active,message:status.message};
  }
  return {
    bind,setMode,receive,sourceConfig,suspend,rooms,
    async check(){
      try {
        const target=getTarget();if(!target)throw Error('请先绑定大模型对话');
        if(!sourceConfig().enabled)throw Error('同步已暂停，请点击「绑定 / 重连」');
        const tab=await chrome.tabs.get(target.tabId);
        if(sites.key(tab.url)!==sites.key(target.url))throw Error('大模型对话已切换，请重新绑定');
        const health=await chrome.tabs.sendMessage(target.tabId,{type:'answer_relay_probe'});
        verifySource(health);
        const room=config().room;
        const probe=await runEditor(room,'probe');
        if(probe.documentToken!==room.documentToken)throw Error('ShareCode 页面已重新加载，请点击「绑定 / 重连」');
        report('ready',config().automatic?'连接正常：自动誊写已开启':'连接正常：在 AI 回答中划词，松手即誊写');
        return {ok:true};
      }catch(e){await suspend(e.message);throw e;}
    },
    status:()=>status,
    async unbind(){await suspend();await saveConfig({automatic:!!config().automatic});report('unbound','已解除 ShareCode 绑定');return {ok:true};},
    async restore(){if(config().room){report('paused','同步已暂停；点击「绑定 / 重连」继续，避免重复誊写历史');}},
  };
}
