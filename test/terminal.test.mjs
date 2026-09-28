import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import xterm from '@xterm/headless';

import {
  COLS,
  ENTER_SEQUENCE,
  EXIT_SEQUENCE,
  InputController,
  TerminalSession,
  assertTerminalSize,
  formatAnsiFrame,
  parseArgs,
  parseInputSequences,
  runTerminal,
  writeWithBackpressure,
} from '../src/terminal.mjs';

function solidFrame(character = '.', color = 0x123456, cols = COLS, rows = 25) {
  return {
    cols,
    rows,
    chars: character.repeat(cols * rows),
    colors: new Uint32Array(cols * rows).fill(color),
  };
}

test('parseArgs accepts terminal options and validates modes', () => {
  assert.deepEqual(parseArgs(['--mono', '--mode', 'ramp', '--size', '64x30', '--fps', '24', '--seconds', '1.5', '--record', 'out.cast', 'game.nes']), {
    color: false,
    mode: 'ramp',
    size: '64x30',
    cols: 64,
    rows: 30,
    fps: 24,
    seconds: 1.5,
    record: 'out.cast',
    rom: 'game.nes',
    help: false,
  });
  assert.throws(() => parseArgs(['--mode', 'pixels', 'game.nes']), /ramp or shape/);
  assert.throws(() => parseArgs(['--size', '80x45', 'game.nes']), /40x25 or 64x30/);
  assert.throws(() => parseArgs([]), /ROM path/);
});

test('terminal size accepts the exact 40x25 boundary and rejects smaller TTYs', () => {
  assert.doesNotThrow(() => assertTerminalSize({ isTTY: true, columns: 40, rows: 25 }));
  assert.throws(
    () => assertTerminalSize({ isTTY: true, columns: 39, rows: 25 }),
    /terminal is too small: 39x25; need at least 40x25/,
  );
  assert.throws(
    () => assertTerminalSize({ isTTY: true, columns: 40, rows: 24 }),
    /terminal is too small: 40x24; need at least 40x25/,
  );
  assert.doesNotThrow(() => assertTerminalSize(
    { isTTY: true, columns: 64, rows: 30 },
    { cols: 64, rows: 30 },
  ));
  assert.throws(
    () => assertTerminalSize(
      { isTTY: true, columns: 63, rows: 30 },
      { cols: 64, rows: 30 },
    ),
    /terminal is too small: 63x30; need at least 64x30/,
  );
  assert.doesNotThrow(() => assertTerminalSize({ isTTY: false, columns: 1, rows: 1 }));
});

test('an undersized TTY is rejected before ROM access or terminal setup', async () => {
  const output = [];
  const stdout = {
    isTTY: true,
    columns: 39,
    rows: 25,
    write: (data) => { output.push(data); return true; },
  };
  await assert.rejects(
    runTerminal({ rom: '/path/that/must/not/be/read.nes' }, { stdout }),
    /terminal is too small: 39x25; need at least 40x25/,
  );
  assert.deepEqual(output, []);
});

test('legacy key presses are released after the documented timeout', () => {
  const calls = [];
  const scheduled = [];
  const emulator = {
    press: (key) => calls.push(['press', key]),
    release: (key) => calls.push(['release', key]),
    releaseAll: () => calls.push(['releaseAll']),
  };
  const controller = new InputController(emulator, {
    schedule: (callback, milliseconds) => {
      scheduled.push({ callback, milliseconds });
      return scheduled.length;
    },
    cancel: () => {},
  });

  controller.handle(parseInputSequences('w').events[0]);
  assert.deepEqual(calls, [['press', 'up']]);
  assert.equal(scheduled[0].milliseconds, 120);
  scheduled[0].callback();
  assert.deepEqual(calls, [['press', 'up'], ['release', 'up']]);
});

test('Kitty CSI u, Shift, and arrow events preserve explicit press and release', () => {
  const parsed = parseInputSequences('\x1b[120;1:1u\x1b[120;1:3u\x1b[57441;1:1u\x1b[57441;1:3u\x1b[1;1:1D\x1b[1;1:3D');
  assert.equal(parsed.rest, '');
  assert.deepEqual(parsed.events, [
    { kind: 'key', name: 'a', action: 'press', extended: true },
    { kind: 'key', name: 'a', action: 'release', extended: true },
    { kind: 'key', name: 'select', action: 'press', extended: true },
    { kind: 'key', name: 'select', action: 'release', extended: true },
    { kind: 'key', name: 'left', action: 'press', extended: true },
    { kind: 'key', name: 'left', action: 'release', extended: true },
  ]);

  const calls = [];
  const controller = new InputController({
    press: (key) => calls.push(['press', key]),
    release: (key) => calls.push(['release', key]),
    releaseAll: () => {},
  }, { schedule: () => { throw new Error('extended keys must not use a timeout'); } });
  for (const event of parsed.events) controller.handle(event);
  assert.deepEqual(calls, [
    ['press', 'a'], ['release', 'a'],
    ['press', 'select'], ['release', 'select'],
    ['press', 'left'], ['release', 'left'],
  ]);
});

test('split escape sequences retain an incomplete suffix', () => {
  const first = parseInputSequences('\x1b[120;1:');
  assert.deepEqual(first.events, []);
  const second = parseInputSequences('3u', first.rest);
  assert.deepEqual(second.events, [{ kind: 'key', name: 'a', action: 'release', extended: true }]);
});

test('ANSI frames stay 40x25, use foreground color only, and contain printable cells', () => {
  const output = formatAnsiFrame(solidFrame());
  assert.ok(output.startsWith('\x1b[H\x1b[38;2;18;52;86m'));
  assert.equal((output.match(/\r\n/g) ?? []).length, 24);
  assert.doesNotMatch(output, /\x1b\[(?:48|4[0-7]);/);
  const visible = output.replace(/\x1b\[[0-9;]*m/g, '').replace('\x1b[H', '').replaceAll('\r\n', '');
  assert.equal(visible.length, 1000);
  assert.throws(() => formatAnsiFrame({ ...solidFrame(), chars: ' '.repeat(999) }), /exactly 1000/);
});

test('ANSI diff updates only changed runs and converges to the full-frame result', async () => {
  const first = solidFrame('.', 0x123456);
  const characters = first.chars.split('');
  const colors = Uint32Array.from(first.colors);
  characters[2 * COLS + 3] = 'X';
  characters[2 * COLS + 4] = 'Y';
  colors[2 * COLS + 3] = 0xff0000;
  colors[2 * COLS + 4] = 0x00ff00;
  characters[20 * COLS + 38] = 'Z';
  const second = { ...first, chars: characters.join(''), colors };
  const diff = formatAnsiFrame(second, { color: true }, first);

  assert.ok(diff.startsWith('\x1b[3;4H'));
  assert.ok(diff.includes('\x1b[21;39H'));
  assert.doesNotMatch(diff, /\r\n/);
  assert.ok(diff.length < formatAnsiFrame(second).length / 10);

  const { Terminal } = xterm;
  const terminal = new Terminal({ cols: 40, rows: 25, allowProposedApi: true });
  const write = (data) => new Promise((resolve) => terminal.write(data, resolve));
  await write(formatAnsiFrame(first));
  await write(diff);
  const actual = [];
  for (let row = 0; row < 25; row += 1) {
    actual.push(terminal.buffer.active.getLine(row).translateToString(false, 0, 40));
  }
  assert.equal(actual.join(''), second.chars);
});

test('ANSI diff falls back to a shorter full frame for scattered changes', () => {
  const first = solidFrame('.', 0x111111);
  const second = solidFrame('X', 0xeeeeee);
  const output = formatAnsiFrame(second, { color: true }, first);
  assert.ok(output.startsWith('\x1b[H'));
  assert.equal(output, formatAnsiFrame(second, { color: true }));
});

test('64x30 ANSI full and diff output converge in an independent terminal', async () => {
  const cols = 64;
  const rows = 30;
  const first = solidFrame('.', 0x224466, cols, rows);
  const characters = first.chars.split('');
  const colors = Uint32Array.from(first.colors);
  characters[0] = 'A';
  characters[15 * cols + 32] = 'B';
  characters[rows * cols - 1] = 'C';
  colors[15 * cols + 32] = 0xffaa00;
  const second = { cols, rows, chars: characters.join(''), colors };
  const full = formatAnsiFrame(first, { color: true });
  const diff = formatAnsiFrame(second, { color: true }, first);

  assert.equal((full.match(/\r\n/g) ?? []).length, 29);
  const { Terminal } = xterm;
  const terminal = new Terminal({ cols, rows, allowProposedApi: true });
  const write = (data) => new Promise((resolve) => terminal.write(data, resolve));
  await write(full);
  await write(diff);
  const actual = [];
  for (let row = 0; row < rows; row += 1) {
    actual.push(terminal.buffer.active.getLine(row).translateToString(false, 0, cols));
  }
  assert.equal(actual.join(''), second.chars);
});

test('terminal restores cursor, alternate screen, and raw mode after use', async () => {
  const writes = [];
  const stdin = {
    isTTY: true,
    setRawMode: (value) => writes.push(`raw:${value}`),
    resume: () => writes.push('resume'),
    pause: () => writes.push('pause'),
  };
  const stdout = { write: (data) => { writes.push(data); return true; } };
  const terminal = new TerminalSession({ stdin, stdout });
  await terminal.enter();
  await terminal.close();
  assert.ok(writes.includes(ENTER_SEQUENCE));
  assert.ok(writes.includes(EXIT_SEQUENCE));
  assert.ok(EXIT_SEQUENCE.indexOf('\x1b[?25h') < EXIT_SEQUENCE.indexOf('\x1b[?1049l'));
  assert.deepEqual(writes.filter((item) => item.startsWith('raw:')), ['raw:true', 'raw:false']);
});

test('terminal retries restoration and leaves raw mode after an output error', async () => {
  const writes = [];
  let call = 0;
  const stdin = {
    isTTY: true,
    setRawMode: (value) => writes.push(`raw:${value}`),
    resume: () => {},
    pause: () => {},
  };
  const stdout = {
    write: (data) => {
      call += 1;
      if (call === 2) throw new Error('display disconnected');
      writes.push(data);
      return true;
    },
  };
  const terminal = new TerminalSession({ stdin, stdout });
  await terminal.enter();
  await assert.rejects(terminal.draw(solidFrame()), /display disconnected/);
  await terminal.close();
  assert.ok(writes.includes(EXIT_SEQUENCE));
  assert.deepEqual(writes.filter((item) => item.startsWith('raw:')), ['raw:true', 'raw:false']);
});

test('backpressure waits for drain', async () => {
  const stream = new EventEmitter();
  stream.write = () => false;
  let completed = false;
  const pending = writeWithBackpressure(stream, 'frame').then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  stream.emit('drain');
  await pending;
  assert.equal(completed, true);
});

test('stream write callbacks propagate asynchronous output errors', async () => {
  const stream = new EventEmitter();
  stream.write = (_data, callback) => {
    queueMicrotask(() => callback(new Error('late output failure')));
    return true;
  };
  await assert.rejects(writeWithBackpressure(stream, 'frame'), /late output failure/);
});

test('finite run writes an asciicast containing the actual ANSI session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nesterm-terminal-'));
  const romPath = join(directory, 'game.nes');
  const castPath = join(directory, 'session.cast');
  await writeFile(romPath, new Uint8Array([0x4e, 0x45, 0x53, 0x1a]));

  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.resume = () => {};
  stdin.pause = () => {};
  const stdout = new EventEmitter();
  const output = [];
  stdout.write = (data) => { output.push(data); return true; };
  const processTarget = new EventEmitter();
  const fakeFrame = new Uint32Array(256 * 240);

  class FakeEmulator {
    constructor({ onFrame }) { this.onFrame = onFrame; }
    load() {}
    frame() { this.onFrame(fakeFrame); }
    press() {}
    release() {}
    releaseAll() {}
  }
  class FakeRenderer {
    constructor({ cols, rows }) {
      this.cols = cols;
      this.rows = rows;
    }
    render() { return solidFrame('.', 0x123456, this.cols, this.rows); }
  }

  try {
    await runTerminal({
      rom: romPath,
      mode: 'shape',
      size: '64x30',
      cols: 64,
      rows: 30,
      color: true,
      fps: 60,
      seconds: 0.02,
      record: castPath,
    }, {
      stdin,
      stdout,
      processTarget,
      loadModules: async () => [{ Emulator: FakeEmulator }, { AsciiRenderer: FakeRenderer }],
    });
    const lines = (await readFile(castPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines[0], {
      version: 2,
      width: 64,
      height: 30,
      timestamp: lines[0].timestamp,
      env: { TERM: process.env.TERM ?? '', SHELL: process.env.SHELL ?? '' },
    });
    const recordedOutput = lines.slice(1).map((event) => event[2]);
    assert.deepEqual(recordedOutput, output);
    assert.equal(recordedOutput[0], ENTER_SEQUENCE);
    assert.equal(recordedOutput.at(-1), EXIT_SEQUENCE);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('shrinking below the selected 64x30 grid fails and restores the terminal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nesterm-terminal-resize-'));
  const romPath = join(directory, 'game.nes');
  await writeFile(romPath, new Uint8Array([0x4e, 0x45, 0x53, 0x1a]));

  const rawModes = [];
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.setRawMode = (value) => rawModes.push(value);
  stdin.resume = () => {};
  stdin.pause = () => {};
  const stdout = new EventEmitter();
  stdout.isTTY = true;
  stdout.columns = 64;
  stdout.rows = 30;
  const output = [];
  stdout.write = (data) => { output.push(data); return true; };
  const processTarget = new EventEmitter();
  let resized = false;

  class ResizingEmulator {
    constructor({ onFrame }) { this.onFrame = onFrame; }
    async load() {}
    frame() {
      this.onFrame(new Uint32Array(256 * 240));
      if (!resized) {
        resized = true;
        stdout.rows = 29;
        stdout.emit('resize');
      }
    }
    press() {}
    release() {}
    releaseAll() {}
  }
  class FakeRenderer {
    render() { return solidFrame(); }
  }

  try {
    await assert.rejects(runTerminal({
      rom: romPath,
      mode: 'shape',
      size: '64x30',
      cols: 64,
      rows: 30,
      color: true,
      fps: 60,
      seconds: 1,
      record: null,
    }, {
      stdin,
      stdout,
      processTarget,
      loadModules: async () => [{ Emulator: ResizingEmulator }, { AsciiRenderer: FakeRenderer }],
    }), /terminal is too small: 64x29; need at least 64x30/);
    assert.equal(output[0], ENTER_SEQUENCE);
    assert.equal(output.at(-1), EXIT_SEQUENCE);
    assert.deepEqual(rawModes, [true, false]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
