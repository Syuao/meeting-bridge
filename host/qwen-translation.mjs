import {readASRConfig} from './aliyun-asr.mjs';
import {postJSON} from './api-http.mjs';
export const QWEN_MODEL='qwen-mt-flash';
export function qwenConfigured(root){try{return !!readASRConfig(root).key}catch{return false}}
export function qwenPayload(text){return {model:QWEN_MODEL,messages:[{role:'user',content:text}],translation_options:{source_lang:'auto',target_lang:'Chinese'},stream:true,stream_options:{include_usage:true}};}
export function createTranslationStream(onText){
  let buffer='',text='',usage,done=false,finish=false;
  function event(block){
    const data=block.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(!data)return;
    if(data.trim()==='[DONE]'){done=true;return;}
    let value;try{value=JSON.parse(data)}catch{throw Error('Qwen-MT 翻译响应格式不完整。')}
    if(value.error)throw Error('Qwen-MT 暂未完成翻译。');
    if(value.usage)usage={input_tokens:value.usage.prompt_tokens,output_tokens:value.usage.completion_tokens};
    const choice=value.choices?.[0];if(choice?.finish_reason==='stop')finish=true;
    if(choice?.finish_reason&&choice.finish_reason!=='stop')throw Error('Qwen-MT 译文未完整返回。');
    const chunk=choice?.delta?.content;if(typeof chunk==='string'&&chunk){text+=chunk;if(text.length>10000)throw Error('Qwen-MT 译文过长。');onText?.(text);}
  }
  return {push(chunk){buffer+=chunk;let match;while((match=/\r?\n\r?\n/.exec(buffer))){event(buffer.slice(0,match.index).replace(/\r\n/g,'\n'));buffer=buffer.slice(match.index+match[0].length);}},result(){if(!text.trim()||!done||!finish)throw Error('Qwen-MT 译文未完整返回。');return {text:text.trim(),usage};}};
}
export async function qwenTranslate(root,row,signal,onText){
  const {key,region}=readASRConfig(root),host=region==='singapore'?'dashscope-intl.aliyuncs.com':'dashscope.aliyuncs.com';
  const stream=createTranslationStream(onText);
  await postJSON({endpoint:`https://${host}/compatible-mode/v1/chat/completions`,key,payload:qwenPayload(row.text),provider:'Qwen-MT',signal,onChunk:chunk=>stream.push(chunk)});
  const {text,usage}=stream.result();return {result:{translations:[{id:row.id,text}]},usage};
}
