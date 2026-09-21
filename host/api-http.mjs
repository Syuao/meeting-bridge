import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';

export function apiError(provider,status,code='http'){
  const detail=({400:'请求参数不被接受',401:'密钥无效，请重新保存',402:'API 余额不足',403:'没有模型使用权限，请检查地域和授权',404:'当前地域未提供此模型',429:'请求限流，正在等待恢复'})[status]||(status>=500?'服务暂时异常':status?'请求失败':'网络连接失败或超时');
  return Object.assign(new Error(`${provider} ${detail}${status?`（HTTP ${status}）`:''}。`),{httpStatus:status||0,code,retryable:!status||status===408||status===409||status===429||status>=500});
}
// Keep credentials and quoted speech out of command arguments and error logs.
export function postJSON({endpoint,key,payload,provider,signal,onChunk,timeout=30}){
  const quote=s=>'"'+String(s).replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\n/g,'\\n').replace(/\r/g,'\\r')+'"';
  return new Promise((resolve,reject)=>{
    const config=['url = '+quote(endpoint),'request = "POST"','silent','show-error','no-buffer',`max-time = ${timeout}`,'connect-timeout = 8','header = "Content-Type: application/json"','header = '+quote('Authorization: Bearer '+key),'data = '+quote(JSON.stringify(payload)),'write-out = "\\n%{http_code}"'].join('\n');
    const child=spawn('/usr/bin/curl',['--config','-'],{stdio:['pipe','pipe','pipe'],signal});
    let output='',overflow=false;const decoder=new StringDecoder('utf8');
    child.stdout.on('data',buffer=>{const chunk=decoder.write(buffer);output+=chunk;if(output.length>1000000){overflow=true;child.kill();return;}try{onChunk?.(chunk);}catch{overflow=true;child.kill();}});
    child.stderr.on('data',()=>{});child.on('error',error=>reject(error.name==='AbortError'?error:apiError(provider,0,'network')));
    child.on('close',code=>{output+=decoder.end();if(signal?.aborted)return reject(Object.assign(new Error('Aborted'),{name:'AbortError'}));if(code||overflow)return reject(apiError(provider,0,overflow?'response_size':code===28?'timeout':'network'));
      const pos=output.lastIndexOf('\n'),status=Number(output.slice(pos+1));if(status!==200)return reject(apiError(provider,status));resolve({status,body:output.slice(0,pos)});
    });child.stdin.on('error',()=>{});child.stdin.end(config);
  });
}
