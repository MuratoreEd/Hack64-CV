Human note: I vibecoded the buns outta this.

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
- **Fog** — the level's own fog color and range, parsed from its display lists
  (toggleable, off by default).
- **Free-fly camera** with an adjustable speed, per-cause color pickers, and toggles
  for every layer.
- **Ground truth reports** — when the viewer is wrong (a wall it missed, or one
  that isn't there), park Mario on the spot, describe it, and save it: the file
  carries the level's exact collision data, so the case can be replayed and
  fixed (see [`corpus/README.md`](corpus/README.md)).

## Quick start (no install)

1. Download **`InvisibleWallViewer.exe`** from the
   [latest release](../../releases/latest).
2. Double-click it. Your browser opens the viewer.
3. Start **[Project64](https://www.pj64-emu.com/)** (Luna's PJ64 v3.x is the
   tested build) with a **US** SM64 ROM, enter a level, and click
   **"Connect to Project64"** in the viewer.

That's it — no Node, no terminal. The exe waits for Project64 if it isn't up
yet, and re-attaches by itself if you close and reopen the emulator. Launching
the exe twice just reopens the browser tab.

> **Windows SmartScreen:** the exe is unsigned, so the first launch may show
> "Windows protected your PC". Click **More info → Run anyway**. If the default
> port is taken, run it from a terminal with `--port=8082`.

### Network access

The viewer reads the emulator's memory, so the bridge is deliberately confined
to your own machine:

- it listens on **loopback only** (`127.0.0.1`) — nothing on your network can
  reach it, including from another PC in the same house;
- WebSocket connections are accepted only from **loopback origins** (the
  viewer's own page, or the Vite dev server), because WebSockets are exempt
  from the browser's same-origin policy and any site you happen to have open
  could otherwise ask the bridge for a RAM dump.

Nothing is ever sent off your machine — there is no telemetry, no update check
and no outbound connection of any kind. You can re-check both properties on a
running bridge with `npx tsx bridge/scripts/checkBridgeSecurity.ts`.

## Running from source

Requirements: **[Node.js](https://nodejs.org/)** 20+ and Project64 as above.

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

### Testing the packaged exe

Double-click **`run-exe.cmd`** — or the desktop shortcut that `npm run shortcut`
creates. It rebuilds `dist-exe\InvisibleWallViewer.exe` first if any of the code
it's built from changed since the last build, stops an older copy that's still
running (and the dev bridge, which needs the same port), then starts the exe.
Options, from a terminal:
`.\run-exe.ps1 -Rebuild` forces a rebuild, `-NoOpen` skips opening the browser,
`-Port 8082` serves somewhere else.

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

**Collision patches.** Some hacks change the collision engine itself. The viewer
recognises FramePerfection's *SM64CollisionPatcher* ("Frame's patch") by reading
the patcher's own code edits back out of RAM, and then runs the patched wall
routine (one-sided walls, rounded wall ends, no double pushes) and wall
threshold instead of vanilla's. The HUD says what it detected and how sure it
is — e.g. "read from the ROM's code" versus "assumed from the patch".

## Development

```bash
npm test          # collision-core + probe unit tests
npm run corpus    # replay the ground-truth corpus (see corpus/README.md)
npm run dev       # Vite dev server (viewer)
npm run build     # type-check + production build
npm run build:exe # package the standalone exe (dist-exe/InvisibleWallViewer.exe)
```

`npm test` is the fast suite. **`npm run corpus` is the gate for any change to
the probe or the collision core**: it replays hand-labelled positions from real
levels through the detector and diffs every blocked cell against a committed
baseline. See [`corpus/README.md`](corpus/README.md) for how labels are
captured and why a segment count is not evidence.

The exe bundles the built viewer, the bridge, and Node itself into one file
(via [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg)); it serves the viewer and
the WebSocket bridge on one port (default 8081) and embeds koffi's prebuilt
native module, which is extracted to a temp directory at first launch.

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
