import { ShapeMatcher } from './shape.mjs';
// The common framebuffer uses 0xBBGGRR, normalized by Emulator.
export class AsciiRenderer {
  constructor({cols = 40, rows = 25, mode = 'shape', color = true} = {}) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 256 || rows > 240) throw new RangeError('Invalid grid');
    this.cols = cols;
    this.rows = rows;
    this.mode = mode;
    this.color = color;
    this.shape = new ShapeMatcher(cols, rows);
    this.reset();
  }
  reset() { this.previous = ''; this.shape?.reset(); }
  render(buffer) {
    if (buffer.length !== 256 * 240) throw new RangeError('Expected 256x240 frame');
    if (this.mode === 'shape') return this.shape.render(buffer, this.color);
    const {cols, rows} = this;
    const colors = new Uint32Array(cols * rows);
    const chars = [];
    const ramp = ' .,:;irsXA253hMHGS#9B&@';
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = Math.floor(cy * 240 / rows); y < Math.floor((cy + 1) * 240 / rows); y++) {
          for (let x = Math.floor(cx * 256 / cols); x < Math.floor((cx + 1) * 256 / cols); x++) {
            const p = buffer[y * 256 + x];
            r += p & 255; g += (p >>> 8) & 255; b += (p >>> 16) & 255; n++;
          }
        }
        r /= n; g /= n; b /= n;
        const level = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        chars.push(ramp[Math.min(ramp.length - 1, Math.floor(level * ramp.length))]);
        colors[cy * cols + cx] = this.color ? (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b) : 0xd8f0dd;
      }
    }
    const string = chars.join('');
    this.previous = string;
    return {cols, rows, chars: string, colors, text: Array.from({length: rows}, (_, y) => string.slice(y * cols, (y + 1) * cols)).join('\n')};
  }
}
