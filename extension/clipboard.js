// Copy during the gesture, while the panel owns focus. Do not wait for an async
// denial before using the synchronous path: activation/focus can be gone by then.
export async function writeClipboard(text){
  let handled=false,accepted=false;
  const handle=event=>{if(!event.clipboardData)return;event.clipboardData.setData('text/plain',text);event.preventDefault();handled=true;};
  document.addEventListener('copy',handle);
  try{accepted=document.execCommand('copy')===true;}catch{}finally{document.removeEventListener('copy',handle);}
  if(handled&&accepted)return true;
  try{await navigator.clipboard.writeText(text);return true;}catch{return false;}
}
