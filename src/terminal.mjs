import { open, readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

export const COLS = 40;
export const ROWS = 25;
export const GRID_SIZES = Object.freeze({
  '40x25': Object.freeze({ cols: 40, rows: 25 }),
  '64x30': Object.freeze({ cols: 64, rows: 30 }),
});
export const LEGACY_RELEASE_MS = 120;

export const ENTER_SEQUENCE = '\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H\x1b[40m\x1b[97m\x1b[>3u';
export const EXIT_SEQUENCE = '\x1b[<u\x1b[0m\x1b[?25h\x1b[?1049l';

const KEY_BY_CHARACTER = new Map([
  ['w', 'up'],
  ['a', 'left'],
  ['s', 'down'],
  ['d', 'right'],
  ['x', 'a'],
  ['z', 'b'],
  ['\r', 'start'],
  ['\n', 'start'],
  [' ', 'select'],
]);

const KEY_BY_CODEPOINT = new Map([
  [57441, 'select'], // Kitty left_shift
  [57447, 'select'], // Kitty right_shift
]);

const KEY_BY_ARROW = Object.freeze({ A: 'up', B: 'down', C: 'right', D: 'left' });

export const HELP = `Usage: nesterm [options] <rom.nes>

Render an NES ROM as a 40x25 or 64x30 ASCII display.

Options:
  --mono             disable ANSI foreground colors
  --mode <mode>      renderer mode: ramp or shape (default: shape)
  --size <grid>      ASCII grid: 40x25 or 64x30 (default: 40x25)
  --fps <number>     maximum terminal redraw rate (default: 30)
  --seconds <number> stop after this many seconds (useful for recording)
  --record <path>    write the genuine ANSI output as asciicast v2 JSONL
  -h, --help         show this help

Keys:
  arrows or WASD     D-pad
  X / Z              A / B
  Enter              Start
  Shift              Select (Kitty keyboard protocol); Space is the legacy fallback
  P                  pause/resume
  Q or Ctrl-C        quit

Kitty-compatible terminals report real key releases. Legacy terminals cannot report
release events, so nesterm releases a key after ${LEGACY_RELEASE_MS} ms without a repeat.
`;

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function positiveNumber(value, option) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${option} must be a positive number`);
  }
  return number;
}

export function parseArgs(argv) {
  const options = {
    color: true,
    mode: 'shape',
    size: '40x25',
    cols: COLS,
    rows: ROWS,
    fps: 30,
    seconds: null,
    record: null,
    rom: null,
    help: false,
  };
  let positionalOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (positionalOnly || !argument.startsWith('-') || argument === '-') {
      if (options.rom !== null) throw new Error('exactly one ROM path is required');
      options.rom = argument;
    } else if (argument === '--') {
      positionalOnly = true;
    } else if (argument === '-h' || argument === '--help') {
      options.help = true;
    } else if (argument === '--mono') {
      options.color = false;
    } else if (argument === '--mode') {
      options.mode = optionValue(argv, index, argument);
      index += 1;
      if (options.mode !== 'ramp' && options.mode !== 'shape') {
        throw new Error('--mode must be ramp or shape');
      }
    } else if (argument === '--size') {
      options.size = optionValue(argv, index, argument);
      index += 1;
      const grid = GRID_SIZES[options.size];
      if (!grid) throw new Error('--size must be 40x25 or 64x30');
      options.cols = grid.cols;
      options.rows = grid.rows;
    } else if (argument === '--fps') {
      options.fps = positiveNumber(optionValue(argv, index, argument), argument);
      index += 1;
      if (options.fps > 240) throw new Error('--fps must not exceed 240');
    } else if (argument === '--seconds') {
      options.seconds = positiveNumber(optionValue(argv, index, argument), argument);
      index += 1;
    } else if (argument === '--record') {
      options.record = optionValue(argv, index, argument);
      index += 1;
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
  }

  if (!options.help && options.rom === null) throw new Error('a ROM path is required');
  return options;
}

export function assertTerminalSize(stdout, { cols = COLS, rows = ROWS } = {}) {
  if (!stdout.isTTY) return;
  const columnsKnown = Number.isFinite(stdout.columns);
  const rowsKnown = Number.isFinite(stdout.rows);
  if ((columnsKnown && stdout.columns < cols) || (rowsKnown && stdout.rows < rows)) {
    const columns = columnsKnown ? stdout.columns : '?';
    const actualRows = rowsKnown ? stdout.rows : '?';
    throw new Error(`terminal is too small: ${columns}x${actualRows}; need at least ${cols}x${rows}`);
  }
}

function inputForCodepoint(codepoint) {
  const special = KEY_BY_CODEPOINT.get(codepoint);
  if (special) return special;
  const character = String.fromCodePoint(codepoint).toLowerCase();
  return KEY_BY_CHARACTER.get(character) ?? null;
}

function controlForCodepoint(codepoint) {
  const character = String.fromCodePoint(codepoint).toLowerCase();
  if (character === 'q' || codepoint === 3) return 'quit';
  if (character === 'p') return 'pause';
  return null;
}

/** Decode complete terminal key sequences and return any incomplete suffix as rest. */
export function parseInputSequences(input, carry = '') {
  const source = carry + (Buffer.isBuffer(input) ? input.toString('utf8') : String(input));
  const events = [];
  let offset = 0;

  while (offset < source.length) {
    const remaining = source.slice(offset);

    if (remaining.startsWith('\x1b[')) {
      const kittyKey = /^\x1b\[(\d+)(?:;(\d+)(?::([123]))?)?u/.exec(remaining);
      if (kittyKey) {
        const codepoint = Number(kittyKey[1]);
        const eventType = Number(kittyKey[3] ?? 1);
        const control = controlForCodepoint(codepoint);
        const key = inputForCodepoint(codepoint);
        const action = eventType === 3 ? 'release' : eventType === 2 ? 'repeat' : 'press';
        if (control) events.push({ kind: 'control', name: control, action, extended: true });
        if (key) events.push({ kind: 'key', name: key, action, extended: true });
        offset += kittyKey[0].length;
        continue;
      }

      const arrow = /^\x1b\[(?:1(?:;(\d+)(?::([123]))?)?)?([ABCD])/.exec(remaining);
      if (arrow) {
        const eventType = Number(arrow[2] ?? 1);
        events.push({
          kind: 'key',
          name: KEY_BY_ARROW[arrow[3]],
          action: eventType === 3 ? 'release' : eventType === 2 ? 'repeat' : 'press',
          extended: arrow[2] !== undefined,
        });
        offset += arrow[0].length;
        continue;
      }

      // An escape sequence may have been divided between data events.
      if (/^\x1b\[[0-9;:]*$/.test(remaining)) break;
      const unknown = /^\x1b\[[0-9;:?>=]*[A-Za-z~]/.exec(remaining);
      if (unknown) {
        offset += unknown[0].length;
        continue;
      }
    }

    if (remaining === '\x1b') break;
    const codepoint = source.codePointAt(offset);
    const width = codepoint > 0xffff ? 2 : 1;
    const control = controlForCodepoint(codepoint);
    const key = inputForCodepoint(codepoint);
    if (control) events.push({ kind: 'control', name: control, action: 'press', extended: false });
    if (key) events.push({ kind: 'key', name: key, action: 'press', extended: false });
    offset += width;
  }

  return { events, rest: source.slice(offset) };
}

export class InputParser {
  #rest = '';

  feed(input) {
    const parsed = parseInputSequences(input, this.#rest);
    this.#rest = parsed.rest;
    return parsed.events;
  }
}

export class InputController {
  constructor(emulator, {
    releaseMs = LEGACY_RELEASE_MS,
    schedule = setTimeout,
    cancel = clearTimeout,
    onQuit = () => {},
    onPause = () => {},
  } = {}) {
    this.emulator = emulator;
    this.releaseMs = releaseMs;
    this.schedule = schedule;
    this.cancel = cancel;
    this.onQuit = onQuit;
    this.onPause = onPause;
    this.releaseTimers = new Map();
  }

  handle(event) {
    if (event.kind === 'control') {
      if (event.action === 'release' || event.action === 'repeat') return;
      if (event.name === 'quit') this.onQuit();
      if (event.name === 'pause') this.onPause();
      return;
    }

    const existing = this.releaseTimers.get(event.name);
    if (existing !== undefined) {
      this.cancel(existing);
      this.releaseTimers.delete(event.name);
    }

    if (event.action === 'release') {
      this.emulator.release(event.name);
      return;
    }

    this.emulator.press(event.name);
    if (!event.extended) {
      const timer = this.schedule(() => {
        this.releaseTimers.delete(event.name);
        this.emulator.release(event.name);
      }, this.releaseMs);
      this.releaseTimers.set(event.name, timer);
    }
  }

  releaseAll() {
    for (const timer of this.releaseTimers.values()) this.cancel(timer);
    this.releaseTimers.clear();
    this.emulator.releaseAll();
  }
}

function foreground(color) {
  const red = (color >>> 16) & 0xff;
  const green = (color >>> 8) & 0xff;
  const blue = color & 0xff;
  return `\x1b[38;2;${red};${green};${blue}m`;
}

function validateFrame(frame, color) {
  if (!Number.isInteger(frame.cols) || frame.cols <= 0 || !Number.isInteger(frame.rows) || frame.rows <= 0) {
    throw new Error('terminal frame dimensions must be positive integers');
  }
  const cells = frame.cols * frame.rows;
  if (typeof frame.chars !== 'string' || frame.chars.length !== cells) {
    throw new Error(`frame.chars must contain exactly ${cells} characters`);
  }
  if (!/^[\x20-\x7e]+$/.test(frame.chars)) {
    throw new Error('frame.chars must contain printable ASCII only');
  }
  if (color && (!frame.colors || frame.colors.length !== cells)) {
    throw new Error(`frame.colors must contain exactly ${cells} colors`);
  }
}

function cellChanged(frame, previous, index, color) {
  return frame.chars[index] !== previous.chars[index]
    || (color && (frame.colors[index] & 0xffffff) !== (previous.colors[index] & 0xffffff));
}

export function formatAnsiFrame(frame, { color = true } = {}, previous = null) {
  validateFrame(frame, color);
  if (previous !== null && (previous.cols !== frame.cols || previous.rows !== frame.rows)) previous = null;
  if (previous !== null) validateFrame(previous, color);
  const { cols, rows } = frame;

  if (previous !== null) {
    let output = '';
    let activeColor = null;
    for (let row = 0; row < rows; row += 1) {
      let column = 0;
      while (column < cols) {
        const index = row * cols + column;
        if (!cellChanged(frame, previous, index, color)) {
          column += 1;
          continue;
        }

        output += `\x1b[${row + 1};${column + 1}H`;
        do {
          const runIndex = row * cols + column;
          if (color) {
            const nextColor = frame.colors[runIndex] & 0xffffff;
            if (nextColor !== activeColor) {
              output += foreground(nextColor);
              activeColor = nextColor;
            }
          }
          output += frame.chars[runIndex];
          column += 1;
        } while (column < cols && cellChanged(frame, previous, row * cols + column, color));
      }
    }
    if (color && output !== '') output += '\x1b[39m';
    if (output === '') return output;
    const full = formatAnsiFrame(frame, { color }, null);
    return output.length < full.length ? output : full;
  }

  let output = '\x1b[H';
  let activeColor = null;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < cols; column += 1) {
      const index = row * cols + column;
      if (color) {
        const nextColor = frame.colors[index] & 0xffffff;
        if (nextColor !== activeColor) {
          output += foreground(nextColor);
          activeColor = nextColor;
        }
      }
      output += frame.chars[index];
    }
    if (row + 1 < rows) output += '\r\n';
  }
  if (color) output += '\x1b[39m';
  return output;
}

export function writeWithBackpressure(stream, data) {
  return new Promise((resolve, reject) => {
    let completed = false;
    let writeReturned = false;
    let callbackDone = stream.write.length < 2;
    let drainDone = false;
    let accepted = false;
    const finish = (callback, value) => {
      if (completed) return;
      completed = true;
      stream.off?.('error', onError);
      stream.off?.('drain', onDrain);
      callback(value);
    };
    const onError = (error) => finish(reject, error);
    const check = () => {
      if (writeReturned && callbackDone && (accepted || drainDone)) finish(resolve);
    };
    const onDrain = () => {
      drainDone = true;
      check();
    };
    const onWrite = (error) => {
      if (error) {
        finish(reject, error);
        return;
      }
      callbackDone = true;
      check();
    };
    stream.once?.('error', onError);
    try {
      accepted = stream.write.length < 2 ? stream.write(data) : stream.write(data, onWrite);
      writeReturned = true;
      if (!accepted) stream.once('drain', onDrain);
      check();
    } catch (error) {
      finish(reject, error);
    }
  });
}

export class SerialWriter {
  constructor(stream) {
    this.stream = stream;
    this.tail = Promise.resolve();
  }

  write(data) {
    const operation = this.tail.catch(() => {}).then(() => writeWithBackpressure(this.stream, data));
    this.tail = operation;
    return operation;
  }
}

export class AsciicastRecorder {
  static async create(path, { now = Date.now, env = process.env, width = COLS, height = ROWS } = {}) {
    const file = await open(path, 'w');
    const recorder = new AsciicastRecorder(file, now);
    const header = {
      version: 2,
      width,
      height,
      timestamp: Math.floor(now() / 1000),
      env: { TERM: env.TERM ?? '', SHELL: env.SHELL ?? '' },
    };
    await file.write(`${JSON.stringify(header)}\n`);
    return recorder;
  }

  constructor(file, now = Date.now) {
    this.file = file;
    this.now = now;
    this.startedAt = now();
    this.closed = false;
  }

  async record(data) {
    if (this.closed) return;
    const elapsed = Math.max(0, (this.now() - this.startedAt) / 1000);
    await this.file.write(`${JSON.stringify([elapsed, 'o', data])}\n`);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.file.close();
  }
}

export class TerminalSession {
  constructor({ stdin, stdout, recorder = null }) {
    this.stdin = stdin;
    this.stdout = stdout;
    this.recorder = recorder;
    this.writer = new SerialWriter(stdout);
    this.entered = false;
    this.rawMode = false;
  }

  async #output(data) {
    await this.writer.write(data);
    await this.recorder?.record(data);
  }

  async enter() {
    if (this.entered) return;
    this.entered = true;
    if (this.stdin.isTTY && typeof this.stdin.setRawMode === 'function') {
      this.stdin.setRawMode(true);
      this.rawMode = true;
    }
    this.stdin.resume?.();
    await this.#output(ENTER_SEQUENCE);
  }

  draw(frame, options, previous = null) {
    const output = formatAnsiFrame(frame, options, previous);
    if (output === '') return Promise.resolve(false);
    return this.#output(output).then(() => true);
  }

  async close() {
    if (!this.entered) return;
    this.entered = false;
    let outputError = null;
    try {
      await this.#output(EXIT_SEQUENCE);
    } catch (error) {
      outputError = error;
    } finally {
      if (this.rawMode) {
        this.stdin.setRawMode(false);
        this.rawMode = false;
      }
      this.stdin.pause?.();
    }
    if (outputError) throw outputError;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function runTerminal(options, {
  stdin = process.stdin,
  stdout = process.stdout,
  processTarget = process,
  clock = performance,
  loadModules = async () => Promise.all([import('./emulator.mjs'), import('./renderer.mjs')]),
} = {}) {
  const cols = options.cols ?? GRID_SIZES[options.size]?.cols ?? COLS;
  const rows = options.rows ?? GRID_SIZES[options.size]?.rows ?? ROWS;
  const grid = { cols, rows };
  assertTerminalSize(stdout, grid);
  const rom = new Uint8Array(await readFile(options.rom));
  const [{ Emulator }, { AsciiRenderer }] = await loadModules();
  let latestFrame = null;
  const emulator = new Emulator({ onFrame: (frame) => { latestFrame = frame; } });
  const renderer = new AsciiRenderer({ cols, rows, mode: options.mode, color: options.color });
  await emulator.load(rom);

  const recorder = options.record
    ? await AsciicastRecorder.create(options.record, { width: cols, height: rows })
    : null;
  const terminal = new TerminalSession({ stdin, stdout, recorder });
  const parser = new InputParser();
  let stopping = false;
  let paused = false;
  let redraw = true;
  let previousRendered = null;
  let displayEpoch = 0;
  let primaryError = null;
  const input = new InputController(emulator, {
    onQuit: () => { stopping = true; },
    onPause: () => {
      paused = !paused;
      if (paused) input.releaseAll();
    },
  });

  const onData = (data) => {
    for (const event of parser.feed(data)) input.handle(event);
  };
  const onResize = () => {
    try {
      assertTerminalSize(stdout, grid);
    } catch (error) {
      primaryError ??= error;
      stopping = true;
      return;
    }
    displayEpoch += 1;
    redraw = true;
    previousRendered = null;
  };
  const onSignal = () => { stopping = true; };
  stdin.on('data', onData);
  stdout.on?.('resize', onResize);
  processTarget.on?.('SIGINT', onSignal);
  processTarget.on?.('SIGTERM', onSignal);

  try {
    await terminal.enter();
    const startedAt = clock.now();
    const deadline = options.seconds === null ? Infinity : startedAt + options.seconds * 1000;
    const framePeriod = 1000 / 60;
    const renderPeriod = 1000 / options.fps;
    let nextFrame = startedAt;
    let nextRender = startedAt;

    while (!stopping && clock.now() < deadline) {
      let now = clock.now();
      if (paused) {
        nextFrame = now + framePeriod;
      } else {
        let catchups = 0;
        while (now >= nextFrame && catchups < 5) {
          emulator.frame();
          nextFrame += framePeriod;
          catchups += 1;
        }
        if (now >= nextFrame && catchups === 5) nextFrame = now + framePeriod;
      }

      if (stopping) break;

      now = clock.now();
      if (latestFrame && (redraw || now >= nextRender)) {
        const renderingEpoch = displayEpoch;
        const fullRedraw = redraw;
        const rendered = renderer.render(latestFrame);
        await terminal.draw(rendered, { color: options.color }, fullRedraw ? null : previousRendered);
        if (displayEpoch === renderingEpoch) {
          previousRendered = {
            cols: rendered.cols,
            rows: rendered.rows,
            chars: rendered.chars,
            colors: rendered.colors ? Uint32Array.from(rendered.colors) : null,
          };
          redraw = false;
        }
        nextRender = Math.max(nextRender + renderPeriod, now + renderPeriod);
      }

      const wakeAt = Math.min(nextFrame, nextRender, deadline);
      await delay(Math.max(0, Math.min(10, wakeAt - clock.now())));
    }
  } catch (error) {
    primaryError = error;
  } finally {
    stdin.off('data', onData);
    stdout.off?.('resize', onResize);
    processTarget.off?.('SIGINT', onSignal);
    processTarget.off?.('SIGTERM', onSignal);
    input.releaseAll();
    try {
      await terminal.close();
    } catch (error) {
      primaryError ??= error;
    }
    try {
      await recorder?.close();
    } catch (error) {
      primaryError ??= error;
    }
  }
  if (primaryError) throw primaryError;
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const options = parseArgs(argv);
  const stdout = io.stdout ?? process.stdout;
  if (options.help) {
    await writeWithBackpressure(stdout, HELP);
    return 0;
  }
  await runTerminal(options, io);
  return 0;
}
