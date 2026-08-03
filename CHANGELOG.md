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

### Performance

- `PartitionOptions.wallReach`: wall bins were inflated by a 200-unit reach
  while the probe only ever queries at ~12.5, so every wall lookup scanned
  ~100 unreachable walls. Level 15 probe 47.3s → 35.3s, identical output.

## 1.1.0 — 2026-07-19

- Standalone Windows executable: one process serving the built viewer over
  HTTP and running the bridge on the same port, waiting for Project64 and
  re-attaching by itself.
- Game fog, probe-in-flight banner, Mario marker, camera-framing fixes.

Released as a commit titled `v1.1.0` (eb44992); no git tag was created.

## 1.0.0 — 2026-07-18

First public release: live collision mesh from Project64 RAM, textured level
view, skybox, invisible-wall probe with per-kind overlays and inspector.
