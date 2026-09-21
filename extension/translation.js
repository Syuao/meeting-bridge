export function translationCandidates(rows,limit=8){
  return rows.slice(-limit).filter(row=>typeof row.text==='string'&&row.text.trim().length>1&&row.text.length<=6000&&/[a-z]{2}/i.test(row.text)&&!(row.translation?.sourceText===row.text&&row.translation.text&&row.translation.complete!==false)).map(({id,text,final})=>({id,text,final:final!==false}));
}
export function translationText(row){return row.translation?.text||'';}
export function translationPending(row){return !!row.translation&&(row.translation.sourceText!==row.text||row.translation.complete===false);}
