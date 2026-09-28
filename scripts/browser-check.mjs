import { chromium } from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {demoEvents} from './demo-events.mjs';
import {positionalArgs,requireRomPath} from './runtime-paths.mjs';

const args=process.argv.slice(2),positionals=positionalArgs(args);
const url=positionals[0] || 'http://127.0.0.1:4173/';
const stage=positionals[1] || '04-browser';
const size=positionals[2] || '40x25';
const romPath=requireRomPath(args);
if(!['40x25','64x30'].includes(size))throw new Error('Invalid size');
const [cols,rows]=size.split('x').map(Number);
if(!/^[\w-]+$/.test(stage)) throw new Error('Invalid stage');
const out=`artifacts/${stage}`;
await mkdir(out,{recursive:true});
const launchOptions={headless:true,args:['--no-sandbox']};
if(process.env.CHROME_PATH)launchOptions.executablePath=process.env.CHROME_PATH;
const browser=await chromium.launch(launchOptions);
const timer=setTimeout(()=>{browser.close();process.exitCode=2;},90000);
const context=await browser.newContext({viewport:{width:1100,height:1000},recordVideo:{dir:out,size:{width:1100,height:1000}}});
const page=await context.newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const httpErrors=[];page.on('response',r=>{if(r.status()>=400)httpErrors.push({url:r.url(),status:r.status()});});
const requests=[];page.on('request',r=>requests.push({url:r.url(),method:r.method()}));
page.setDefaultTimeout(12000);
try {
  await page.goto(url);
  await page.waitForFunction(()=>!!window.nesterm);
  await page.locator('#grid-size').selectOption(size);
  await page.screenshot({path:`${out}/empty.png`,fullPage:true});
  await page.locator('#rom').setInputFiles(romPath);
  const keys={start:'Enter',a:'x',b:'z',right:'ArrowRight',up:'ArrowUp'};
  let capturedStart=false,capturedScroll=false;
  for(const [frame,name,down] of demoEvents(2100)) {
    await page.waitForFunction(f=>window.nesterm.stats.emulatorFrames>=f,frame,{timeout:25000});
    if(frame>=1450&&!capturedStart) {
      await page.screenshot({path:`${out}/game-start.png`,fullPage:true});capturedStart=true;
    }
    if(frame>=1630&&!capturedScroll) {
      await page.screenshot({path:`${out}/scrolling.png`,fullPage:true});capturedScroll=true;
    }
    await page.keyboard[down?'down':'up'](keys[name]);
  }
  for(const key of Object.values(keys)) await page.keyboard.up(key);
  await page.screenshot({path:`${out}/gameplay.png`,fullPage:true});
  const state=await page.evaluate(()=>({stats:window.nesterm.stats,text:document.querySelector('#screen').textContent}));
  assert.equal(state.text.split('\n').length,rows);
  assert.ok(state.text.split('\n').every(row=>row.length===cols));
  assert.match(state.text,/^[\x20-\x7e\n]+$/);
  await page.locator('#pause').click();
  const paused=await page.evaluate(()=>window.nesterm.stats.emulatorFrames);
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(()=>window.nesterm.stats.emulatorFrames),paused);
  await page.locator('#grid-size').selectOption(size==='40x25'?'64x30':'40x25');
  assert.equal(await page.evaluate(()=>window.nesterm.stats.emulatorFrames),paused);
  await page.locator('#grid-size').selectOption(size);
  await page.locator('#color-mode').selectOption('mono');
  await page.screenshot({path:`${out}/mono.png`,fullPage:true});
  await page.locator('#render-mode').selectOption('ramp');
  await page.locator('#render-mode').selectOption('shape');
  await page.locator('#color-mode').selectOption('color');
  await page.locator('#pause').click();
  await page.locator('#mute').click();
  await page.waitForTimeout(1400);
  const audio=await page.evaluate(()=>window.nesterm.stats);
  await page.locator('#reset').click();
  assert.ok((await page.evaluate(()=>window.nesterm.stats.emulatorFrames))<120);
  const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const mobilePage=await mobile.newPage();
  await mobilePage.goto(url);
  await mobilePage.waitForFunction(()=>!!window.nesterm);
  await mobilePage.locator('#grid-size').selectOption(size);
  await mobilePage.locator('#rom').setInputFiles(romPath);
  await mobilePage.waitForFunction(()=>window.nesterm.stats.emulatorFrames>150);
  const box=await mobilePage.locator('[data-key="a"]').boundingBox();
  assert.ok(box && box.width>0,'Touch controls must be visible');
  const cdp=await mobile.newCDPSession(mobilePage);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2}]});
  assert.ok(await mobilePage.evaluate(()=>(window.nesterm.emulator.nes.getInput(1)&1)!==0));
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  assert.equal(await mobilePage.evaluate(()=>window.nesterm.emulator.nes.getInput(1)&1),0);
  await mobilePage.screenshot({path:`${out}/mobile.png`,fullPage:true});
  const overflow=await mobilePage.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
  await mobile.close();
  assert.equal(overflow,false);
  assert.deepEqual(errors,[]);
  assert.deepEqual(httpErrors,[]);
  assert.ok(!requests.some(r=>r.method==='POST'),'Local ROM must not be uploaded');
  const results={url,stage,game:state.stats,audio,ascii:true,grid:[cols,rows],pause:true,reset:true,gridSwitchKeepsFrame:true,mobileNoOverflow:true,touchPressRelease:true,pageErrors:errors,httpErrors,requests:requests.length};
  await writeFile(`${out}/checks.json`,JSON.stringify(results,null,2));
  console.log(JSON.stringify(results));
} finally {
  await context.close();await browser.close();clearTimeout(timer);
}
