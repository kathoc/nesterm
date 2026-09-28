import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import xterm from '@xterm/headless';
import {createCanvas,GlobalFonts} from '@napi-rs/canvas';
import {findMonoFont} from './runtime-paths.mjs';

// Render the recorded ANSI stream with an independent terminal parser.
const source=process.argv[2];
if(!source) throw new Error('Usage: node scripts/terminal-video.mjs path/to/session.cast');
const data=(await readFile(source,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
const header=data.shift();
const wide=header.width===64,width=wide?888:720,height=wide?800:600;
const end=Math.min(120,data.at(-1)[0]);
const out=source.replace(/\.cast$/,'');
GlobalFonts.registerFromPath(findMonoFont(),'TerminalMono');
const terminal=new xterm.Terminal({cols:header.width,rows:header.height,allowProposedApi:true});
const canvas=createCanvas(width,height),ctx=canvas.getContext('2d');
const encoder=spawn('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','rawvideo','-pixel_format','rgba','-video_size',`${width}x${height}`,'-framerate','30','-i','-','-an','-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',out+'.mp4'],{stdio:['pipe','ignore','inherit']});
const done=once(encoder,'exit');
const deadline=Date.now()+180000;
const timer=setTimeout(()=>{encoder.kill('SIGKILL');process.exit(2);},185000);
let e=0,unique=new Set(),maxNonblank=0;
try {
  for(let f=0;f<Math.ceil(end*30);f++) {
    if(Date.now()>deadline) throw new Error('Deadline exceeded');
    while(e<data.length&&data[e][0]<=f/30) {
      if(data[e][1]==='o') await new Promise(resolve=>terminal.write(data[e][2],resolve));
      e++;
    }
    ctx.fillStyle='#080b10';ctx.fillRect(0,0,width,height);
    ctx.font='14px TerminalMono';ctx.fillStyle='#90b6aa';
    ctx.fillText(`NESTERM / recorded terminal ANSI / ${(f/30).toFixed(1)}s`,30,25);
    ctx.font='20px TerminalMono';
    let nonblank=0;
    for(let y=0;y<header.height;y++) {
      const line=terminal.buffer.active.getLine(y);
      for(let x=0;x<header.width;x++) {
        const cell=line.getCell(x),ch=cell.getChars()||' ';
        if(ch!==' ') nonblank++;
        unique.add(ch);
        const color=cell.isFgRGB()?cell.getFgColor():0xd8f0dd;
        ctx.fillStyle='#'+color.toString(16).padStart(6,'0');
        ctx.fillText(ch,60+x*(wide?12:15),65+y*(wide?24:21));
      }
    }
    maxNonblank=Math.max(maxNonblank,nonblank);
    if(!encoder.stdin.write(ctx.getImageData(0,0,width,height).data))await once(encoder.stdin,'drain');
    if(f===Math.floor(end*30*.75))await writeFile(out+'.png',canvas.toBuffer('image/png'));
  }
  encoder.stdin.end();const [code]=await done;if(code!==0)throw new Error('ffmpeg failed');
  await writeFile(out+'-checks.json',JSON.stringify({source,seconds:end,grid:[header.width,header.height],ascii:[...unique].every(s=>/^[ -~]$/.test(s)),uniqueCharacters:[...unique].sort().join(''),maxNonblank,method:'Actual CLI ANSI stream parsed by independent xterm and rasterized to video'},null,2));
  console.log(out+'.mp4');
}finally{clearTimeout(timer);encoder.stdin.destroy();terminal.dispose();if(encoder.exitCode===null)encoder.kill('SIGKILL');}
