// Entry point: render a demo scene offline, and swap to live collision data
// from Project64 when the user connects to the bridge.
import "./style.css";
import { Viewer } from "./viewer/viewer";
import { createHud } from "./viewer/hud";
import { demoScene } from "./collision/synthetic";
import { SpatialPartition } from "./collision/partition";
import { evaluateOracle, detectWorldScale } from "./collision/oracle";
import type { ProbeResult } from "./probe/invisibleWalls";
import type { ProbeRequest } from "./probe/worker";
import type { Surface } from "./collision/surface";
import { buildLevelModel } from "./gfx/level";
import { LiveClient } from "./net/liveClient";
import { BRIDGE_DEFAULT_PORT } from "./net/protocol";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app container not found");

const viewer = new Viewer(app);
viewer.setSurfaces(demoScene());

const hud = createHud(app, viewer, {
  onConnect: () => client.connect(),
});
hud.setCounts(viewer.counts);

// Clicking an anomaly quad resolves it back to the responsible surfaces (only
// main.ts holds the pool + world scale) and drives the inspector panel.
viewer.onAnomalyPick = (seg) => {
  if (!seg) {
    hud.setInspector(null);
    return;
  }
  const blocker = seg.blockerAddr
    ? surfaceByAddr.get(seg.blockerAddr >>> 0)
    : undefined;
  const source = liveSurfaces[seg.sourceIndex];
  const cx = (seg.x0 + seg.x1) / 2;
  const cz = (seg.z0 + seg.z1) / 2;
  hud.setInspector({
    kind: seg.kind,
    worldCenter: {
      x: cx * worldScale,
      y: seg.yBase * worldScale,
      z: cz * worldScale,
    },
    regionLow: seg.yLow * worldScale,
    regionHigh: seg.yHigh * worldScale,
    samples: seg.samples,
    blockerAddr: seg.blockerAddr,
    blockerKind: blocker?.kind ?? null,
    sourceAddr: source?.address ?? 0,
    sourceKind: source?.kind ?? null,
  });
};

// Rebuilt whenever a fresh surface pool arrives; used to run our collision core
// at Mario's position each frame and validate it against the game (the oracle).
let partition: SpatialPartition | null = null;
let liveSurfaces: Surface[] = [];
// address -> Surface for the current pool, so the oracle can look up the game's
// wall for the coplanar-sibling check even when we didn't detect it ourselves.
let surfaceByAddr = new Map<number, Surface>();
// World→collision scale (some hacks store collision at 1/scale of Mario's world
// coords). Detected from a flat floor; sticky until a new value is confirmed.
let worldScale = 1;
// Previous frame's Mario position, to tell whether he moved. When he didn't, the
// game leaves gMarioState->wall stale, so the wall oracle can't be checked.
let prevPos: { x: number; y: number; z: number } | null = null;
// The probe depends on the surface pool AND worldScale (Mario's 160-unit hitbox
// is a world-space constant, = 160/scale in collision units). Scale is only
// known once state frames arrive, so run the probe lazily whenever this key
// changes — it re-runs automatically when scale detection flips 1 → 4. Edge
// marching over all floors+ceilings takes a noticeable fraction of a second,
// so it runs in a Web Worker; the worker processes requests in order, so the
// latest posted request always wins.
let probedKey = "";
let probeWorker: Worker | null = null;
// The textured view needs a full RDRAM snapshot (graph nodes + display lists
// + textures). Requested once per level/area; large, so never streamed.
let gfxKey = "";

function runProbe(): void {
  if (!partition) return;
  const key = `${liveSurfaces.length}:${partition.boundary}:${worldScale}`;
  if (key === probedKey) return;
  probedKey = key;
  if (!probeWorker) {
    probeWorker = new Worker(new URL("./probe/worker.ts", import.meta.url), {
      type: "module",
    });
    probeWorker.onmessage = (e: MessageEvent<ProbeResult>) => {
      viewer.setAnomalies(e.data.segments);
      hud.setProbe(e.data);
      debug.probe = e.data;
    };
  }
  const request: ProbeRequest = {
    surfaces: liveSurfaces,
    options: {
      marioHeight: 160 / worldScale,
      ledgeGrace: 100 / worldScale,
      wallOffset: 60 / worldScale,
      wallRadius: 50 / worldScale,
      boundary: partition.boundary,
    },
  };
  probeWorker.postMessage(request);
}

// Dev-only inspection hook so the live partition/surfaces/state (and the
// viewer/hud, for driving the anomaly overlay by hand) can be poked at from the
// console (or the preview tools) while validating the oracle and probe.
const debug: Record<string, unknown> = { viewer, hud };
if (import.meta.env.DEV) (window as unknown as { __ivw: unknown }).__ivw = debug;

const client = new LiveClient(`ws://localhost:${BRIDGE_DEFAULT_PORT}`, {
  onStatus: (text, connected) => hud.setStatus(text, connected),
  onSurfaces: (surfaces) => {
    liveSurfaces = surfaces;
    surfaceByAddr = new Map(surfaces.map((s) => [s.address >>> 0, s]));
    viewer.setSurfaces(surfaces);
    hud.setCounts(viewer.counts);
    partition = new SpatialPartition(surfaces);
    debug.surfaces = surfaces;
    debug.partition = partition;
    runProbe();
  },
  onRdram: (bytes) => {
    const model = buildLevelModel(bytes);
    viewer.setLevelModel(model);
    hud.setTexturedAvailable(model !== null);
    hud.setSkyboxAvailable(model?.skybox != null);
    debug.levelModel = model;
  },
  onState: (state) => {
    const detected = detectWorldScale(liveSurfaces, state);
    if (detected) worldScale = detected;
    viewer.setModelScale(worldScale);
    const nextGfxKey = `${state.level}:${state.area}`;
    if (nextGfxKey !== gfxKey) {
      gfxKey = nextGfxKey;
      client.send({ type: "rdram" });
    }
    runProbe(); // no-op unless the pool or the detected scale changed
    const moved =
      prevPos === null ||
      prevPos.x !== state.pos.x ||
      prevPos.y !== state.pos.y ||
      prevPos.z !== state.pos.z;
    prevPos = { x: state.pos.x, y: state.pos.y, z: state.pos.z };
    // Place the marker in collision space so it aligns with the collision mesh.
    viewer.setMarioPosition({
      x: state.pos.x / worldScale,
      y: state.pos.y / worldScale,
      z: state.pos.z / worldScale,
    });
    hud.setContext(state.level, state.area, state.pos, worldScale);
    const oracle = partition
      ? evaluateOracle(partition, state, worldScale, { moved, surfaceByAddr })
      : null;
    hud.setOracle(oracle);
    debug.state = state;
    debug.worldScale = worldScale;
    debug.oracle = oracle;
    debug.moved = moved;
  },
});
