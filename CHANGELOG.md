# Changelog

Versions follow [semver](https://semver.org/). The version lives in
`src/version.ts`; `src/version.test.ts` fails if this file, `package.json` or
`bridge/package.json` disagree with it.

## 1.2.0 — unreleased

### Security

- The bridge now binds **loopback only** (`127.0.0.1`). Both the dev bridge
  (`bridge/src/index.ts`) and the packaged exe (`bridge/src/standalone.ts`)
  previously listened on every interface, so anyone on the same network could
  connect and pull the emulator's full 8 MB RAM snapshot.
- WebSocket handshakes are now checked against an **origin allowlist**
  (`src/net/origin.ts`). WebSockets are exempt from the same-origin policy, so
  any web page open in the user's browser could previously connect to
  `ws://localhost:8081` and request `{type:"rdram"}`. Handshakes are accepted
  with no `Origin` header (non-browser tooling) or a loopback origin on any
  port, and rejected with 403 otherwise.
- Both properties are re-checkable against a running bridge with
  `npx tsx bridge/scripts/checkBridgeSecurity.ts`.

  Behaviour change: viewing the tool from a *different* machine on your
  network no longer works. That was never a supported setup — it was the bug.

### Added

- **Ground-truth corpus** (`corpus/`): a HUD action saves what the user knows
  about the spot Mario is standing on together with the exact surface pool that
  produced it, and `npm run corpus` replays every label through the real
  detector. Each pool also gets a baseline listing every blocked cell, so a
  detector change shows up as added and removed cells instead of a segment
  count nobody can check. Same file format as the planned bug-report export.
- Collision profiles (`src/collision/profile.ts`): the ROM's collision
  behaviour is modelled explicitly as `{ wallThreshold, select }`, with
  vanilla (0.01 / first-hit floor) and Frame's-patch (0.05 / highest floor)
  profiles threaded through the queries, partition, oracle and probe.
- Position-independent patch detection (`src/collision/patchDetect.ts`): reads
  the game's own partition lists out of RDRAM, so a patched ROM is recognised
  on any level instead of only where the two floor-selection rules happen to
  disagree under Mario.
- Version shown in the HUD and in both bridge banners.

### Fixed

- World-scale detection works on sloped ground; it previously required a flat
  floor and silently left the scale at 1 on a 4x level, making every derived
  number wrong by 4x.
- Blocked columns sealed inside solid geometry are no longer reported as
  invisible walls (`entersSolid`).
- **Frame's collision patch is modelled from its actual source.** Its wall
  routine is one-sided, pushes off wall faces *and* edges, and accumulates
  pushes (no over-push); the probe, oracle and partition now run it when the
  patch is present (`CollisionProfile.walls`). Read from the patcher's own
  sources and checked against the machine code it injects.
- The probe's walking step was missing the game's first wall push
  (`(30, 24)`, before `(60, 50)`), so it flagged leaks behind short walls
  (curbs, low ledge faces) that Mario is actually held away from.
- The partition's fine grid could miss a wall at a diagonal: an axis-projected
  wall test reaches up to √2 × the push radius past the wall, not 1×. Results
  could differ from the plain partition near bin borders; now provably
  identical (new wall-heavy fuzz tests — the old fuzz had 4 walls in 400).
- `SURFACE_INTANGIBLE` floors are fallen through, as in `find_floor`, and no
  longer end a blocked region.
- A probe run now splits wherever the blocking ceiling changes, so every column
  is attributed to (and inspected as) the ceiling that actually blocks it.
- Patch detection judged a new RDRAM snapshot against the *previous* level's
  pool at a level change, which reliably read "vanilla"; it now reads the pool
  from the snapshot itself. It also never recognised a vanilla ROM (its
  surface nodes sit below the pool, and a filter assumed above), and counted
  a node at the end of its list as evidence.
- The oracle's air-step wall query was `(60, 150)` instead of `(150, 50)`, and
  none of its wall queries were scaled on 4x hacks.
- Hiding a surface kind in the HUD no longer undoes itself when the pool
  re-streams; the grid helper no longer leaks GPU buffers.
- A display-list triangle referencing an unloaded vertex no longer corrupts
  every later triangle of its material.
- Sky cap colours and vertex shading are treated as sRGB (shadows rendered
  noticeably too bright; caps looked washed out).
- The dev bridge no longer crashes on a malformed client message; garbage
  pool anchors mid level-load no longer make the exe drop and rescan
  Project64; the exe's static server rejects sibling-directory paths.

### Changed

- The world scale is tracked per level: a new level waits (up to 4 s) for a
  measurement before probing, and the HUD says "not yet measured here" when it
  has to fall back to the previous level's value.
- The collision engine is identified per component, with provenance in the
  HUD: the patcher's code edits (wall routine, threshold) are read straight
  from RAM (`patchSignatures.ts`), the partition walk is the fallback, and the
  floor-selection rule is marked "observed" or "assumed" — Frame's patcher
  does not change it, so a patched threshold only *suggests* it.
- The inspector reports the clicked cells' own blocked interval.
- Captures record whether the world scale had been measured on the level.

### Performance

- `PartitionOptions.wallReach`: wall bins were inflated by a 200-unit reach
  while the probe only ever queries at ~12.5, so every wall lookup scanned
  ~100 unreachable walls. Level 15 probe 47.3s → 35.3s, identical output.
- The probe re-ran whenever the TOTAL surface count changed, i.e. every time
  an object with collision loaded or unloaded, and superseded runs were
  computed to completion. It now keys on the level geometry alone, runs once
  per connect, and cancels a superseded run.
- Moving platforms no longer rebuild the whole level's collision mesh 10×/s,
  and the partition is built with one sort per cell instead of the game's
  O(n²) insertion (identical order).
- The exe no longer spawns PowerShell every 2 s while waiting for Project64,
  and serialises each message once rather than once per viewer.

## 1.1.0 — 2026-07-19

- Standalone Windows executable: one process serving the built viewer over
  HTTP and running the bridge on the same port, waiting for Project64 and
  re-attaching by itself.
- Game fog, probe-in-flight banner, Mario marker, camera-framing fixes.

Released as a commit titled `v1.1.0` (eb44992); no git tag was created.

## 1.0.0 — 2026-07-18

First public release: live collision mesh from Project64 RAM, textured level
view, skybox, invisible-wall probe with per-kind overlays and inspector.
