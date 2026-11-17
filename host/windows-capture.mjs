import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';

/**
 * Windows system-output capture adapter.
 *
 * It uses FFmpeg's WASAPI loopback input and emits the same event files that
 * the macOS ScreenCaptureKit helper emits. This keeps the browser/native host
 * protocol identical across platforms. The helper intentionally captures the
 * default Windows output device; application-level filtering is not promised.
 */
export const PCM_RATE=16000;
export const PCM_CHANNELS=1;
export const PCM_BYTES_PER_SAMPLE=2;
export const CHUNK_MS=200;
export const CHUNK_BYTES=PCM_RATE*CHUNK_MS/1000*PCM_CHANNELS*PCM_BYTES_PER_SAMPLE;
const runtimeRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const defaultFfmpeg=process.platform==='win32'?path.join(runtimeRoot,'ffmpeg.exe'):'ffmpeg';

export function parseArgs(argv=[]) {
  const out={};
  for(let i=0;i<argv.length;i++){
    const key=String(argv[i]);
    if(key.startsWith('--'))out[key.slice(2)]=argv[i+1]?.startsWith('--')||argv[i+1]==null?true:argv[++i];
  }
  return out;
}

export function ffmpegArgs({device=process.env.MEETINGBRIDGE_WASAPI_DEVICE||'default'}={}) {
  return ['-hide_banner','-loglevel','error','-f','wasapi','-loopback','1','-i',device,'-ar',String(PCM_RATE),'-ac',String(PCM_CHANNELS),'-f','s16le','-'];
}

export function rmsLevel(pcm) {
  if(!Buffer.isBuffer(pcm)||pcm.length<2)return 0;
  let sum=0,count=0;
  for(let i=0;i+1<pcm.length;i+=2){const v=pcm.readInt16LE(i)/32768;sum+=v*v;count++;}
  return Math.max(0,Math.min(1,Math.sqrt(sum/Math.max(1,count))*3));
}

function writeEvent(dir,seq,event) {
  const name=`event-${String(seq).padStart(12,'0')}.json`,tmp=path.join(dir,`.${name}.tmp`),target=path.join(dir,name);
  fs.writeFileSync(tmp,JSON.stringify(event));fs.renameSync(tmp,target);
}

export async function runCapture({session,source='all',parent,ffmpeg=process.env.MEETINGBRIDGE_FFMPEG||defaultFfmpeg}={}) {
  if(!session)throw new Error('缺少 Windows 采集会话目录。');
  fs.mkdirSync(session,{recursive:true});
  let seq=0,buffer=Buffer.alloc(0),stopping=false,child;
  const emit=(event)=>writeEvent(session,seq++,event);
  const stop=()=>{if(stopping)return;stopping=true;try{child?.kill('SIGTERM')}catch{}}
  child=spawn(ffmpeg,ffmpegArgs(),{stdio:['ignore','pipe','pipe'],windowsHide:true});
  child.on('error',error=>{emit({type:'error',message:`无法启动 FFmpeg：${error.code==='ENOENT'?'未找到 ffmpeg.exe，请先安装 FFmpeg 并加入 PATH。':error.message}`});});
  child.stderr.on('data',()=>{});
  child.stdout.on('data',data=>{
    buffer=Buffer.concat([buffer,data]);
    while(buffer.length>=CHUNK_BYTES){const chunk=buffer.subarray(0,CHUNK_BYTES);buffer=buffer.subarray(CHUNK_BYTES);if(!stopping)emit({type:'pcm',at:Date.now(),data:chunk.toString('base64')});if(!stopping)emit({type:'level',value:rmsLevel(chunk)});}
  });
  emit({type:'capture_started',at:Date.now(),source});
  const timer=setInterval(()=>{
    if(fs.existsSync(path.join(session,'stop')))stop();
    if(parent){try{process.kill(Number(parent),0)}catch{stop();}}
  },100);
  await new Promise(resolve=>child.on('close',resolve));
  clearInterval(timer);
  if(buffer.length&&!stopping){const even=buffer.subarray(0,buffer.length-buffer.length%2);if(even.length)emit({type:'pcm',at:Date.now(),data:even.toString('base64')});}
  emit({type:'capture_stopped',at:Date.now()});
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=parseArgs(process.argv.slice(2));
  runCapture({session:String(args.session||''),source:String(args.source||'all'),parent:args.parent}).catch(error=>{try{if(args.session)writeEvent(String(args.session),Date.now(),{type:'error',message:error.message})}catch{};process.exitCode=1;});
}
