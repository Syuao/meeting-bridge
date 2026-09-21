(() => {
  const sites=[
    {id:'chatgpt',name:'ChatGPT',origins:['https://chatgpt.com'],selectors:['#prompt-textarea']},
    {id:'deepseek',name:'DeepSeek',origins:['https://chat.deepseek.com'],selectors:['textarea[placeholder*="DeepSeek"]','textarea[placeholder*="发送消息"]']},
    {id:'qianwen',name:'千问',origins:['https://www.qianwen.com','https://qianwen.com'],selectors:['[contenteditable="true"][role="textbox"]','textarea[placeholder*="千问"]','[contenteditable="true"][data-placeholder*="千问"]']},
    {id:'qwen',name:'Qwen',origins:['https://chat.qwen.ai'],selectors:['#chat-input','[contenteditable="true"][role="textbox"]','textarea[placeholder]']}
  ];
  function site(url){try{const u=new URL(url);return sites.find(s=>s.origins.includes(u.origin))||null;}catch{return null;}}
  function key(url){try{const u=new URL(url);if(!site(url))return '';const query=new URLSearchParams(u.search);for(const k of [...query.keys()])if(/^(utm_|spm$|ref$|from$)/.test(k))query.delete(k);query.sort();return u.origin+(u.pathname.replace(/\/$/,'')||'/')+(query.size?'?'+query:'')+u.hash;}catch{return '';}}
  function adopt(from,to){
    try{const a=new URL(from),b=new URL(to);if(!site(from)||a.origin!==b.origin||key(from)===key(to))return false;
      const root=['/','/chat','/chat/'].includes(a.pathname)&&!a.search&&!a.hash;
      const conversation=/^\/(?:c|chat|a\/chat\/s)\/[^/]+/.test(b.pathname)||['chatId','conversationId','sessionId'].some(k=>b.searchParams.has(k))||/^#\/(?:c|chat)\//.test(b.hash);
      return root&&conversation;
    }catch{return false;}
  }
  globalThis.MeetingBridgeSites={sites,site,key,adopt,matches:sites.flatMap(s=>s.origins.map(o=>o+'/*'))};
})();
