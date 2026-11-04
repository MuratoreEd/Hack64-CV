// Entry point: render a demo scene offline, and swap to live collision data
// from Project64 when the user connects to the bridge.
import "./style.css";
import { Viewer } from "./viewer/viewer";
import { createHud } from "./viewer/hud";
import { demoScene } from "./collision/synthetic";
import { SpatialPartition } from "./collision/partition";
import {
  evaluateOracle,
  detectWorldScale,
  detectFloorSelect,
} from "./collision/oracle";
import {
  VANILLA_PROFILE,
  PATCHED_PROFILE,
  wallsForThreshold,
  type CollisionProfile,
  type FloorSelect,
  type WallModel,
} from "./collision/profile";
import { detectWallThreshold, readPoolFromRdram } from "./collision/patchDetect";
import { detectPatchSignatures } from "./collision/patchSignatures";
import { sessionProbeOptions } from "./probe/config";
import type { ProbeRequest, ProbeResponse } from "./probe/worker";
import { parseSurfacePool, staticFingerprint } from "./collision/surface";
import type { Surface } from "./collision/surface";
import { buildLevelModel } from "./gfx/level";
import { LiveClient } from "./net/liveClient";
import { BRIDGE_DEFAULT_PORT } from "./net/protocol";
import type { StateMessage } from "./net/protocol";
import { SURFACE_FLAG_DYNAMIC, SURFACE_STRUCT_SIZE } from "./collision/constants";
import { buildCapture, captureFilename, downloadCapture } from "./corpus/capture";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app container not found");

const viewer = new Viewer(app);
viewer.setSurfaces(demoScene());

// The packaged exe carries every development tool too: while the project is in
// development, the exe is how it actually gets used. That's the ground-truth
// capture panel (flag a spot as a false positive/negative, with a note) and
// the window.__ivw console hook below. A public release decides what stays.
const hud = createHud(app, viewer, {
  onConnect: () => client.connect(),
  onCaptureLabel: captureLabel,
});
hud.setCounts(viewer.counts);

// Clicking an anomaly box resolves it back to the responsible surfaces (only
// main.ts holds the pool + world scale) and drives the inspector panel. The
// box is the clicked cells' own data; the segment is the run they belong to.
viewer.onAnomalyPick = (seg, box) => {
  if (!seg) {
    hud.setInspector(null);
    return;
  }
  const s = probedScale;
  const blocker = seg.blockerAddr
    ? surfaceByAddr.get(seg.blockerAddr >>> 0)
    : undefined;
  const source = probedSurfaces.get(seg.sourceIndex);
  hud.setInspector({
    kind: seg.kind,
    cells: box
      ? {
          // Cell c spans [c, c+1) in collision units.
          x: ((box.cellX0 + box.cellX1 + 1) / 2) * s,
          z: ((box.cellZ0 + box.cellZ1 + 1) / 2) * s,
          count: (box.cellX1 - box.cellX0 + 1) * (box.cellZ1 - box.cellZ0 + 1),
          yLow: box.yLow * s,
          yHigh: box.yHigh * s,
        }
      : null,
    runLow: seg.yLow * s,
    runHigh: seg.yHigh * s,
    standY: seg.yBase * s,
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
// Identity of the level geometry in liveSurfaces (see staticFingerprint): the
// bridge re-streams the pool whenever ANY object surface moves, and nothing
// that depends only on level geometry should redo work for that. staticKey
// adds the wall threshold the pool was parsed under (it decides the kinds).
let geometryKey = "";
let staticKey = "";
// address -> Surface for the current pool, so the oracle can look up the game's
// wall for the coplanar-sibling check even when we didn't detect it ourselves.
let surfaceByAddr = new Map<number, Surface>();

// --- World scale ---------------------------------------------------------
// World→collision scale (some hacks store collision at 1/scale of Mario's world
// coords), detected from the game's reported floor. Detection can fail for a
// while (a flat floor at y=0 fits every scale), so the value is sticky — but it
// is only VERIFIED for the level (and level geometry) it was measured on. A new
// level starts unverified: the probe waits for a measurement (up to
// SCALE_WAIT_MS) instead of silently running with the previous level's value,
// and the HUD says so when it has to fall back to it. The geometry is part of
// the key because a new level's pool can arrive BEFORE the state frame that
// names the level — the level id alone would still vouch for the old scale.
let worldScale = 1;
let levelKey = "";
let levelSince = 0;
let scaleVerifiedFor = "";
const SCALE_WAIT_MS = 4000;
const scaleKey = () => `${levelKey}|${geometryKey}`;
const scaleVerified = () => levelKey !== "" && scaleVerifiedFor === scaleKey();

// --- Collision engine (profile) --------------------------------------------
// ROM-level collision patches change real behavior (see collision/profile.ts),
// so the core has to know which engine it's imitating. Each component carries
// its own evidence:
//   - code signatures (patchSignatures.ts): the patcher's own edits read back
//     out of each RDRAM snapshot — the wall routine and the wall threshold;
//   - the partition walk (patchDetect.ts): the threshold, inferred from which
//     list the game filed borderline surfaces in — the fallback when the code
//     is somewhere the signatures don't know;
//   - the oracle (detectFloorSelect): the floor-selection rule, observed only
//     when two containing floors disagree under Mario, so it is debounced.
// Floor selection has no code signature (Frame's patcher doesn't touch it), so
// until observed it's ASSUMED from the threshold — see profile.ts for why.
let sigWalls: WallModel | null = null;
let sigThreshold: number | null = null;
let walkThreshold: number | null = null;
let observedSelect: FloorSelect | null = null;
let selectCandidate: FloorSelect | null = null;
let selectStreak = 0;
const SELECT_STREAK = 3;
let activeProfile: CollisionProfile = VANILLA_PROFILE;
// Until the first RDRAM snapshot has been examined, "vanilla" is only the
// default; the probe waits for it (bounded like the scale wait) rather than
// running once under the wrong engine and again under the right one.
let snapshotSeen = false;

interface ProfileVerdict {
  profile: CollisionProfile;
  /** Whether any evidence at all backs it (vs the vanilla default). */
  known: boolean;
  thresholdSource: "code" | "partition" | null;
  wallsSource: "code" | "threshold" | null;
  selectSource: "observed" | "threshold" | null;
}

function profileVerdict(): ProfileVerdict {
  const threshold = sigThreshold ?? walkThreshold;
  const wallThreshold = threshold ?? VANILLA_PROFILE.wallThreshold;
  const walls = sigWalls ?? wallsForThreshold(wallThreshold);
  const select =
    observedSelect ??
    (wallThreshold === PATCHED_PROFILE.wallThreshold ? "extreme" : "first");
  return {
    profile: { wallThreshold, walls, select },
    known: threshold !== null || sigWalls !== null || observedSelect !== null,
    thresholdSource:
      sigThreshold !== null ? "code" : walkThreshold !== null ? "partition" : null,
    wallsSource: sigWalls !== null ? "code" : threshold !== null ? "threshold" : null,
    selectSource:
      observedSelect !== null ? "observed" : threshold !== null ? "threshold" : null,
  };
}

/** Adopt whatever the evidence now says. A threshold change re-classifies the
 * pool (a parse-time decision), which re-fires onSurfaces and so rebuilds the
 * partition and re-probes; a select/walls-only change does that directly. */
function applyProfile(): void {
  const v = profileVerdict();
  hud.setProfile(v);
  debug.profile = v;
  const p = v.profile;
  const a = activeProfile;
  if (p.wallThreshold === a.wallThreshold && p.walls === a.walls && p.select === a.select) {
    return;
  }
  activeProfile = p;
  const reparsed = p.wallThreshold !== a.wallThreshold && client.rawPool !== null;
  client.setWallThreshold(p.wallThreshold);
  if (!reparsed) {
    rebuildPartition();
    runProbe();
  }
}

function rebuildPartition(): void {
  if (liveSurfaces.length === 0) return;
  partition = new SpatialPartition(liveSurfaces, {
    select: activeProfile.select,
    walls: activeProfile.walls,
    edgeMargin: 1 / worldScale,
  });
  debug.partition = partition;
}

// Previous frame's Mario position, to tell whether he moved. When he didn't, the
// game leaves gMarioState->wall stale, so the wall oracle can't be checked.
let prevPos: { x: number; y: number; z: number } | null = null;
// Latest state frame, so a ground-truth capture records the level/area/position
// the user is looking at right now.
let lastState: StateMessage | null = null;

// --- Probe -------------------------------------------------------------------
// The probe depends on the level geometry, the world scale (Mario's 160-unit
// hitbox is 160/scale collision units) and the profile, and takes seconds, so
// it runs in a Web Worker whenever that key changes. A newer request makes the
// one in flight worthless, so it's cancelled outright (worker terminated) —
// previously superseded runs were computed to completion and thrown away, and
// every object loading or unloading (which changes the total surface count)
// queued another full run behind them.
let probedKey = "";
// Level geometry of the overlay on screen (or of the run in flight), so a
// level change can clear walls that belong to the old geometry at once.
let probedGeometry = "";
let probeWorker: Worker | null = null;
let probeSeq = 0;
let probeInFlight = false;
let probeRetry: ReturnType<typeof setTimeout> | null = null;
// What a result was computed from, for the inspector: pending while in
// flight, shown once its result is on screen.
interface ProbeContext {
  surfaces: Map<number, Surface>;
  scale: number;
}
let pendingProbe: ProbeContext | null = null;
let probedSurfaces = new Map<number, Surface>();
let probedScale = 1;

function startWorker(): Worker {
  const w = new Worker(new URL("./probe/worker.ts", import.meta.url), {
    type: "module",
  });
  w.onmessage = (e: MessageEvent<ProbeResponse>) => {
    if (e.data.id !== probeSeq) return; // superseded
    probeInFlight = false;
    hud.setProbeBusy(false);
    if ("error" in e.data) {
      // probedKey stays: the same inputs would fail the same way, so only a
      // change of geometry/scale/profile retries.
      hud.setProbeError(e.data.error);
      return;
    }
    if (pendingProbe) {
      probedSurfaces = pendingProbe.surfaces;
      probedScale = pendingProbe.scale;
    }
    viewer.setAnomalies(e.data.result.segments);
    hud.setInspector(null); // the old pick no longer exists
    hud.setProbe(e.data.result);
    debug.probe = e.data.result;
  };
  w.onerror = (e) => {
    // The worker itself failed (e.g. its module didn't load): drop it so the
    // next change starts a fresh one.
    probeInFlight = false;
    hud.setProbeBusy(false);
    hud.setProbeError(e.message || "probe worker failed");
    w.terminate();
    if (probeWorker === w) probeWorker = null;
  };
  return w;
}

function cancelProbe(): void {
  if (probeInFlight && probeWorker) {
    probeWorker.terminate();
    probeWorker = null;
  }
  probeInFlight = false;
  probeSeq++; // anything still in the pipe is now stale
}

function runProbe(): void {
  if (!partition || liveSurfaces.length === 0) return;
  // No state frame yet (the bridge sends the pool first): the first one will
  // call back in, with a level to judge the scale against.
  if (levelKey === "") return;
  // New level geometry: whatever is on screen or in flight describes the old
  // level. Clear it now, even if the new probe has to wait.
  if (staticKey !== probedGeometry) {
    cancelProbe();
    probedGeometry = staticKey;
    probedKey = "";
    viewer.setAnomalies([]);
    hud.setInspector(null);
    hud.setProbe(null);
  }
  // Hold off on a level whose scale isn't confirmed yet (or before the engine
  // has been identified), rather than probing under a stale assumption and
  // then probing again.
  const waited = Date.now() - levelSince;
  const waitingFor = !snapshotSeen
    ? "Identifying the collision engine…"
    : !scaleVerified()
      ? "Waiting for the world scale…"
      : null;
  if (waitingFor && waited < SCALE_WAIT_MS) {
    hud.setProbeBusy(true, waitingFor);
    if (!probeRetry) {
      probeRetry = setTimeout(() => {
        probeRetry = null;
        runProbe();
      }, SCALE_WAIT_MS - waited + 50);
    }
    return;
  }
  const p = activeProfile;
  const key =
    `${staticKey}:${partition.boundary}:${worldScale}:` +
    `${p.wallThreshold}:${p.walls}:${p.select}`;
  if (key === probedKey) {
    if (!probeInFlight) hud.setProbeBusy(false);
    return;
  }
  probedKey = key;
  cancelProbe();
  probeWorker ??= startWorker();
  // The probe only ever looks at level geometry; don't clone the objects.
  const statics = liveSurfaces.filter((s) => (s.flags & SURFACE_FLAG_DYNAMIC) === 0);
  pendingProbe = {
    surfaces: new Map(statics.map((s) => [s.index, s])),
    scale: worldScale,
  };
  const request: ProbeRequest = {
    id: ++probeSeq,
    surfaces: statics,
    options: sessionProbeOptions({
      worldScale,
      select: p.select,
      walls: p.walls,
      boundary: partition.boundary,
    }),
  };
  probeInFlight = true;
  hud.setProbeBusy(true);
  probeWorker.postMessage(request);
}

// --- Textured level ----------------------------------------------------------
// The textured view needs a full RDRAM snapshot (graph nodes + display lists +
// textures). Requested once per level/area — and again (a few times) if the
// level's graph wasn't in RAM yet, which happens right at a transition.
let gfxKey = "";
let gfxTries = 0;
const GFX_MAX_TRIES = 5;
let gfxRetry: ReturnType<typeof setTimeout> | null = null;
// Camera framing: reframe on a real level/area change only. The new level's
// surfaces can arrive just before OR just after the state frame that carries
// the new level id, so the change opens a short window during which incoming
// surface pools also reframe (frame() is idempotent for identical bounds).
let reframeUntil = 0;

function requestSnapshot(): void {
  gfxTries++;
  client.send({ type: "rdram" });
}

/** Save what the user knows about the spot Mario is standing on, together with
 * the surface pool that produced it — the R1 ground-truth corpus is built from
 * these, and R6 bug reports use the identical file format. */
async function captureLabel(
  label: "wall" | "clear",
  note: string,
): Promise<string> {
  const pool = client.rawPool;
  if (!pool || !lastState) throw new Error("connect and enter a level first");
  const bytes = new Uint8Array(pool.buffer, 0, pool.count * SURFACE_STRUCT_SIZE);
  const v = profileVerdict();
  const capture = await buildCapture(
    {
      poolBytes: bytes,
      poolCount: pool.count,
      poolBase: pool.base,
      level: lastState.level,
      area: lastState.area,
      worldScale,
      worldScaleVerified: scaleVerified(),
      profile: {
        wallThreshold: v.profile.wallThreshold,
        select: v.profile.select,
        walls: v.profile.walls,
        known: v.known,
      },
      marioWorldPos: {
        x: lastState.pos.x,
        y: lastState.pos.y,
        z: lastState.pos.z,
      },
    },
    label,
    note,
  );
  downloadCapture(capture);
  return `saved ${captureFilename(capture)}`;
}

// Inspection hook so the live partition/surfaces/state (and the viewer/hud, for
// driving the anomaly overlay by hand) can be poked at from the console (or the
// preview tools) while validating the oracle and probe — in the exe as well, so
// a report can be investigated on the build that produced it.
const debug: Record<string, unknown> = { viewer, hud, captureLabel };
(window as unknown as { __ivw: unknown }).__ivw = debug;

// Dev: Vite serves the page on 5173 and the bridge listens on its own port.
// Packaged exe: one server does both, so the bridge is wherever the page
// came from.
const bridgeUrl = import.meta.env.DEV
  ? `ws://localhost:${BRIDGE_DEFAULT_PORT}`
  : `ws://${location.host}`;
const client = new LiveClient(bridgeUrl, {
  onStatus: (text, connected) => hud.setStatus(text, connected),
  onSurfaces: (surfaces) => {
    liveSurfaces = surfaces;
    const geometry = staticFingerprint(surfaces);
    if (geometry !== geometryKey) {
      geometryKey = geometry;
      levelSince = Date.now(); // the scale wait restarts with new geometry
    }
    staticKey = `${geometryKey}@${activeProfile.wallThreshold}`;
    surfaceByAddr = new Map(surfaces.map((s) => [s.address >>> 0, s]));
    viewer.setSurfaces(surfaces, staticKey);
    if (Date.now() < reframeUntil) viewer.reframe();
    hud.setCounts(viewer.counts);
    rebuildPartition();
    debug.surfaces = surfaces;
    runProbe(); // no-op unless the level geometry (or scale/profile) changed
  },
  onRdram: (bytes) => {
    // For __ivw: lets DL-level issues be probed in-page (one 8 MB snapshot,
    // replaced by the next).
    debug.rdram = bytes;

    // Identify the collision engine from THIS snapshot — its code, and the
    // pool it contains (never the last streamed pool, which may still be the
    // previous level's).
    const sig = detectPatchSignatures(bytes);
    if (
      (sigWalls !== null && sig.walls !== null && sig.walls !== sigWalls) ||
      (sigThreshold !== null && sig.wallThreshold !== null &&
        sig.wallThreshold !== sigThreshold)
    ) {
      // Different code than before: a different ROM. What the oracle observed
      // about the old one no longer applies.
      observedSelect = null;
      selectStreak = 0;
    }
    sigWalls = sig.walls;
    sigThreshold = sig.wallThreshold;
    const snap = readPoolFromRdram(bytes);
    if (snap) {
      const surfaces = parseSurfacePool(
        snap.bytes.slice().buffer as ArrayBuffer,
        snap.count,
        { baseAddress: snap.base },
      );
      const walk = detectWallThreshold(bytes, surfaces);
      debug.patchDetection = walk;
      // A level with no borderline surfaces says nothing: keep the belief.
      if (walk.wallThreshold !== null) walkThreshold = walk.wallThreshold;
    }
    debug.patchSignatures = sig;
    snapshotSeen = true;
    applyProfile();
    runProbe(); // a probe held for the engine verdict can go now

    const model = buildLevelModel(bytes);
    if (!model && gfxTries < GFX_MAX_TRIES && !gfxRetry) {
      const key = gfxKey;
      gfxRetry = setTimeout(() => {
        gfxRetry = null;
        if (key === gfxKey) requestSnapshot();
      }, 1000);
    }
    viewer.setLevelModel(model);
    hud.setTexturedAvailable(model !== null);
    hud.setSkyboxAvailable(model?.skybox != null);
    hud.setFogAvailable(model?.fog != null);
    debug.levelModel = model;
  },
  onState: (state) => {
    lastState = state;
    hud.setCaptureReady(client.rawPool !== null);

    const nextLevel = `${state.level}:${state.area}`;
    if (nextLevel !== levelKey) {
      levelKey = nextLevel;
      levelSince = Date.now();
    }

    const detected = detectWorldScale(liveSurfaces, state);
    if (detected !== null) {
      const changed = detected !== worldScale;
      worldScale = detected;
      scaleVerifiedFor = scaleKey();
      if (changed) rebuildPartition(); // Frame's edge margin is 1/scale
    }
    viewer.setModelScale(worldScale);

    // Direct observation of the selection rule, when the geometry under Mario
    // happens to expose it. Debounced: one frame's pos/pointer skew must not
    // flip the engine and re-probe the level.
    if (partition) {
      const verdict = detectFloorSelect(partition, state, worldScale);
      if (verdict !== null) {
        if (verdict === selectCandidate) selectStreak++;
        else {
          selectCandidate = verdict;
          selectStreak = 1;
        }
        if (selectStreak >= SELECT_STREAK && observedSelect !== verdict) {
          observedSelect = verdict;
          applyProfile();
        }
      }
    }

    if (nextLevel !== gfxKey) {
      gfxKey = nextLevel;
      gfxTries = 0;
      requestSnapshot();
      // A real level/area change: snap the camera to the new level (and let
      // the surface pools arriving over the next moments do the same, in
      // case they land after this state frame).
      viewer.reframe();
      reframeUntil = Date.now() + 2000;
    }
    runProbe(); // no-op unless the geometry, scale or profile changed

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
    hud.setContext(state.level, state.area, state.pos, worldScale, scaleVerified());
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
