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
import { ProbePool } from "./probe/pool";
import { parseSurfacePool, staticFingerprint } from "./collision/surface";
import type { Surface } from "./collision/surface";
import { buildLevelModel } from "./gfx/level";
import { LiveClient } from "./net/liveClient";
import { BRIDGE_DEFAULT_PORT } from "./net/protocol";
import type { StateMessage } from "./net/protocol";
import { SURFACE_FLAG_DYNAMIC, SURFACE_STRUCT_SIZE } from "./collision/constants";
import { columnSpan } from "./collision/queries";
import { buildCapture, captureFilename, downloadCapture } from "./corpus/capture";
import { findCollectibles, type StarSource } from "./objects/collectibles";
import { readStarNames, type StarNames } from "./objects/starNames";
import type { ObjectsMessage, Vec3 } from "./net/protocol";
import type { JumpItem } from "./viewer/hud";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app container not found");

const viewer = new Viewer(app);
viewer.setSurfaces(demoScene());

// The packaged exe carries every development tool too: while the project is in
// development, the exe is how it actually gets used. That's the ground-truth
// capture panel (flag a spot as a false positive/negative, with a note) and
// the window.__ivw console hook below. A public release decides what stays.
const hud = createHud(app, viewer, {
  // One button: connect, or — while connected, connecting or retrying — stop.
  onConnect: () => (client.active ? client.disconnect() : client.connect()),
  onCaptureLabel: captureLabel,
  onJumpToMario: jumpToMario,
  onJump: (pos) => viewer.jumpTo(toScene(pos)),
});
hud.setCounts(viewer.counts);

// M = jump to Mario, unless the key is going into a text field.
window.addEventListener("keydown", (e) => {
  if (e.code !== "KeyM" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable)) {
    return;
  }
  jumpToMario();
});

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
          // The middle of the positions these columns cover (columnSpan).
          x: ((columnSpan(box.cellX0, s)[0] + columnSpan(box.cellX1, s)[1]) / 2) * s,
          z: ((columnSpan(box.cellZ0, s)[0] + columnSpan(box.cellZ1, s)[1]) / 2) * s,
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
// A measurement that DISAGREES with the scale in force re-probes the whole
// level, so it has to repeat before it is believed: Mario's position is sampled
// after the step that set his floor pointer, and one skewed frame must not cost
// a probe run (same reasoning as the floor-selection debounce below).
let scaleCandidate: number | null = null;
let scaleStreak = 0;
const SCALE_STREAK = 2;
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
  if (liveSurfaces.length === 0) {
    // An empty pool (title screen, between levels) is not "keep the last
    // level": the oracle would go on judging Mario against geometry that is
    // no longer loaded.
    partition = null;
    debug.partition = null;
    return;
  }
  partition = new SpatialPartition(liveSurfaces, {
    select: activeProfile.select,
    walls: activeProfile.walls,
    edgeMargin: 1 / worldScale,
  });
  debug.partition = partition;
}

/** World units (what the game reports) → the scene's collision space. */
function toScene(p: Vec3): Vec3 {
  return { x: p.x / worldScale, y: p.y / worldScale, z: p.z / worldScale };
}

function jumpToMario(): void {
  if (lastState && client.active) viewer.jumpTo(toScene(lastState.pos));
}

// --- Stars and red coins -----------------------------------------------------
// The bridge streams the level's active objects; the ones that are stars or
// red coins get a badge in the scene and a row in the HUD (click = jump the
// camera there). Star names come from the game's own text, read out of each
// RDRAM snapshot. The object list arrives whenever ANY object moves, so the
// scene and the HUD are only touched when what they show actually changed.
let lastObjects: ObjectsMessage | null = null;
let starNames: StarNames | null = null;
let collectiblesKey = "";

const STAR_SOURCE_NOTE: Record<StarSource, string> = {
  star: "",
  box: "in ! box",
  redCoins: "red coins",
  secrets: "secrets",
  giver: "", // the giver's own name is shown instead
};
const STAR_SOURCE_TITLE: Record<StarSource, string> = {
  star: "",
  box: "Inside an exclamation box here",
  redCoins: "Appears here once every red coin is collected",
  secrets: "Appears here once every secret is found",
  giver:
    "Awarded by the object marked here. Where the star then appears is set " +
    "in the game's code and may be somewhere else.",
};
const at = (p: Vec3): string =>
  `(${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)})`;

function syncCollectibles(): void {
  const found = lastObjects
    ? findCollectibles(lastObjects)
    : { course: 0, stars: [], redCoins: [], secrets: [] };
  const stars: JumpItem[] = found.stars.map((s) => {
    const name =
      s.starId === 6 ? "100 coins" : starNames?.actName(found.course, s.starId);
    const label = `Star ${s.starId + 1}` + (name ? ` · ${name}` : "");
    return {
      label,
      note: s.giver ?? (STAR_SOURCE_NOTE[s.source] || undefined),
      // The label again: a long name is cut short in the list.
      title: [label, STAR_SOURCE_TITLE[s.source], at(s.pos)].filter(Boolean).join("\n"),
      pos: s.pos,
    };
  });
  const redCoins: JumpItem[] = found.redCoins.map((c, i) => ({
    label: `Red coin ${i + 1}`,
    note: at(c.pos),
    pos: c.pos,
  }));
  const secrets: JumpItem[] = found.secrets.map((c, i) => ({
    label: `Secret ${i + 1}`,
    note: at(c.pos),
    pos: c.pos,
  }));
  const key = JSON.stringify([worldScale, stars, redCoins, secrets]);
  if (key === collectiblesKey) return;
  collectiblesKey = key;
  viewer.setMarkers("star", found.stars.map((s) => toScene(s.pos)));
  viewer.setMarkers("redCoin", found.redCoins.map((c) => toScene(c.pos)));
  viewer.setMarkers("secret", found.secrets.map((c) => toScene(c.pos)));
  hud.setJumpList("star", stars);
  hud.setJumpList("redCoin", redCoins);
  hud.setJumpList("secret", secrets);
  debug.collectibles = found;
}

/** Nothing is being read any more: don't leave another level's stars up. */
function clearCollectibles(): void {
  lastObjects = null;
  syncCollectibles();
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
let probeRetry: ReturnType<typeof setTimeout> | null = null;
// What the result on screen was computed from, for the inspector.
let probedSurfaces = new Map<number, Surface>();
let probedScale = 1;
// The march is split across workers (see probe/pool.ts); a newer request
// terminates the run in flight.
const probePool = new ProbePool(
  () =>
    new Worker(new URL("./probe/worker.ts", import.meta.url), { type: "module" }),
);

function runProbe(): void {
  // No state frame yet (the bridge sends the pool first): the first one will
  // call back in, with a level to judge the scale against.
  if (levelKey === "") return;
  // New level geometry: whatever is on screen or in flight describes the old
  // level. Clear it now, even if the new probe has to wait.
  if (staticKey !== probedGeometry) {
    probePool.cancel();
    probedGeometry = staticKey;
    probedKey = "";
    viewer.setAnomalies([]);
    hud.setInspector(null);
    hud.setProbe(null);
  }
  if (!partition) {
    hud.setProbeBusy(false); // nothing loaded: nothing to wait for either
    return;
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
    if (!probePool.busy) hud.setProbeBusy(false);
    return;
  }
  probedKey = key;
  // The probe only ever looks at level geometry; don't clone the objects.
  const statics = liveSurfaces.filter((s) => (s.flags & SURFACE_FLAG_DYNAMIC) === 0);
  const context = {
    surfaces: new Map(statics.map((s) => [s.index, s])),
    scale: worldScale,
  };
  hud.setProbeBusy(true);
  probePool.run(
    statics,
    sessionProbeOptions({
      worldScale,
      select: p.select,
      walls: p.walls,
      boundary: partition.boundary,
    }),
    (result) => {
      hud.setProbeBusy(false);
      probedSurfaces = context.surfaces;
      probedScale = context.scale;
      viewer.setAnomalies(result.segments, context.scale);
      hud.setInspector(null); // the old pick no longer exists
      hud.setProbe(result);
      debug.probe = result;
    },
    (message) => {
      // probedKey stays: the same inputs would fail the same way, so only a
      // change of geometry/scale/profile retries.
      hud.setProbeBusy(false);
      hud.setProbeError(message);
    },
  );
}

// --- Textured level ----------------------------------------------------------
// The textured view needs a full RDRAM snapshot (graph nodes + display lists +
// textures), and so does identifying the collision engine. One is requested
// whenever the level/area OR the level geometry changes — this hack swaps whole
// maps under one level id, and keying on the id alone left the previous map's
// model on screen under the new map's collision — and again (a few times) if
// the level's graph wasn't in RAM yet, which happens right at a transition.
// The two halves of the key arrive in separate messages moments apart, so the
// request waits for them to settle rather than firing twice.
let gfxKey = "";
let gfxTries = 0;
const GFX_MAX_TRIES = 5;
const SNAPSHOT_SETTLE_MS = 150;
let gfxTimer: ReturnType<typeof setTimeout> | null = null;
// Camera framing: reframe on a real level/area change only. The new level's
// surfaces can arrive just before OR just after the state frame that carries
// the new level id, so the change opens a short window during which incoming
// surface pools also reframe (frame() is idempotent for identical bounds).
let reframeUntil = 0;

function scheduleSnapshot(delayMs: number): void {
  if (gfxTimer) clearTimeout(gfxTimer);
  gfxTimer = setTimeout(() => {
    gfxTimer = null;
    gfxTries++;
    client.send({ type: "rdram" });
  }, delayMs);
}

/** Ask for a snapshot if what is loaded changed since the last one. */
function syncSnapshot(): void {
  if (levelKey === "" || geometryKey === "") return; // need a state AND a pool
  const want = `${levelKey}|${geometryKey}`;
  if (want === gfxKey) return;
  gfxKey = want;
  gfxTries = 0;
  scheduleSnapshot(SNAPSHOT_SETTLE_MS);
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
// Whether the socket is open / the bridge has Project64, to notice the moment
// either comes (back) up.
let wasConnected = false;
let wasAttached = true;
/** What is on the other end may have changed (a different bridge, a restarted
 * emulator, another ROM): have the next frames fetch a new snapshot — engine
 * identity + level model — instead of trusting what was learned before. */
function distrustSession(): void {
  gfxKey = "";
  snapshotSeen = false;
  levelSince = Date.now();
}
const client = new LiveClient(bridgeUrl, {
  onStatus: (text, connected, active) => {
    hud.setStatus(text, connected, active);
    if (connected && !wasConnected) distrustSession();
    wasConnected = connected;
    if (!connected) {
      // Nothing is being measured any more: don't leave a verdict on screen
      // that looks live.
      hud.setOracle(null);
      hud.setCaptureReady(false);
      hud.setMarioAvailable(false);
      clearCollectibles();
    }
  },
  onBridge: (attached, detail) => {
    // The exe serves the page before (and after) Project64 exists; without
    // this the HUD said "connected" over a scene that never arrived.
    if (attached) {
      hud.setStatus("connected", true, true);
      if (!wasAttached) distrustSession();
    } else {
      hud.setStatus(`connected — waiting for Project64 (${detail})`, false, true);
      hud.setOracle(null);
      hud.setMarioAvailable(false);
      clearCollectibles();
    }
    wasAttached = attached;
  },
  onSurfaces: (surfaces) => {
    liveSurfaces = surfaces;
    const geometry = staticFingerprint(surfaces);
    const geometryChanged = geometry !== geometryKey;
    if (geometryChanged) {
      geometryKey = geometry;
      levelSince = Date.now(); // the scale wait restarts with new geometry
    }
    staticKey = `${geometryKey}@${activeProfile.wallThreshold}`;
    surfaceByAddr = new Map(surfaces.map((s) => [s.address >>> 0, s]));
    viewer.setSurfaces(surfaces, staticKey);
    // New level geometry is a new place: frame it. (Object surfaces are not
    // part of the fingerprint, so a platform moving never does this.)
    if (geometryChanged || Date.now() < reframeUntil) viewer.reframe();
    hud.setCounts(viewer.counts);
    rebuildPartition();
    debug.surfaces = surfaces;
    syncSnapshot();
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
    // The hack's star names (static text, but a different ROM may be loaded).
    // A snapshot taken before the text segment is in place keeps the old ones.
    const names = readStarNames(bytes);
    if (names) starNames = names;
    debug.starNames = names;
    syncCollectibles();
    snapshotSeen = true;
    applyProfile();
    runProbe(); // a probe held for the engine verdict can go now

    // The display lists are whatever the hack put in RAM; a parse that trips
    // over garbage must not take the rest of this handler (or the socket's
    // message loop) with it.
    let model: ReturnType<typeof buildLevelModel> = null;
    try {
      model = buildLevelModel(bytes);
    } catch (err) {
      console.warn("level model parse failed:", err);
    }
    if (!model && gfxTries < GFX_MAX_TRIES && !gfxTimer) scheduleSnapshot(1000);
    viewer.setLevelModel(model);
    hud.setTexturedAvailable(model !== null);
    hud.setSkyboxAvailable(model?.skybox != null);
    hud.setFogAvailable(model?.fog != null);
    debug.levelModel = model;
  },
  onObjects: (objects) => {
    lastObjects = objects;
    syncCollectibles();
  },
  onState: (state) => {
    lastState = state;
    hud.setCaptureReady(client.rawPool !== null);
    hud.setMarioAvailable(true);

    const nextLevel = `${state.level}:${state.area}`;
    const levelChanged = nextLevel !== levelKey;
    if (levelChanged) {
      levelKey = nextLevel;
      levelSince = Date.now();
    }

    const detected = detectWorldScale(liveSurfaces, state, surfaceByAddr);
    if (detected === worldScale) {
      scaleVerifiedFor = scaleKey();
      scaleCandidate = null;
    } else if (detected !== null) {
      if (detected === scaleCandidate) scaleStreak++;
      else {
        scaleCandidate = detected;
        scaleStreak = 1;
      }
      if (scaleStreak >= SCALE_STREAK) {
        worldScale = detected;
        scaleVerifiedFor = scaleKey();
        scaleCandidate = null;
        rebuildPartition(); // Frame's edge margin is 1/scale
      }
    }
    viewer.setModelScale(worldScale);
    syncCollectibles(); // badges sit in collision space: follow the scale

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

    if (levelChanged) {
      // A real level/area change: snap the camera to the new level (and let
      // the surface pools arriving over the next moments do the same, in
      // case they land after this state frame).
      viewer.reframe();
      reframeUntil = Date.now() + 2000;
    }
    syncSnapshot();
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
