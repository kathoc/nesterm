import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {demoEvents} from './demo-events.mjs';
import {positionalArgs,requireRomPath} from './runtime-paths.mjs';

const args=process.argv.slice(2),positionals=positionalArgs(args);
const seconds=Number(positionals[0]||45);
const size=positionals[1]||'40x25';
if(!['40x25','64x30'].includes(size))throw new Error('Invalid size');
if(!Number.isFinite(seconds)||seconds<1||seconds>120)throw new Error('Duration must be 1..120s');
const out=size==='64x30'?'artifacts/08-terminal-64x30':'artifacts/05-terminal';await mkdir(out,{recursive:true});
const rom=requireRomPath(args);
const child=spawn(process.execPath,['bin/nesterm.mjs',rom,'--size',size,'--seconds',String(seconds),'--fps','60','--record',`${out}/session.cast`],{stdio:['pipe','pipe','inherit']});
const done=once(child,'exit');
const timers=[];
let started=false,bytes=0;
const codes={a:120,b:122,start:13,select:32,up:119,down:115,left:97,right:100};
const events=demoEvents(seconds*60);
child.stdout.on('data',data=>{
  bytes+=data.length;
  if(started)return;started=true;
  for(const [frame,name,down] of events) {
    if(frame/60>=seconds)continue;
    timers.push(setTimeout(()=>{if(!child.stdin.destroyed)child.stdin.write(`\x1b[${codes[name]};1:${down?1:3}u`);},frame/60*1000));
  }
});
const limit=setTimeout(()=>child.kill('SIGKILL'),(seconds+15)*1000);
try {
  const [code]=await done;if(code!==0)throw new Error(`CLI exit ${code}`);
  await writeFile(`${out}/input.json`,JSON.stringify({seconds,events,bytes,method:'CLI in real time; scripted Kitty key-down/up sequences via stdin; output is the actual ANSI stream'},null,2));
  console.log(JSON.stringify({out,bytes,seconds}));
} finally {for(const timer of timers)clearTimeout(timer);clearTimeout(limit);child.stdin.destroy();if(child.exitCode===null)child.kill('SIGKILL');}
