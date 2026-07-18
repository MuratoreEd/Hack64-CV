# SM64 Invisible Wall Viewer

An interactive 3D viewer that finds the **invisible walls** in Super Mario 64 ROM
hacks by faithfully reimplementing the game's collision engine and probing the
level live from emulator RAM.

Most SM64 "invisible walls" aren't placed on purpose — they're an emergent artifact
of the collision engine. The most common cause is a **leaked ceiling hitbox**: a
ceiling occupies the whole column beneath its footprint, a near-vertical wall fails
to cap it, and s16 vertex truncation misaligns their shared edge — so Mario slams
into nothing. Rather than guess at each case, this tool reimplements the game's
surface load + query routines bit-for-bit and **probes** the level with them, so
every wall reproduces on its own and gets drawn exactly where the game would stop you.

> **Platform:** Windows only. The bridge reads Project64's memory through the Win32
> API, and Project64 is Windows-only.

## Features

- **Live collision view** — color-coded floors / walls / ceilings streamed from the
  running game, updating as you move.
- **Invisible-wall probe** — every blocked unit-column is rendered as a glowing box
  right where the game's collision would stop you, split by cause (exposed ceiling vs.
  out-of-bounds crack). Click any wall to inspect the exact surfaces responsible.
- **Textured level view** — the game's real geometry, parsed straight from its display
  lists and textures in RAM, with faithful vertex lighting.
- **Skybox** — the loaded sky panorama, reconstructed from RAM.
- **Free-fly camera** with an adjustable speed, per-cause color pickers, and toggles
  for every layer.

## Requirements

- **[Project64](https://www.pj64-emu.com/)** — Luna's Project64 v3.x is the tested build.
- **[Node.js](https://nodejs.org/)** 20 or newer (only needed to run the viewer + bridge locally).

## Quick start

```bash
# 1. Install dependencies (once)
npm install
cd bridge && npm install && cd ..
```

Then, with Project64 running and a level loaded, just double-click **`start.cmd`**.
It launches the RAM bridge and the viewer, and opens the viewer in your browser.
Click **"Connect to Project64"** in the viewer and the level appears.

If you close and reopen Project64, run `start.cmd` again — it cleans up the old
bridge and relaunches everything.

### Running it manually

`start.cmd` is just a convenience wrapper. You can run the two pieces yourself:

```bash
# Terminal 1 — the RAM bridge (WebSocket server on :8081)
cd bridge && npm start

# Terminal 2 — the viewer (Vite dev server)
npm run dev
```

Open the URL Vite prints (default <http://localhost:5173>) and click "Connect".

## How it works

```
Project64 (RDRAM) --ReadProcessMemory--> Node bridge (koffi) --WebSocket--> Web app
                                          address discovery + byteswap       collision core + probe + Three.js
```

- **`src/collision/`** — a pure-TypeScript reimplementation of the SM64 collision
  engine: surface parsing, classification, the spatial partition, and
  `findFloor` / `findCeil` / `findWallCollisions`. No DOM or Three.js dependencies;
  unit-tested against the decompilation's behavior with Vitest.
- **`src/probe/`** — marches every static floor and ceiling edge and simulates
  `perform_ground_quarter_step` to classify where invisible walls occur. Runs in a
  Web Worker.
- **`src/gfx/`** — parses the game's Fast3D display lists, textures, and skybox out of
  an RAM snapshot for the textured view.
- **`src/viewer/`** — the Three.js renderer and UI.
- **`bridge/`** — the local Node server that reads Project64's RAM and streams
  surfaces + game state to the web app.

The level boundary and partition geometry are **derived per level** from the loaded
geometry rather than hardcoded, so boundary-extended hacks work correctly.

## Development

```bash
npm test        # collision-core + probe unit tests
npm run dev     # Vite dev server (viewer)
npm run build   # type-check + production build
```

## Credits & references

- [`n64decomp/sm64`](https://github.com/n64decomp/sm64) — the collision algorithm
  ground truth (`src/engine/surface_collision.c`, `src/engine/surface_load.c`,
  `include/types.h`).
- **pannenkoek2012**, *"SM64's Invisible Walls Explained Once and for All"* — the
  definitive explanation of the phenomenon this tool visualizes.
- **STROOP** — reference for Project64 RAM base discovery and endianness handling.

## License

[GPL-3.0-or-later](LICENSE). You're free to use, modify, and redistribute this
project, but derivative works must also be released under the GPL.
