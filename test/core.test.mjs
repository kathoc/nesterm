import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AsciiRenderer} from '../src/renderer.mjs';
import {ShapeMatcher} from '../src/shape.mjs';
import {GLYPHS,GLYPHS_TALL} from '../src/glyphs.mjs';
import {Emulator} from '../src/emulator.mjs';

test('40x25 output uses only printable ASCII, including blank screen',()=>{
  for(const mode of ['ramp','shape']) {
    const r=new AsciiRenderer({mode});
    for(const pixel of [0,0xffffff,0x705020]) {
      const f=r.render(new Uint32Array(61440).fill(pixel));
      assert.equal(f.chars.length,1000);
      assert.match(f.chars,/^[\x20-\x7e]+$/);
      assert.equal(f.text.split('\n').length,25);
      assert.ok(f.text.split('\n').every(line=>line.length===40));
      assert.equal(f.colors.length,1000);
    }
  }
});

test('fractional motion changes glyph before the next whole-cell boundary',()=>{
  const r=new ShapeMatcher(40,25),outputs=[];
  for(let shift=0;shift<6;shift++) {
    const frame=new Uint32Array(61440);
    for(let y=91;y<103;y++) for(let x=78+shift;x<82+shift;x++) frame[y*256+x]=0xffffff;
    outputs.push(r.render(frame,false).chars);
  }
  assert.ok(new Set(outputs).size>=3,'Sub-cell motion should change shape in at least 3 positions');
});

test('identical frames stabilize and reset is deterministic',()=>{
  const r=new ShapeMatcher(40,25),frame=new Uint32Array(61440);
  for(let i=0;i<frame.length;i++) if((i%256)>70&&(i%256)<130)frame[i]=0xffffff;
  const first=r.render(frame,true);
  assert.equal(r.render(frame,true).chars,first.chars);
  r.reset();assert.equal(r.render(frame,true).chars,first.chars);
});

test('black overscan stays blank even when the dominant scene color is bright',()=>{
  const r=new ShapeMatcher(40,25),frame=new Uint32Array(61440).fill(0x88eeaa);
  for(let y=210;y<240;y++) frame.fill(0,y*256,(y+1)*256);
  const out=r.render(frame,true);
  assert.equal(out.chars.slice(23*40),' '.repeat(80));
});

test('shape glyphs and colors do not depend on distant scene composition',()=>{
  for (const [cols,rows] of [[40,25],[64,30]]) {
    const renderer=new ShapeMatcher(cols,rows);
    const outputs=[];
    for (const background of [0x2070e0,0xe08020,0x2070e0,0xffffff,0]) {
      const frame=new Uint32Array(61440).fill(background);
      // A fixed patch surrounds complete cells, including fractional 40x25 boundaries.
      for(let y=72;y<112;y++) for(let x=64;x<112;x++)
        frame[y*256+x]=x%4<2?0x2070e0:0xe08020;
      const out=renderer.render(frame,true);
      const cell=Math.floor(88*rows/240)*cols+Math.floor(84*cols/256);
      outputs.push([out.chars[cell],out.colors[cell]]);
    }
    for (const output of outputs) assert.deepEqual(output,outputs[0]);
  }
});

test('shape colors follow a translated cell and real palette changes without temporal lag',()=>{
  const renderer=new ShapeMatcher(64,30);
  const first=new Uint32Array(61440),second=new Uint32Array(61440);
  for(let y=80;y<88;y++) for(let x=80;x<84;x++) {
    const p=x%4<2?0x2070e0:0xe08020;
    first[y*256+x]=p;second[y*256+x+4]=p;
  }
  const a=renderer.render(first,true),b=renderer.render(second,true);
  assert.equal(a.colors[660],b.colors[661]);
  assert.equal(b.chars[660],' ','no trailing glyph in vacated cell');
  const changed=second.map(p=>p?0x20e020:0);
  const next=renderer.render(changed,true);
  const fresh=new ShapeMatcher(64,30).render(changed,true);
  assert.equal(next.colors[661],fresh.colors[661]);
  assert.notEqual(next.colors[661],b.colors[661]);
});

test('flat fields use sparse ink rather than dense full-screen glyphs',()=>{
  for(const [cols,rows,glyphs] of [[40,25,GLYPHS],[64,30,GLYPHS_TALL]]) {
    const ink=new Map(glyphs.map(([char,mask])=>[char,mask.reduce((a,b)=>a+b,0)/(255*mask.length)]));
    for(const color of [0xffffff,0xffb070,0x806030]) {
      const out=new ShapeMatcher(cols,rows).render(new Uint32Array(61440).fill(color),true);
      for(const char of new Set(out.chars)) assert.ok(ink.get(char)<.25,`flat field chose dense ${char}`);
    }
  }
});

test('64x30 grid represents an 8x8 NES tile with two ASCII cells',()=>{
  const r=new AsciiRenderer({cols:64,rows:30});
  const frame=new Uint32Array(61440);
  for(let y=80;y<88;y++) for(let x=80;x<88;x++)frame[y*256+x]=0xffffff;
  const out=r.render(frame);
  assert.equal(out.chars.length,1920);
  assert.ok(out.text.split('\n').every(line=>line.length===64));
  const occupied=[...out.chars].flatMap((ch,i)=>ch!==' '?[i]:[]);
  assert.deepEqual(occupied,[10*64+20,10*64+21]);
});

test('rejects malformed ROM before core execution',()=>{
  const e=new Emulator();
  assert.throws(()=>e.load(new Uint8Array(16)),/iNES/);
  const short=new Uint8Array(16);short.set([0x4e,0x45,0x53,0x1a,1]);
  assert.throws(()=>e.load(short),/truncated/);
  assert.throws(()=>e.frame(),/ROM/);
});

function createNromFixture() {
  // Original test-only NROM: the 6502 program fills the nametable, enables the
  // background, and changes one palette color from NMI once per video frame.
  const header=Uint8Array.from([0x4e,0x45,0x53,0x1a,1,1,0,0,0,0,0,0,0,0,0,0]);
  const prg=new Uint8Array(16384).fill(0xea),chr=new Uint8Array(8192);
  const code=[],labels=new Map(),branches=[];
  const emit=(...bytes)=>code.push(...bytes);
  const mark=name=>labels.set(name,code.length);
  const branch=(opcode,label)=>{emit(opcode,0);branches.push([code.length-1,label]);};
  emit(0x78,0xd8,0xa2,0x40,0x8e,0x17,0x40,0xa2,0xff,0x9a,0xe8,
    0x8e,0x00,0x20,0x8e,0x01,0x20);
  mark('vblank');emit(0x2c,0x02,0x20);branch(0x10,'vblank');
  emit(0xa9,0x3f,0x8d,0x06,0x20,0xa9,0x00,0x8d,0x06,0x20,0xa2,0x00);
  const paletteLoad=code.length;emit(0xbd,0,0,0x8d,0x07,0x20,0xe8,0xe0,0x20);branch(0xd0,'palette');
  labels.set('palette',paletteLoad);
  emit(0xa9,0x20,0x8d,0x06,0x20,0xa9,0x00,0x8d,0x06,0x20,
    0xa9,0x01,0xa2,0x00,0xa0,0x04);
  mark('nametable');emit(0x8d,0x07,0x20,0xe8);branch(0xd0,'nametable');
  emit(0x88);branch(0xd0,'nametable');
  emit(0xa9,0x00,0x8d,0x05,0x20,0x8d,0x05,0x20,
    0xa9,0x80,0x8d,0x00,0x20,0xa9,0x0a,0x8d,0x01,0x20);
  mark('main');emit(0x4c,0,0);
  const mainAddress=0x8000+labels.get('main');code[code.length-2]=mainAddress&0xff;code[code.length-1]=mainAddress>>8;
  mark('nmi');emit(0x48,0x8a,0x48,0xa9,0x3f,0x8d,0x06,0x20,0xa9,0x01,0x8d,0x06,0x20,
    0xe6,0x00,0xa5,0x00,0x29,0x0f,0x09,0x10,0x8d,0x07,0x20,
    0xa9,0x80,0x8d,0x00,0x20,0xa9,0x00,0x8d,0x05,0x20,0x8d,0x05,0x20,0x68,0xaa,0x68,0x40);
  mark('paletteData');
  emit(0x0f,0x21,0x11,0x01,0x0f,0x27,0x17,0x07,0x0f,0x2a,0x1a,0x0a,0x0f,0x30,0x20,0x10,
       0x0f,0x21,0x11,0x01,0x0f,0x27,0x17,0x07,0x0f,0x2a,0x1a,0x0a,0x0f,0x30,0x20,0x10);
  const paletteAddress=0x8000+labels.get('paletteData');code[paletteLoad+1]=paletteAddress&0xff;code[paletteLoad+2]=paletteAddress>>8;
  for(const [operand,label] of branches) {
    const delta=labels.get(label)-(operand+1);
    if(delta < -128 || delta > 127)throw new Error(`Branch out of range: ${label}`);
    code[operand]=delta&0xff;
  }
  prg.set(code);
  const nmiAddress=0x8000+labels.get('nmi');
  prg.set([nmiAddress&0xff,nmiAddress>>8,0x00,0x80,0x00,0x80],0x3ffa);
  for(let row=0;row<8;row++)chr[16+row]=row%2 ? 0xaa : 0x55;
  const rom=new Uint8Array(header.length+prg.length+chr.length);
  rom.set(header);rom.set(prg,header.length);rom.set(chr,header.length+prg.length);
  return rom;
}

test('generated NROM runs the core for 120 varying, renderable frames',async()=>{
  const hashes=new Set();let latest;
  const e=new Emulator({onFrame:buffer=>{
    latest=buffer.slice();let hash=0;
    for(let i=0;i<buffer.length;i+=61)hash=(Math.imul(hash,31)+buffer[i])|0;
    hashes.add(hash);
  }});
  await e.load(createNromFixture());
  e.press('a');assert.equal(e.nes.getGamepad(1).buttonStates[0],1);
  e.release('a');assert.equal(e.nes.getGamepad(1).buttonStates[0],0);
  for(let i=0;i<120;i++)e.frame();
  assert.equal(e.frames,120);
  assert.ok(hashes.size>2,`NMI palette updates should vary rendered frames (saw ${hashes.size})`);
  assert.ok(latest.some(pixel=>(pixel&0xffffff)!==0),'Fixture should render non-black pixels');
  const rendered=new AsciiRenderer().render(latest);
  assert.match(rendered.chars,/^[\x20-\x7e]+$/);
  assert.ok(rendered.chars.trim().length>0,'Pattern table should produce visible ASCII cells');
});

const path=process.env.NESTERM_ROM;
test('local SMB3 integration: 1200 frames, input changes state, varying image', {skip:!path,timeout:30000},async()=>{
  let count=0;const hashes=new Set();
  const e=new Emulator({onFrame:buffer=>{
    count++;let h=0;for(let i=0;i<buffer.length;i+=61)h=(Math.imul(h,31)+buffer[i])|0;hashes.add(h);
  }});
  await e.load(new Uint8Array(readFileSync(path)));
  e.press('a');assert.equal(e.nes.getGamepad(1).buttonStates[0],1);
  e.releaseAll();assert.equal(e.nes.getGamepad(1).buttonStates[0],0);
  const deadline=Date.now()+25000;
  for(let i=0;i<1200;i++) {assert.ok(Date.now()<deadline);e.frame();}
  assert.equal(e.frames,1200);assert.ok(count>=1199);assert.ok(hashes.size>30);
});
