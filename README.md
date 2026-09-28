# NESTERM

Play NES games in your terminal using **ASCII characters only**. NESTERM turns each frame into letters, punctuation and symbols—no block characters, Braille, sixel or terminal graphics protocols.

Choose a compact **40 × 25** display or a more detailed **64 × 30** display. Characters follow the shapes inside each cell, so sprites and scrolling backgrounds can move in smaller steps than a whole character.

This repository and its releases contain the command-line application only.

## Install on macOS or Linux

Paste this into your terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/kathoc/nesterm/main/install.sh | sh && export PATH="$HOME/.local/bin:$PATH"
```

The installer uses your existing Node.js 20 or newer, or downloads a private runtime if you do not have one. It verifies download checksums and installs under `~/.local`. The command also makes `nesterm` available in your current shell. No `sudo`, Git or npm is required.

If `nesterm` is not found in a new terminal window, add the install directory to that shell:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

You can also use `~/.local/bin/nesterm` directly. To keep the PATH change, add that line to `~/.zshrc` or `~/.bashrc`. The installer does not edit those files.

The automatic runtime download supports Intel and Apple Silicon Macs, and x86-64 and ARM64 Linux with glibc. On other Linux systems, install a compatible Node.js 20+ runtime first.

Already use npm? Install the dependency-bundled release instead:

```sh
npm install --global https://github.com/kathoc/nesterm/releases/download/v0.1.0/nesterm-0.1.0.tgz
```

## Play a game

Bring your own `.nes` ROM. ROMs are not included or downloaded.

```sh
nesterm "/path/to/game.nes" --size 64x30 --fps 60
```

Make your terminal at least **64 columns wide and 30 rows tall** for this mode. Use a monospaced font and a dark background.

For a smaller terminal, run `nesterm "/path/to/game.nes"`. The default is 40 × 25 characters and up to 30 redraws per second. Add `--mono` for a single foreground color.

### Controls

|Key|Action|
|---|---|
|Arrow keys or WASD|D-pad|
|X|A / jump|
|Z|B / run|
|Enter|Start|
|Space|Select|
|P|Pause / resume|
|Q or Ctrl-C|Quit|

The terminal display and cursor are restored when you exit. **The terminal version is silent.**

For the best controls, use a terminal supporting the **Kitty keyboard protocol**, which reports key releases. NESTERM requests this mode automatically, allowing held keys and simultaneous buttons. Shift can also act as Select in this mode.

Traditional terminals do not report key releases. NESTERM releases a key after 120 ms without a repeat, so holding directions or combining run and jump can be less reliable. If controls feel intermittent, use a terminal supporting the Kitty keyboard protocol.

## Pick a display size

|Size|Good for|Mapping to the NES image|
|---|---|---|
|40 × 25|Small terminal windows|About 6.4 × 9.6 pixels per character|
|64 × 30|More recognizable sprites and scenery|4 × 8 pixels per character; an 8 × 8 background tile spans two characters|

The renderer chooses from all 95 printable ASCII characters. It uses shape and color differences to reveal objects, and keeps a previous character when a new choice would be nearly identical. This reduces flicker without blending old frames into new ones.

Small HUD text and fine details cannot be reproduced exactly. Font choice also affects the result.

## Options and recording

```text
nesterm [options] <rom.nes>
```

|Option|Default|What it does|
|---|---|---|
|`--size 40x25` / `--size 64x30`|`40x25`|Choose the character grid|
|`--fps 60`|`30`|Maximum redraw rate; game emulation runs at 60 Hz|
|`--mono`|Color|Use one foreground color|
|`--mode shape` / `--mode ramp`|`shape`|Shape matching or simple brightness mapping|
|`--record session.cast`|Off|Record actual ANSI output as asciicast v2|
|`--seconds 30`|No limit|Exit after a fixed duration|
|`--help`||Show command-line help|

To record a 30-second terminal session:

```sh
nesterm "/path/to/game.nes" --size 64x30 --record session.cast --seconds 30
```

## Update, install elsewhere or uninstall

Rerun the one-line installer to install the version it currently targets. Downloads are also on the [Releases page](https://github.com/kathoc/nesterm/releases).

To choose a different location:

```sh
curl -fsSL https://raw.githubusercontent.com/kathoc/nesterm/main/install.sh | NESTERM_PREFIX="$HOME/apps/nesterm" sh
```

The command will then be at `~/apps/nesterm/bin/nesterm`. To uninstall, remove the `bin/nesterm` launcher and the `lib/nesterm` directory from your chosen prefix. Leave other files in that prefix alone.

## Troubleshooting

**Terminal is too small:** enlarge the window or use `--size 40x25`. NESTERM exits cleanly if you resize below the selected grid dimensions.

**Held keys stop or run/jump combinations feel wrong:** use a terminal with the Kitty keyboard protocol. Traditional terminal input cannot accurately report key releases.

**Node.js download failed:** check your connection or install Node.js 20+ yourself and rerun the installer. It does not replace a system-wide runtime.

**A ROM does not load or behaves incorrectly:** compatibility depends on the emulation core. [Open an issue](https://github.com/kathoc/nesterm/issues) with your OS, terminal, Node.js version, command and ROM name/hash. Do not attach ROM files.

Save-file persistence and terminal audio are not implemented. macOS and Linux are the installer targets; the Node.js CLI may also work on Windows, but this installer does not support it.

## Build from source

For contributors, use Node.js 22+ and npm (the installed terminal app supports Node.js 20+), then:

```sh
git clone https://github.com/kathoc/nesterm.git
cd nesterm
npm ci
git config core.hooksPath .githooks
npm run check:public
npm test
npm start -- "/path/to/game.nes" --size 64x30
```

Tests include an original generated NES test program and do not need a commercial ROM. Enable the optional longer ROM test with `NESTERM_ROM="/path/to/game.nes" npm test`.

The publication guard checks tracked files against a CLI-only allowlist. Review and update that list when adding CLI files. Browser interfaces and browser-only tooling must never be added to this repository.

## Credits and license

NESTERM's original code is MIT licensed. NES emulation comes from [@nesjs/core](https://github.com/taiyuuki/nesjs). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for dependency and glyph-mask notices.
