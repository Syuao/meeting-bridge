import {createHash} from 'node:crypto';
export function parseCaptionLines(lines){
  const rows=[];let current=null;
  for(const item of lines||[]){
    const text=String(item.text||'').trim();
    if(/^(?:实时转写|文字转写|请输入关键词|机器识别仅供参考|搜索|导出)$/.test(text))continue;
    const match=text.match(/(\d{1,2}[:：]\d{2}[:：]\d{2})/);
    if(match){current={key:match[1].replace(/：/g,':').padStart(8,'0'),speaker:text.slice(0,match.index).trim(),lines:[]};rows.push(current);}
    else if(current&&text)current.lines.push(text);
  }
  return rows.map(row=>({...row,text:row.lines.join('\n')})).filter(row=>row.text);
}
export class CaptionTracker{
  constructor(){this.rows=new Map();this.initial=true;this.latest='';this.prefix=createHash('sha256').update(String(Date.now())+Math.random()).digest('hex').slice(0,8);}
  ingest(lines,now=Date.now()){
    const parsed=parseCaptionLines(lines),events=[],changed=[],previousLatest=this.latest;
    for(const row of parsed){
      const old=this.rows.get(row.key);
      if(old?.text===row.text)continue;
      // A paragraph clipped at the bottom of the visible panel must not erase
      // text that was already captured in full.
      if(old?.text.startsWith(row.text)&&row.text.length<old.text.length)continue;
      const value={id:`caption-${this.prefix}-${row.key}`,text:row.text,speaker:row.speaker,at:old?.at||now,source:'tencent-text',sourceTime:row.key,ms:0};
      const eligible=!this.initial&&row.key>=previousLatest;
      this.rows.set(row.key,value);events.push({...value,backfill:!eligible});if(eligible)changed.push(value);
      if(row.key>this.latest)this.latest=row.key;
    }
    if(parsed.length)this.initial=false;
    const recent=[...this.rows.values()].sort((a,b)=>a.sourceTime.localeCompare(b.sourceTime)).slice(-8);
    return {events,changed,recent,partial:parsed.at(-1)?.text||'',found:parsed.length>0};
  }
}
