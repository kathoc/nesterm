# Third-party notices

NESTERM uses [@nesjs/core](https://github.com/taiyuuki/nesjs) 2.7.0 as its NES emulation core. It is distributed under the MIT license, copyright (c) 2024–2025 taiyuuki. The bundled package includes its full license at `node_modules/@nesjs/core/LICENSE.md`.

The ASCII glyph masks in `src/glyphs.mjs` were sampled from DejaVu Sans Mono. The applicable notices are included in [LICENSES-glyphs.txt](LICENSES-glyphs.txt). The font itself is not bundled.

When the installer downloads a private Node.js runtime, that runtime includes its own LICENSE file. Node.js is available from [nodejs.org](https://nodejs.org/).

Development-only tools are listed in `devDependencies` in package.json and are not included in terminal releases. No NES ROMs are bundled.
