import { Emulator } from "../src/emulator.mjs";
import { AsciiRenderer } from "../src/renderer.mjs";

const GRIDS = Object.freeze({
  "40x25": Object.freeze({ cols: 40, rows: 25 }),
  "64x30": Object.freeze({ cols: 64, rows: 30 }),
});
const FRAME_MS = 1000 / 60;
const MAX_CATCHUP = 5;
const AUDIO_CAPACITY = 32768;

const screen = document.querySelector("#screen");
const romInput = document.querySelector("#rom");
const statusNode = document.querySelector("#status");
const statusBox = statusNode.parentElement;
const frameCount = document.querySelector("#frame-count");
const pauseButton = document.querySelector("#pause");
const resetButton = document.querySelector("#reset");
const muteButton = document.querySelector("#mute");
const gridSelect = document.querySelector("#grid-size");
const modeSelect = document.querySelector("#render-mode");
const colorSelect = document.querySelector("#color-mode");
const gridCaption = document.querySelector("#grid-caption");
const gridSummary = document.querySelector("#grid-summary");

let grid = GRIDS[gridSelect.value];
let renderer = createRenderer();
let emulator;
let loadedRom = null;
let running = false;
let paused = false;
let lastTime = performance.now();
let accumulated = 0;
let renderedFrames = 0;
let droppedSteps = 0;
let muted = true;
let emulatorSampleRate = 48000;
let lastFrameBuffer = null;
let loadGeneration = 0;

class AudioRing {
  constructor(capacity) {
    this.left = new Float32Array(capacity);
    this.right = new Float32Array(capacity);
    this.capacity = capacity;
    this.readIndex = 0;
    this.writeIndex = 0;
    this.length = 0;
    this.overruns = 0;
    this.underruns = 0;
  }

  push(left, right) {
    if (this.length === this.capacity) {
      this.readIndex = (this.readIndex + 1) % this.capacity;
      this.length--;
      this.overruns++;
    }
    this.left[this.writeIndex] = left;
    this.right[this.writeIndex] = right;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    this.length++;
  }

  drain(left, right) {
    for (let index = 0; index < left.length; index++) {
      if (this.length === 0) {
        left[index] = 0;
        right[index] = 0;
        this.underruns++;
        continue;
      }
      left[index] = this.left[this.readIndex];
      right[index] = this.right[this.readIndex];
      this.readIndex = (this.readIndex + 1) % this.capacity;
      this.length--;
    }
  }

  clear() {
    this.readIndex = 0;
    this.writeIndex = 0;
    this.length = 0;
  }
}

const audioRing = new AudioRing(AUDIO_CAPACITY);
let audioContext = null;
let audioNode = null;
let audioSetupError = null;

function createRenderer() {
  return new AsciiRenderer({
    cols: grid.cols,
    rows: grid.rows,
    mode: modeSelect?.value || "shape",
    color: colorSelect?.value !== "mono",
  });
}

function createEmulator(sampleRate = 48000) {
  return new Emulator({
    sound: true,
    sampleRate,
    onFrame(frameBuffer) {
      lastFrameBuffer = frameBuffer;
    },
    onAudioSample(left, right) {
      if (!muted) audioRing.push(left, right);
    },
  });
}

function paint(result) {
  const fragment = document.createDocumentFragment();
  const chars = result.chars;
  const colors = result.colors;
  const { cols, rows } = result;
  for (let row = 0; row < rows; row++) {
    let start = row * cols;
    const end = start + cols;
    while (start < end) {
      const color = colors[start];
      let stop = start + 1;
      while (stop < end && colors[stop] === color) stop++;
      const span = document.createElement("span");
      span.style.color = `#${color.toString(16).padStart(6, "0")}`;
      span.append(document.createTextNode(chars.slice(start, stop)));
      fragment.append(span);
      start = stop;
    }
    if (row < rows - 1) fragment.append("\n");
  }
  screen.replaceChildren(fragment);
}

function renderLatest() {
  if (!lastFrameBuffer) return;
  paint(renderer.render(lastFrameBuffer));
  renderedFrames++;
  frameCount.textContent = `FRAME ${String(renderedFrames).padStart(6, "0")}`;
}

function setStatus(message, state = "") {
  statusNode.textContent = message;
  statusBox.classList.toggle("ready", state === "ready");
  statusBox.classList.toggle("error", state === "error");
}

function prepareAudio() {
  if (audioContext) return true;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return false;
  try {
    audioContext = new AudioContext({ latencyHint: "interactive" });
    audioNode = audioContext.createScriptProcessor(1024, 0, 2);
    audioNode.onaudioprocess = (event) => {
      const left = event.outputBuffer.getChannelData(0);
      const right = event.outputBuffer.getChannelData(1);
      if (muted || paused || document.hidden || !running) {
        left.fill(0);
        right.fill(0);
        audioRing.clear();
        return;
      }
      audioRing.drain(left, right);
    };
    audioNode.connect(audioContext.destination);
    audioSetupError = null;
    return true;
  } catch (error) {
    audioContext = null;
    audioNode = null;
    audioSetupError = error;
    return false;
  }
}

async function ensureAudio() {
  if (!prepareAudio()) {
    const detail = audioSetupError ? `: ${audioSetupError.message}` : "";
    setStatus(`このブラウザは音声に対応していません${detail}`, "error");
    return false;
  }
  await audioContext.resume();
  return true;
}

async function loadRom(bytes, filename) {
  const generation = ++loadGeneration;
  releaseAllInputs();
  running = false;
  audioRing.clear();
  setStatus("ROMを読み込んでいます…");
  // Context construction does not start audible output. Preparing it before the
  // core is created lets muted games use the device rate from their first frame.
  prepareAudio();
  const sampleRate = audioContext?.sampleRate || emulatorSampleRate;
  const candidate = createEmulator(sampleRate);
  try {
    await candidate.load(bytes);
  } catch (error) {
    if (generation !== loadGeneration) return false;
    throw error;
  }
  if (generation !== loadGeneration) return false;
  emulator.releaseAll();
  emulator = candidate;
  emulatorSampleRate = sampleRate;
  loadedRom = bytes;
  renderer.reset();
  lastFrameBuffer = null;
  renderedFrames = 0;
  droppedSteps = 0;
  accumulated = 0;
  running = true;
  paused = false;
  pauseButton.disabled = false;
  resetButton.disabled = false;
  pauseButton.textContent = "一時停止";
  setStatus(filename, "ready");
  return true;
}

async function resetGame() {
  if (!loadedRom) return;
  const bytes = loadedRom;
  audioRing.clear();
  return loadRom(bytes, "リセットしました");
}

romInput.addEventListener("change", async () => {
  const file = romInput.files?.[0];
  if (!file) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await loadRom(bytes, file.name);
  } catch (error) {
    running = false;
    setStatus(`読込エラー: ${error.message}`, "error");
  } finally {
    romInput.value = "";
  }
});

pauseButton.addEventListener("click", () => {
  if (!running) return;
  paused = !paused;
  pauseButton.textContent = paused ? "再開" : "一時停止";
  setStatus(paused ? "一時停止中" : "再開しました", "ready");
  if (paused) {
    releaseAllInputs();
    audioRing.clear();
  }
  lastTime = performance.now();
});

resetButton.addEventListener("click", async () => {
  try {
    await resetGame();
  } catch (error) {
    running = false;
    setStatus(`リセットエラー: ${error.message}`, "error");
  }
});

muteButton.addEventListener("click", async () => {
  if (muted) {
    try {
      if (!(await ensureAudio())) return;
    } catch (error) {
      setStatus(`音声エラー: ${error.message}`, "error");
      return;
    }
    muted = false;
    muteButton.textContent = "音声 ON";
    muteButton.setAttribute("aria-pressed", "true");
  } else {
    muted = true;
    audioRing.clear();
    muteButton.textContent = "音声 OFF";
    muteButton.setAttribute("aria-pressed", "false");
  }
});

gridSelect.addEventListener("change", () => {
  grid = GRIDS[gridSelect.value];
  screen.dataset.grid = gridSelect.value;
  screen.setAttribute("aria-label", `${grid.cols}列${grid.rows}行のASCIIゲーム画面`);
  gridCaption.textContent = `ASCII VIDEO · ${grid.cols} × ${grid.rows}`;
  gridSummary.textContent = `${grid.cols} × ${grid.rows} CHARACTER SYSTEM`;
  renderer = createRenderer();
  renderLatest();
});

for (const select of [modeSelect, colorSelect]) {
  select.addEventListener("change", () => {
    renderer = createRenderer();
    renderLatest();
  });
}

const keyboardMap = new Map([
  ["ArrowUp", "up"], ["ArrowDown", "down"], ["ArrowLeft", "left"], ["ArrowRight", "right"],
  ["KeyX", "a"], ["KeyZ", "b"], ["Enter", "start"], ["ShiftLeft", "select"], ["ShiftRight", "select"],
]);
const activeSources = new Map();
const heldGamepad = new Set();

function activateInput(name, source) {
  let sources = activeSources.get(name);
  if (!sources) {
    sources = new Set();
    activeSources.set(name, sources);
  }
  if (sources.has(source)) return;
  const wasReleased = sources.size === 0;
  sources.add(source);
  if (wasReleased) emulator.press(name);
}

function deactivateInput(name, source) {
  const sources = activeSources.get(name);
  if (!sources?.delete(source)) return;
  if (sources.size === 0) {
    activeSources.delete(name);
    emulator.release(name);
  }
}

window.addEventListener("keydown", (event) => {
  const name = keyboardMap.get(event.code);
  if (!name) return;
  event.preventDefault();
  if (event.repeat) return;
  activateInput(name, `keyboard:${event.code}`);
});

window.addEventListener("keyup", (event) => {
  const name = keyboardMap.get(event.code);
  if (!name) return;
  event.preventDefault();
  deactivateInput(name, `keyboard:${event.code}`);
});

for (const button of document.querySelectorAll("[data-key]")) {
  const name = button.dataset.key;
  const release = (event) => {
    const source = `pointer:${event.pointerId}:${name}`;
    if (!activeSources.get(name)?.has(source)) return;
    button.classList.remove("active");
    deactivateInput(name, source);
  };
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    button.classList.add("active");
    activateInput(name, `pointer:${event.pointerId}:${name}`);
  });
  button.addEventListener("pointerup", release);
  button.addEventListener("pointercancel", release);
  button.addEventListener("lostpointercapture", release);
}

const gamepadButtons = new Map([[0, "a"], [1, "b"], [8, "select"], [9, "start"], [12, "up"], [13, "down"], [14, "left"], [15, "right"]]);

function pollGamepads() {
  const gamepads = navigator.getGamepads?.() || [];
  const next = new Set();
  for (const pad of gamepads) {
    if (!pad) continue;
    for (const [index, name] of gamepadButtons) if (pad.buttons[index]?.pressed) next.add(name);
    if (pad.axes[0] < -0.5) next.add("left");
    if (pad.axes[0] > 0.5) next.add("right");
    if (pad.axes[1] < -0.5) next.add("up");
    if (pad.axes[1] > 0.5) next.add("down");
  }
  for (const name of next) if (!heldGamepad.has(name)) activateInput(name, `gamepad:${name}`);
  for (const name of heldGamepad) if (!next.has(name)) deactivateInput(name, `gamepad:${name}`);
  heldGamepad.clear();
  for (const name of next) heldGamepad.add(name);
}

function releaseAllInputs() {
  activeSources.clear();
  heldGamepad.clear();
  document.querySelectorAll("[data-key].active").forEach((node) => node.classList.remove("active"));
  emulator?.releaseAll();
}

window.addEventListener("blur", releaseAllInputs);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    releaseAllInputs();
    audioRing.clear();
  }
  lastTime = performance.now();
});

function tick(now) {
  if (!document.hidden && document.hasFocus()) pollGamepads();
  const elapsed = Math.min(Math.max(0, now - lastTime), 250);
  lastTime = now;
  if (running && !paused && !document.hidden) {
    accumulated += elapsed;
    let steps = 0;
    try {
      while (accumulated >= FRAME_MS && steps < MAX_CATCHUP) {
        emulator.frame();
        accumulated -= FRAME_MS;
        steps++;
      }
      if (steps > 0) renderLatest();
    } catch (error) {
      running = false;
      releaseAllInputs();
      pauseButton.disabled = true;
      setStatus(`実行エラー: ${error.message}`, "error");
    }
    if (accumulated >= FRAME_MS) {
      droppedSteps += Math.floor(accumulated / FRAME_MS);
      accumulated %= FRAME_MS;
    }
  }
  requestAnimationFrame(tick);
}

emulator = createEmulator();
requestAnimationFrame(tick);

const publicApi = {};
Object.defineProperties(publicApi, {
  emulator: { enumerable: true, get: () => emulator },
  renderer: { enumerable: true, get: () => renderer },
  stats: {
    enumerable: true,
    get: () => ({
      running, paused, renderedFrames, droppedSteps,
      emulatorFrames: emulator.frames,
      audioQueued: audioRing.length,
      audioOverruns: audioRing.overruns,
      audioUnderruns: audioRing.underruns,
    }),
  },
});
publicApi.load = (bytes, name = "automation.nes") => loadRom(new Uint8Array(bytes), name);
publicApi.press = (name) => emulator.press(name);
publicApi.release = (name) => emulator.release(name);
publicApi.reset = resetGame;
window.nesterm = publicApi;
