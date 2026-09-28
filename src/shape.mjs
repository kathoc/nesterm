import { GLYPHS, GLYPHS_TALL } from './glyphs.mjs';

const prepare = glyphs => glyphs.map(([char, values]) => {
  const mask = Float32Array.from(values, v => v / 255);
  let energy = 0;
  for (const v of mask) energy += v * v;
  return {char, mask, energy};
});
const normalMasks=prepare(GLYPHS),tallMasks=prepare(GLYPHS_TALL);

function overlaps(count, extent) {
  return Array.from({length:count}, (_,i) => {
    const a=i*extent/count, b=(i+1)*extent/count, list=[];
    for(let p=Math.floor(a);p<Math.ceil(b);p++) list.push([p, (Math.min(b,p+1)-Math.max(a,p))/(b-a)]);
    return list;
  });
}

export class ShapeMatcher {
  constructor(cols, rows) {
    this.cols=cols; this.rows=rows;
    this.height=(256/cols)/(240/rows)<=.55?8:6;
    this.masks=this.height===8?tallMasks:normalMasks;
    const height=this.height, samples=height*4;
    this.xs=overlaps(cols*4,256); this.ys=overlaps(rows*height,240);
    const indices=[],weights=[],offsets=[0];
    for(let cy=0;cy<rows;cy++) for(let cx=0;cx<cols;cx++)
      for(let sy=0;sy<height;sy++) for(let sx=0;sx<4;sx++) {
        for(const [y,wy] of this.ys[cy*height+sy]) for(const [x,wx] of this.xs[cx*4+sx]) {
          indices.push(y*256+x);weights.push(wy*wx);
        }
        offsets.push(indices.length);
      }
    this.indices=Uint32Array.from(indices);this.weights=Float32Array.from(weights);this.offsets=Uint32Array.from(offsets);
    this.previous=new Uint8Array(cols*rows);
    this.previous.fill(0);
    this.samples=new Float32Array(samples);
  }
  reset() { this.previous.fill(0); }
  render(buffer, color) {
    const {cols,rows,samples,previous,indices,weights,offsets,masks,height}=this;
    const sampleCount=height*4;
    // Find the large uninterrupted field (usually sky). Differences from it
    // carry silhouettes, including dark sprites against a light background.
    const histogram=new Map();
    let bg=0, count=0;
    for(let y=16;y<192;y+=4) for(let x=8;x<248;x+=4) {
      const p=buffer[y*256+x]&0xffffff, n=(histogram.get(p)||0)+1;
      histogram.set(p,n); if(n>count) {count=n; bg=p;}
    }
    const br=bg&255,bgG=(bg>>>8)&255,bb=(bg>>>16)&255;
    const palette=new Map();
    const chars=[], colors=new Uint32Array(cols*rows);
    for(let cy=0;cy<rows;cy++) for(let cx=0;cx<cols;cx++) {
      let mean=0, peak=0, sumR=0,sumG=0,sumB=0,weight=0;
      for(let sy=0;sy<height;sy++) for(let sx=0;sx<4;sx++) {
        let value=0;
        const sample=(cy*cols+cx)*sampleCount+sy*4+sx;
        for(let j=offsets[sample];j<offsets[sample+1];j++) {
          const p=buffer[indices[j]];
          let c=palette.get(p);
          if(c===undefined) {
            const r=p&255,g=(p>>>8)&255,b=(p>>>16)&255;
            // A black pixel is already the terminal's black background.
            // Treating black borders as colored silhouettes lit up the entire
            // overscan area when the modal game background was bright.
            const v=(r+g+b)<36?0:Math.min(1,Math.sqrt(((r-br)**2+(g-bgG)**2+(b-bb)**2)/3)/150);
            c=[v,r*v,g*v,b*v];palette.set(p,c);
          }
          const w=weights[j];
          value+=c[0]*w;sumR+=c[1]*w;sumG+=c[2]*w;sumB+=c[3]*w;weight+=c[0]*w;
        }
        samples[sy*4+sx]=value;mean+=value;peak=Math.max(peak,value);
      }
      mean/=sampleCount;
      const cell=cy*cols+cx;
      let best=0,bestScore=-Infinity;
      if(peak>0.045) {
        // Normalize only partly: a small bright sprite still makes a visible
        // glyph, while fractional coverage changes as it crosses the cell.
        const gain=1/Math.max(0.48,peak);
        for(let k=1;k<masks.length;k++) {
          const {mask,energy}=masks[k];
          let dot=0;
          for(let s=0;s<sampleCount;s++) dot+=samples[s]*gain*mask[s];
          const amplitude=Math.min(1.85,dot/energy);
          let score=2*amplitude*dot-amplitude*amplitude*energy;
          // Small tie preference only; no framebuffer mixing / trailing ghost.
          if(previous[cell]===k) score+=0.055;
          if(score>bestScore) {bestScore=score;best=k;}
        }
      }
      previous[cell]=best; chars.push(masks[best].char);
      let r=weight?sumR/weight:0,g=weight?sumG/weight:0,b=weight?sumB/weight:0;
      const light=.2126*r+.7152*g+.0722*b;
      if(light<48 && peak>.045) {r=br*.45+95;g=bgG*.45+95;b=bb*.45+95;}
      const high=Math.max(r,g,b,1), boost=Math.min(2.4,255/high);
      const intensity=Math.min(1,0.56+mean*.65);
      colors[cell]=color?(Math.round(r*boost*intensity)<<16)|(Math.round(g*boost*intensity)<<8)|Math.round(b*boost*intensity):0xd8f0dd;
    }
    const string=chars.join('');
    return {cols,rows,chars:string,colors,text:Array.from({length:rows},(_,y)=>string.slice(y*cols,(y+1)*cols)).join('\n')};
  }
}
