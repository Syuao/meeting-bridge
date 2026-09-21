// Called from the completed selection gesture, before focusing the ChatGPT page.
export async function writeClipboard(text){
  try{await navigator.clipboard.writeText(text);return true;}catch{}
  // A copy event preserves the visible selection; no hidden textarea steals focus.
  let copied=false;
  const handle=event=>{if(!event.clipboardData)return;event.clipboardData.setData('text/plain',text);event.preventDefault();copied=true;};
  document.addEventListener('copy',handle);
  try{document.execCommand('copy');}catch{}finally{document.removeEventListener('copy',handle);}
  return copied;
}
