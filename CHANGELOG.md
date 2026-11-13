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
- `run-exe.cmd`, and a desktop shortcut to it (`npm run shortcut`): one click
  rebuilds the exe if its code changed, makes room on the port (an older copy,
  or the dev bridge), and starts it.
- The HUD shows which commit a build came from next to the version
  (`v1.2.0 · abc1234`; `+` = built with uncommitted changes, `dev` = running
  from source), so an out-of-date exe can be recognised.
- **Jump to Mario**: a HUD button (and the `M` key) that moves the camera to
  Mario, keeping the direction it faces.
- **Stars and red coins**: the bridge streams the level's active objects
  (`ObjectsMessage`), and the ones that are stars or red coins
  (`src/objects/collectibles.ts`, recognised by behaviour script) get a badge
  in the scene, a toggle each, and a list in the HUD — click an entry to jump
  the camera there. Stars are listed with their number, how they are obtained
  (placed, in an exclamation box, red coins, secrets) and the hack's own star
  name, read from the game's text segment (`src/objects/starNames.ts`). Only
  A star handed out by a boss, a race or a task (King Bob-omb, Big Mr. I,
  Koopa the Quick, the treasure chests…) is listed at the object that awards
  it, numbered from that object's parameters. Only what the game has loaded
  can be listed: the current area's objects for the current act. Collected
  red coins drop off the list.

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

- **The world scale could never be measured on flat ground at y = 0** — the
  plane's height is 0 at every scale, so a fresh session on a level whose
  ground is a y = 0 plane probed at 1x on a 4x hack (seen live on level 24).
  The floor's footprint now breaks the tie: only the true scale puts Mario's
  column inside the floor the game reports. Near-ties in height no longer pick
  a scale by a hair's lead either, and a measurement that *disagrees* with the
  scale in force has to repeat before it re-probes the level.
- On a scaled hack, a step target that a wall push moved was filed in the wrong
  column at negative coordinates: the engine truncates the *world* position and
  then floor-divides (`collisionColumn`), the probe truncated the collision
  value. One column off, on exactly the one-column cracks the probe looks for.
- A derived level boundary of 0x8000 wrapped every non-negative coordinate into
  cell 0 (the game's s16 cell-index sum, reproduced where it cannot apply), so
  nothing east or south of the origin was ever found. The boundary is also
  derived from level geometry only — an object carried past a power of two used
  to flip it, moving every cell border and re-running the probe.
- Blocked columns were drawn centred on their integer, half a cell off: column
  5 is `[5, 6)`, column -5 is `(-6, -5]`, column 0 is `(-1, 1)` (`columnSpan`,
  scale-aware). The inspector's coordinates agree with the boxes now.
- The textured level, skybox and engine identification were refreshed on a
  level/area *id* change only. This hack swaps whole maps under one id, which
  left the previous map's model under the new map's collision; they now follow
  the level geometry too, and so does the camera's establishing shot.
- An empty surface pool (title screen, between levels) left the previous
  level's partition and wall overlay in place, with the oracle judging Mario
  against geometry that was no longer loaded.
- Camera: a fly key held while clicking into the note field stayed "down"
  forever (the release went to the field); a mouse button released outside the
  window left the view glued to the pointer; Ctrl+C / Ctrl+S flew the camera;
  holding Shift alone kept the renderer in low-resolution motion mode.
- Clicking with "Invisible walls" switched off still picked (and highlighted)
  the hidden walls.
- Merging probe segments was cubic in the size of a group, and every
  out-of-bounds segment shares one group: 3000 raw segments took 14.6 s to
  merge. Same fixpoint, now milliseconds.
- The HUD said "connected" over an empty scene whenever the exe had no
  Project64 to read (not started yet, or no level entered). The bridge now
  reports whether it is attached, and why not.
- Bridge robustness: a viewer socket error (tab killed mid-send) was an
  unhandled `error` event that killed the whole bridge; the exe's "port is
  taken" message never appeared because the same error was re-thrown first;
  `--port=abc` silently listened on a random port; an unexpected crash closed
  the console window before it could be read.
- A level model parse that hit garbage (a stale graph pointer past the end of
  a 4 MB snapshot) threw out of the message handler instead of reading "no
  model"; a tile rectangle with a fractional size produced a non-integer
  texture.

### Changed

- **The probe runs on several workers at once** (`src/probe/pool.ts`): each
  marches every N-th surface against the same partition and one merges the
  slices, giving exactly the single-worker result (asserted segment-for-segment
  in the tests) in a fraction of the time. Uses every core but one, at most 8.
- The connect button becomes **Disconnect** while a connection is up, and a
  connection that drops (the exe being rebuilt or restarted) is retried
  automatically — relaunching the exe brings the viewer back without a click.
- The dev bridge (`npm start` in `bridge/`) and the exe share one serving loop
  (`bridge/src/session.ts`): the dev bridge now also waits for Project64 and
  re-attaches after it is closed, instead of exiting / logging errors forever.
  A viewer that falls far behind is skipped rather than queued behind without
  bound.
- `npm run typecheck` (and `build:exe`) now type-checks `bridge/` and
  `scripts/` as well; previously nothing did.
- The packaged exe now carries the development tools: the **Ground truth**
  panel (flag a false positive or negative, with a note), which used to exist
  only when running from source, and the `window.__ivw` console hook.
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
