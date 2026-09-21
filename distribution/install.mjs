// Installer for the prebuilt macOS bundle. No system Node/Python or administrator access.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const exists=filename=>fs.existsSync(filename);
function verify(app){execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',app],{stdio:'pipe'});}
function digestApp(app){
  const hash=crypto.createHash('sha256');
  function visit(folder){
    for(const entry of fs.readdirSync(folder,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      if(entry.name==='_CodeSignature')continue;
      const filename=path.join(folder,entry.name),relative=path.relative(app,filename);
      if(entry.isSymbolicLink())throw Error('Unexpected symbolic link in capture app');
      if(entry.isDirectory()){visit(filename);continue;}
      let data=fs.readFileSync(filename);
      if(relative.startsWith('Contents/MacOS/')){
        const temp=fs.mkdtempSync(path.join(os.tmpdir(),'meetingbridge-signature-'));
        try{
          const copy=path.join(temp,'capture');fs.copyFileSync(filename,copy);
          execFileSync('/usr/bin/codesign',['--remove-signature',copy],{stdio:'pipe'});
          data=fs.readFileSync(copy);
          if(data.readUInt32LE(0)!==0xfeedfacf)throw Error('Expected thin 64-bit capture executable');
          let offset=32;
          for(let i=0;i<data.readUInt32LE(16);i++){
            const command=data.readUInt32LE(offset),size=data.readUInt32LE(offset+4);
            if(size<8||offset+size>data.length)throw Error('Invalid Mach-O command');
            if(command===0x19&&data.subarray(offset+8,offset+24).toString().replaceAll('\0','')==='__LINKEDIT')data.writeBigUInt64LE(0n,offset+32);
            offset+=size;
          }
        }finally{fs.rmSync(temp,{recursive:true,force:true});}
      }
      hash.update(relative+'\0'+data.length+'\0');hash.update(data);
    }
  }
  visit(app);return hash.digest('hex');
}

export function installBundle({bundle,runtime,nativeHosts}){
  if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('此安装包仅支持 Apple Silicon Mac；Intel Mac 请按 README 从源码构建。');
  bundle=path.resolve(bundle);runtime=path.resolve(runtime);nativeHosts=path.resolve(nativeHosts);
  if(runtime===bundle||runtime.startsWith(bundle+path.sep)||bundle.startsWith(runtime+path.sep))throw Error('安装目录不能与下载目录重叠。');
  const appName='Meeting Bridge Audio.app',sourceApp=path.join(bundle,appName),targetApp=path.join(runtime,appName);
  for(const entry of ['host/bridge.mjs','node_modules/ws/package.json','node-runtime/node','extension/manifest.json']){
    if(!fs.statSync(path.join(bundle,entry)).isFile())throw Error('安装包不完整：'+entry);
  }
  verify(sourceApp);
  const manifest=JSON.parse(fs.readFileSync(path.join(bundle,'extension/manifest.json'),'utf8'));
  const id=[...crypto.createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32)].map(n=>String.fromCharCode(97+parseInt(n,16))).join('');
  let preserveCapture=false;
  if(exists(targetApp))try{verify(targetApp);preserveCapture=digestApp(sourceApp)===digestApp(targetApp);}catch{}
  for(const folder of [runtime,nativeHosts]){
    if(exists(folder)&&fs.lstatSync(folder).isSymbolicLink())throw Error('安装目录不能是符号链接。');
    fs.mkdirSync(folder,{recursive:true,mode:0o700});
  }
  const stage=fs.mkdtempSync(path.join(runtime,'.install-')),changed=[];
  const registration=path.join(nativeHosts,'local.meetingbridge.json');
  const oldRegistration=exists(registration)?fs.readFileSync(registration):null;
  try{
    const names=['host','node_modules','node-runtime','extension',...(preserveCapture?[]:[appName])];
    for(const name of names)fs.cpSync(path.join(bundle,name),path.join(stage,name),{recursive:true});
    const launcher=path.join(stage,'host/launch-host');
    fs.writeFileSync(launcher,'#!/bin/sh\nexec '+quote(path.join(runtime,'node-runtime/node'))+' '+quote(path.join(runtime,'host/bridge.mjs'))+' "$@"\n',{mode:0o755});
    fs.chmodSync(launcher,0o755);
    fs.chmodSync(path.join(stage,'node-runtime/node'),0o755);
    if(!preserveCapture)verify(path.join(stage,appName));
    for(const name of names){
      const target=path.join(runtime,name),backup=path.join(stage,name+'.previous');
      const hadPrevious=exists(target);if(hadPrevious)fs.renameSync(target,backup);
      changed.push({target,backup,hadPrevious});fs.renameSync(path.join(stage,name),target);
    }
    const next=path.join(stage,'native-host.json');
    fs.writeFileSync(next,JSON.stringify({name:'local.meetingbridge',description:'Meeting Bridge local audio host',path:path.join(runtime,'host/launch-host'),type:'stdio',allowed_origins:['chrome-extension://'+id+'/']},null,2)+'\n',{mode:0o600});
    // Stage on the destination filesystem to make registration replacement atomic.
    const tempManifest=path.join(nativeHosts,'.meetingbridge-'+crypto.randomUUID()+'.json');
    try{fs.copyFileSync(next,tempManifest);fs.chmodSync(tempManifest,0o600);fs.renameSync(tempManifest,registration);}finally{fs.rmSync(tempManifest,{force:true});}
  }catch(error){
    for(const {target,backup,hadPrevious} of changed.reverse()){
      fs.rmSync(target,{recursive:true,force:true});if(hadPrevious)fs.renameSync(backup,target);
    }
    if(oldRegistration)fs.writeFileSync(registration,oldRegistration,{mode:0o600});else fs.rmSync(registration,{force:true});
    throw error;
  }finally{fs.rmSync(stage,{recursive:true,force:true});}
  return {runtime,extension:path.join(runtime,'extension'),id,preserveCapture};
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  try{
    const options={bundle:path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),runtime:path.join(os.homedir(),'Library/Application Support/MeetingBridge'),nativeHosts:path.join(os.homedir(),'Library/Application Support/Google/Chrome/NativeMessagingHosts')};
    for(let i=2;i<process.argv.length;i+=2){
      const key={'--runtime-dir':'runtime','--native-host-dir':'nativeHosts'}[process.argv[i]];
      if(!key||!process.argv[i+1])throw Error('未知安装参数');options[key]=process.argv[i+1];
    }
    const result=installBundle(options);
    console.log('安装完成。'+(result.preserveCapture?'已保留原有采集程序和授权身份。':'首次使用时请按 macOS 提示允许系统声音录制。'));
    console.log('\nChrome 打开 chrome://extensions，开启开发者模式，加载已解压的扩展程序。\n选择：\n'+result.extension+'\n\n文件选择器可按 ⇧⌘G 粘贴上面的路径。\n扩展 ID：'+result.id+'\n安装和使用指引见包内 README.md。');
  }catch(error){console.error('安装失败：'+error.message);process.exitCode=1;}
}
