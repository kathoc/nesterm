// Deterministic real NES gameplay -> same ASCII renderer -> text raster -> MP4.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { Emulator } from '../src/emulator.mjs';
import { AsciiRenderer } from '../src/renderer.mjs';
import { demoEvents } from './demo-events.mjs';
import { findMonoFont, requireRomPath } from './runtime-paths.mjs';

const args = process.argv.slice(2);
const get = (key, fallback) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; };
const romPath = requireRomPath(args);
const stage = get('--stage', '01-ramp');
const mode = get('--mode', 'ramp');
const size=get('--size','40x25');
if(!['40x25','64x30'].includes(size))throw new Error('Invalid size');
const [cols,rows]=size.split('x').map(Number);
const wide=cols===64,width=wide?960:800,height=wide?840:660;
const frames = Number(get('--frames', '1800'));
if (!Number.isInteger(frames) || frames < 1 || frames > 7200 || !/^[\w-]+$/.test(stage)) throw new Error('Invalid capture arguments');
const out = `artifacts/${stage}`;
await mkdir(out, {recursive: true});
const rom = new Uint8Array(await readFile(romPath));
const font = findMonoFont();
GlobalFonts.registerFromPath(font, 'CaptureMono');
const canvas = createCanvas(width, height), ctx = canvas.getContext('2d');
const reference = createCanvas(256, 240), ref = reference.getContext('2d');
const renderer = new AsciiRenderer({cols,rows,mode});
const encoder = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${width}x${height}`, '-framerate', '30', '-i', '-', '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${out}/gameplay.mp4`], {stdio:['pipe', 'ignore', 'inherit']});
const done = once(encoder, 'exit');
const deadline = Date.now() + 180000;
const timer = setTimeout(() => { encoder.kill('SIGKILL'); process.exit(2); }, 185000);
let buffer, rendered, changed = 0, prior = '', unique = new Set();
const emu = new Emulator({onFrame: frame => { buffer = frame; }});
await emu.load(rom);
// Input program is versioned with every capture; no save-state or fabricated frames.
const eventsFile=get('--events',null);
const events = eventsFile ? JSON.parse(await readFile(eventsFile,'utf8')).events : demoEvents(frames);
events.sort((a,b) => a[0]-b[0]);
let eventIndex = 0;
try {
  for (let f = 0; f < frames; f++) {
    if (Date.now() > deadline) throw new Error('Capture deadline exceeded');
    while (events[eventIndex]?.[0] === f) {
      const [, button, down] = events[eventIndex++]; emu[down ? 'press' : 'release'](button);
    }
    emu.frame();
    if (f % 2) continue;
    rendered = renderer.render(buffer);
    if (rendered.chars !== prior) changed++;
    prior = rendered.chars;
    for (const ch of prior) unique.add(ch);
    ctx.fillStyle = '#080b10'; ctx.fillRect(0,0,width,height);
    ctx.font = '16px CaptureMono'; ctx.fillStyle = '#86e6b2';
    ctx.fillText(`NESTERM / ${stage} / ${cols} x ${rows} ASCII`, 40, 30);
    ctx.fillStyle = '#637387'; ctx.fillText(`nesjs 2.7.0 | frame ${String(f).padStart(4)} | ${(f / 60).toFixed(1)}s`, 40, 55);
    ctx.font = '20px CaptureMono';
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      ctx.fillStyle = '#' + rendered.colors[i].toString(16).padStart(6, '0');
      ctx.fillText(rendered.chars[i], (wide?96:100) + x * (wide?12:15), 86 + y * (wide?24:21));
    }
    ctx.font = '14px CaptureMono'; ctx.fillStyle = '#8a98a9';
    ctx.fillText('Actual ROM execution / scripted controller / no pixel graphics', 40, height-23);
    const raw = ctx.getImageData(0, 0, width, height).data;
    if (!encoder.stdin.write(raw)) await once(encoder.stdin, 'drain');
    if ([300, 600, 900, 1200, 1500, 1650, 1800, 2100, 2400, frames - 2].includes(f)) {
      await writeFile(`${out}/frame-${f}.png`, canvas.toBuffer('image/png'));
      await writeFile(`${out}/frame-${f}.txt`, rendered.text);
      const img = ref.createImageData(256,240);
      for(let i=0; i<buffer.length; i++) { const p=buffer[i]; img.data[i*4]=p&255; img.data[i*4+1]=(p>>8)&255; img.data[i*4+2]=(p>>16)&255; img.data[i*4+3]=255; }
      ref.putImageData(img,0,0);
      await writeFile(`${out}/reference-${f}.png`, reference.toBuffer('image/png'));
    }
  }
  encoder.stdin.end();
  const [code] = await done;
  if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
  const metadata = {stage, mode, grid:[cols,rows], frames, fps:30, emulationHz:60, seconds:frames/60, romSha256:createHash('sha256').update(rom).digest('hex'), events, changedFrames:changed, uniqueCharacters:[...unique].sort().join(''), capturedAt:new Date().toISOString(), method:'real nesjs frames; shared ASCII renderer; offline text raster at 30fps, not a desktop recording'};
  await writeFile(`${out}/capture.json`, JSON.stringify(metadata,null,2));
  console.log(JSON.stringify({out, changedFrames:changed, uniqueCharacters:metadata.uniqueCharacters}));
} finally { clearTimeout(timer); encoder.stdin.destroy(); if (encoder.exitCode === null) encoder.kill('SIGKILL'); }
