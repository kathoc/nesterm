import { NES, NESControllerButton } from '@nesjs/core';

export const BUTTONS = Object.freeze({
  a: NESControllerButton.A,
  b: NESControllerButton.B,
  select: NESControllerButton.SELECT,
  start: NESControllerButton.START,
  up: NESControllerButton.UP,
  down: NESControllerButton.DOWN,
  left: NESControllerButton.LEFT,
  right: NESControllerButton.RIGHT,
});

export class Emulator {
  constructor({ onFrame = () => {}, onAudioSample = () => {}, sound = false, sampleRate = 48000 } = {}) {
    this.frames = 0;
    this.loaded = false;
    this.nes = new NES({ audioSampleRate: sampleRate });
    this.frameBuffer = new Uint32Array(256 * 240);
    this.nes.setRenderer({
      renderFrame: rgba => {
        for (let i = 0, j = 0; i < this.frameBuffer.length; i++, j += 4) {
          this.frameBuffer[i] = rgba[j] | (rgba[j + 1] << 8) | (rgba[j + 2] << 16) | 0xff000000;
        }
        onFrame(this.frameBuffer);
      },
    });
    if (sound) {
      this.nes.setAudioInterface({
        outputSample: sample => onAudioSample(sample, sample),
        flushFrame() {},
      });
    }
  }
  load(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 16 ||
        bytes[0] !== 0x4e || bytes[1] !== 0x45 || bytes[2] !== 0x53 || bytes[3] !== 0x1a) {
      throw new Error('Select a valid iNES ROM file.');
    }
    const required = 16 + ((bytes[6] & 4) ? 512 : 0) + bytes[4] * 16384 + bytes[5] * 8192;
    if (bytes.length < required) throw new Error('The ROM file is truncated.');
    this.loaded = false;
    return this.loadCore(bytes);
  }
  async loadCore(bytes) {
    await this.nes.loadROM(bytes);
    this.frames = 0;
    this.loaded = true;
    this.releaseAll();
  }
  frame() {
    if (!this.loaded) throw new Error('Load a ROM before running a frame.');
    this.nes.runFrame();
    this.frames++;
  }
  press(name) {
    if (!(name in BUTTONS)) throw new Error(`Unknown button: ${name}`);
    this.nes.getGamepad(1).setButton(BUTTONS[name], 1);
  }
  release(name) {
    if (!(name in BUTTONS)) throw new Error(`Unknown button: ${name}`);
    this.nes.getGamepad(1).setButton(BUTTONS[name], 0);
  }
  releaseAll() { for (const name of Object.keys(BUTTONS)) this.release(name); }
}
