// The same cloud sentence is sent as both a history upsert and a live preview.
// Render one copy, preferring the upsert because the preview can briefly lag.
export function transcriptRows(state){
  const rows=state.transcripts||[],partial=state.partial;
  if(!partial?.text?.trim())return rows;
  const last=rows.at(-1);
  if(rows.some(row=>row.id===partial.piece)||last?.text===partial.text)return rows;
  if(partial.piece==='tencent-text')return rows;
  return [...rows,{id:`live-${state.startedAt||0}-${partial.piece}`,text:partial.text,final:false,at:state.startedAt||Date.now(),temporary:true}];
}
