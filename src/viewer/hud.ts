// DOM overlay: connect button, connection status, live level/area/Mario info,
// the "core vs game" oracle panel, and per-kind visibility toggles with counts.

import type { Viewer, MarkerKind } from "./viewer";
import { SurfaceKind } from "../collision/surface";
import {
  KIND_COLOR,
  ANOMALY_COLOR,
  ANOMALY_KIND_COLOR,
  ANOMALY_KIND_LABEL,
  ANOMALY_KINDS,
} from "./palette";
import type { OracleResult } from "../collision/oracle";
import type { CollisionProfile } from "../collision/profile";
import type { ProbeResult, InvisibleWallKind } from "../probe/invisibleWalls";
import { APP_VERSION } from "../version";

const swatchHex = (c: number): string => "#" + c.toString(16).padStart(6, "0");

/** A picked anomaly, resolved to the surfaces behind it (built in main.ts,
 * which alone knows the surface pool and world scale). World units. */
export interface InspectorInfo {
  kind: InvisibleWallKind;
  /** The clicked box itself: adjacent blocked cells sharing one interval. */
  cells: { x: number; z: number; count: number; yLow: number; yHigh: number } | null;
  /** The whole run (segment) the box belongs to: its union interval and the
   * floor height Mario stood on when a step into it was blocked. */
  runLow: number;
  runHigh: number;
  standY: number;
  samples: number;
  blockerAddr: number;
  blockerKind: string | null;
  sourceAddr: number;
  sourceKind: string | null;
}

/** Which collision engine the ROM was identified as, and on what evidence. */
export interface ProfileInfo {
  profile: CollisionProfile;
  known: boolean;
  thresholdSource: "code" | "partition" | null;
  wallsSource: "code" | "threshold" | null;
  selectSource: "observed" | "threshold" | null;
}

const hex = (a: number): string => (a ? "0x" + (a >>> 0).toString(16) : "none");
const mark = (ok: boolean): string => (ok ? "✓" : "✗");

const KIND_LABEL: Record<SurfaceKind, string> = {
  [SurfaceKind.Floor]: "Floors",
  [SurfaceKind.Wall]: "Walls",
  [SurfaceKind.Ceiling]: "Ceilings",
};

const ORDER: SurfaceKind[] = [
  SurfaceKind.Floor,
  SurfaceKind.Wall,
  SurfaceKind.Ceiling,
];

/** One row of a star / red-coin list: click it and the camera goes there. */
export interface JumpItem {
  label: string;
  /** Dimmer text after the label (how the star is obtained, a position). */
  note?: string;
  /** Hover text. */
  title?: string;
  /** World units, as the game reports positions. Absent when there is nowhere
   * in the scene to go: the row is then information only. */
  pos?: { x: number; y: number; z: number };
  /** Draw the row dimmed: it is about something that is not there now. */
  dim?: boolean;
}

/** The kinds that get a HUD row (an absent star is a row of the Stars list). */
export type JumpListKind = Exclude<MarkerKind, "starAbsent">;

const MARKER_LABEL: Record<JumpListKind, string> = {
  star: "Stars",
  redCoin: "Red coins",
  secret: "Secrets",
};
const MARKER_KINDS: JumpListKind[] = ["star", "redCoin", "secret"];

export interface HudCallbacks {
  onConnect(): void;
  /** Put the camera on Mario. */
  onJumpToMario?(): void;
  /** Put the camera on a list entry (world-unit position). */
  onJump?(pos: { x: number; y: number; z: number }): void;
  /** Save a ground-truth label at Mario's current position (corpus capture).
   * Returns what to show the user; throws are reported in the same line. */
  onCaptureLabel?(label: "wall" | "clear", note: string): Promise<string>;
}

export interface Hud {
  /** `active`: connected, connecting or retrying — the button then offers to
   * stop instead of to connect. */
  setStatus(text: string, connected: boolean, active?: boolean): void;
  setCounts(counts: Record<SurfaceKind, number>): void;
  setContext(
    level: number,
    area: number,
    pos: { x: number; y: number; z: number },
    scale?: number,
    scaleVerified?: boolean,
  ): void;
  /** Update the "core vs game" panel, or pass null to hide it. */
  setOracle(result: OracleResult | null): void;
  /** Update the probe line (invisible-wall count + timing), or null to hide. */
  setProbe(result: ProbeResult | null): void;
  /** Report a probe run that failed. */
  setProbeError(message: string): void;
  /** Show the inspector for a picked anomaly, or null to clear it. */
  setInspector(info: InspectorInfo | null): void;
  /** Show/hide the textured-view toggle (once a level model is parsed). */
  setTexturedAvailable(available: boolean): void;
  /** Show/hide the skybox toggle (once a sky panorama is parsed). */
  setSkyboxAvailable(available: boolean): void;
  /** Show/hide the fog toggle (once the level's fog is parsed). */
  setFogAvailable(available: boolean): void;
  /** Show/hide the "probing…" banner while probe runs are in flight (or the
   * probe is waiting on something — pass the reason as `text`). */
  setProbeBusy(busy: boolean, text?: string): void;
  /** Which collision engine the ROM was identified as, and on what evidence. */
  setProfile(info: ProfileInfo): void;
  /** Enable the ground-truth capture panel (needs a live pool + position). */
  setCaptureReady(ready: boolean): void;
  /** Show/hide the "Jump to Mario" button (needs a live position). */
  setMarioAvailable(available: boolean): void;
  /** Replace a kind's jump list. An empty list hides its row altogether. */
  setJumpList(kind: JumpListKind, items: JumpItem[]): void;
}

export function createHud(
  container: HTMLElement,
  viewer: Viewer,
  callbacks: HudCallbacks,
): Hud {
  const hud = document.createElement("div");
  hud.className = "hud";

  const title = document.createElement("h1");
  title.textContent = "Invisible Wall Viewer";
  // Version in the UI so a bug report says which build it came from. The
  // version only moves at a release while the exe is rebuilt far more often,
  // so the commit it was built from goes next to it (see vite.config.ts).
  const version = document.createElement("span");
  version.className = "version";
  version.textContent = `v${APP_VERSION} · ${__BUILD_ID__}`;
  version.title =
    __BUILD_ID__ === "dev"
      ? "Running from source (start.cmd): always the current code"
      : `Built ${new Date(__BUILD_TIME__).toLocaleString()} from commit ` +
        `${__BUILD_ID__.replace(/\+$/, " plus uncommitted changes")}`;
  title.appendChild(version);
  hud.appendChild(title);

  const connectBtn = document.createElement("button");
  connectBtn.textContent = "Connect to Project64";
  connectBtn.addEventListener("click", () => callbacks.onConnect());
  hud.appendChild(connectBtn);

  const status = document.createElement("div");
  status.className = "status";
  status.textContent = "Offline — showing demo scene";
  hud.appendChild(status);

  // Probe-in-flight banner: the wall overlay may redraw (or shift, when the
  // world scale is detected mid-run) until the last queued probe lands — this
  // tells the user not to trust half-baked walls yet.
  const probing = document.createElement("div");
  probing.className = "probing";
  probing.textContent = "Probing invisible walls…";
  probing.style.display = "none";
  hud.appendChild(probing);

  const context = document.createElement("div");
  context.className = "context";
  hud.appendChild(context);

  // Camera → Mario. The level can be enormous and the badge is small; this is
  // the quick way back to where the player actually is. (Also the M key.)
  const marioBtn = document.createElement("button");
  marioBtn.className = "jump-mario";
  marioBtn.textContent = "Jump to Mario";
  marioBtn.title = "Move the camera to Mario (M)";
  marioBtn.style.display = "none";
  marioBtn.addEventListener("click", () => {
    callbacks.onJumpToMario?.();
    marioBtn.blur(); // or Space (fly up) would press it again
  });
  hud.appendChild(marioBtn);

  // Which collision engine the ROM runs — a ROM-level collision patch changes
  // real query behavior, so this drives the whole core and is worth surfacing.
  const profileLine = document.createElement("div");
  profileLine.className = "context";
  profileLine.style.display = "none";
  hud.appendChild(profileLine);

  // "core vs game" oracle panel: headline verdict + one line per query.
  const oracle = document.createElement("div");
  oracle.className = "oracle";
  const oracleHead = document.createElement("div");
  oracleHead.className = "oracle-head";
  const floorLine = document.createElement("div");
  const ceilLine = document.createElement("div");
  const wallLine = document.createElement("div");
  floorLine.className = ceilLine.className = wallLine.className = "oracle-line";
  oracle.append(oracleHead, floorLine, ceilLine, wallLine);
  oracle.style.display = "none";
  hud.appendChild(oracle);

  const countEls: Record<SurfaceKind, HTMLSpanElement> = {} as Record<
    SurfaceKind,
    HTMLSpanElement
  >;
  for (const kind of ORDER) {
    const label = document.createElement("label");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.addEventListener("change", () =>
      viewer.setKindVisible(kind, checkbox.checked),
    );

    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background =
      "#" + KIND_COLOR[kind].toString(16).padStart(6, "0");

    const name = document.createElement("span");
    name.textContent = KIND_LABEL[kind];

    const count = document.createElement("span");
    count.className = "count";
    count.textContent = "0";
    countEls[kind] = count;

    label.append(checkbox, swatch, name, count);
    hud.appendChild(label);
  }

  // Textured-view toggle: swaps the collision mesh for the level's real
  // (textured) geometry. Hidden until a model has been parsed from RDRAM.
  // On by default — the viewer switches over as soon as a model parses.
  const texturedLabel = document.createElement("label");
  const texturedCheckbox = document.createElement("input");
  texturedCheckbox.type = "checkbox";
  texturedCheckbox.checked = true;
  texturedCheckbox.addEventListener("change", () =>
    viewer.setTexturedVisible(texturedCheckbox.checked),
  );
  const texturedName = document.createElement("span");
  texturedName.textContent = "Textured level";
  texturedLabel.append(texturedCheckbox, texturedName);
  texturedLabel.style.display = "none";
  hud.appendChild(texturedLabel);

  // Skybox toggle: the game's sky panorama as the scene background. Hidden
  // until one is parsed from RDRAM.
  const skyboxLabel = document.createElement("label");
  const skyboxCheckbox = document.createElement("input");
  skyboxCheckbox.type = "checkbox";
  skyboxCheckbox.checked = true;
  skyboxCheckbox.addEventListener("change", () =>
    viewer.setSkyboxVisible(skyboxCheckbox.checked),
  );
  const skyboxName = document.createElement("span");
  skyboxName.textContent = "Skybox";
  skyboxLabel.append(skyboxCheckbox, skyboxName);
  skyboxLabel.style.display = "none";
  hud.appendChild(skyboxLabel);

  // Fog toggle: the game's own fog (color + range parsed from the display
  // lists). Off by default; hidden until the level actually uses fog.
  const fogLabel = document.createElement("label");
  const fogCheckbox = document.createElement("input");
  fogCheckbox.type = "checkbox";
  fogCheckbox.checked = false;
  fogCheckbox.addEventListener("change", () =>
    viewer.setFogEnabled(fogCheckbox.checked),
  );
  const fogName = document.createElement("span");
  fogName.textContent = "Fog";
  fogLabel.append(fogCheckbox, fogName);
  fogLabel.style.display = "none";
  hud.appendChild(fogLabel);

  // Grid/axes helper toggle (always available — pure viewer furniture).
  // Off by default to keep the scene clean.
  const helpersLabel = document.createElement("label");
  const helpersCheckbox = document.createElement("input");
  helpersCheckbox.type = "checkbox";
  helpersCheckbox.checked = false;
  helpersCheckbox.addEventListener("change", () =>
    viewer.setHelpersVisible(helpersCheckbox.checked),
  );
  const helpersName = document.createElement("span");
  helpersName.textContent = "Grid & axes";
  helpersLabel.append(helpersCheckbox, helpersName);
  hud.appendChild(helpersLabel);

  // Probe results: a master "Invisible walls" toggle, a per-kind toggle+count
  // beneath it, the probe timing line, and a click-to-inspect panel.
  const probeLabel = document.createElement("label");
  const probeCheckbox = document.createElement("input");
  probeCheckbox.type = "checkbox";
  probeCheckbox.checked = true;
  probeCheckbox.addEventListener("change", () =>
    viewer.setAnomaliesVisible(probeCheckbox.checked),
  );
  const probeSwatch = document.createElement("span");
  probeSwatch.className = "swatch";
  probeSwatch.style.background = swatchHex(ANOMALY_COLOR);
  const probeName = document.createElement("span");
  probeName.textContent = "Invisible walls";
  const probeCount = document.createElement("span");
  probeCount.className = "count";
  probeCount.textContent = "–";
  probeLabel.append(probeCheckbox, probeSwatch, probeName, probeCount);
  probeLabel.style.display = "none";
  hud.appendChild(probeLabel);

  // Per-kind sub-toggles with live counts.
  const kindCountEls = {} as Record<InvisibleWallKind, HTMLSpanElement>;
  const kindLabels = {} as Record<InvisibleWallKind, HTMLLabelElement>;
  for (const kind of ANOMALY_KINDS) {
    const label = document.createElement("label");
    label.className = "sub";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.addEventListener("change", () =>
      viewer.setAnomalyKindVisible(kind, checkbox.checked),
    );
    // Color picker doubling as the legend swatch: recolors this kind's overlay
    // live. It's interactive content inside the <label>, so clicking it drives
    // the picker only and never toggles the visibility checkbox.
    const swatch = document.createElement("input");
    swatch.type = "color";
    swatch.className = "swatch";
    swatch.value = swatchHex(ANOMALY_KIND_COLOR[kind]);
    swatch.title = "Overlay color";
    swatch.addEventListener("input", () =>
      viewer.setAnomalyKindColor(kind, parseInt(swatch.value.slice(1), 16)),
    );
    const name = document.createElement("span");
    name.textContent = ANOMALY_KIND_LABEL[kind];
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = "0";
    kindCountEls[kind] = count;
    label.append(checkbox, swatch, name, count);
    label.style.display = "none";
    kindLabels[kind] = label;
    hud.appendChild(label);
  }

  const probeLine = document.createElement("div");
  probeLine.className = "hint";
  probeLine.style.display = "none";
  hud.appendChild(probeLine);

  // Inspector: populated when the user clicks an anomaly quad.
  const inspector = document.createElement("div");
  inspector.className = "inspector";
  inspector.style.display = "none";
  const inspTitle = document.createElement("div");
  inspTitle.className = "insp-title";
  const inspBody = document.createElement("div");
  inspBody.className = "insp-body";
  inspector.append(inspTitle, inspBody);
  hud.appendChild(inspector);

  // Stars and red coins: a toggle for the badges in the scene and, under it,
  // a list of them — click one and the camera goes there. Hidden until the
  // level has any. The list follows the toggle: off means out of the way.
  const jumpRows = {} as Record<
    JumpListKind,
    { row: HTMLLabelElement; count: HTMLSpanElement; list: HTMLDivElement; box: HTMLInputElement }
  >;
  for (const kind of MARKER_KINDS) {
    const row = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = true;
    const swatch = document.createElement("span");
    swatch.className = `swatch marker-${kind}`;
    const name = document.createElement("span");
    name.textContent = MARKER_LABEL[kind];
    const count = document.createElement("span");
    count.className = "count";
    row.append(box, swatch, name, count);
    row.style.display = "none";
    const list = document.createElement("div");
    list.className = "jump-list";
    list.style.display = "none";
    box.addEventListener("change", () => {
      viewer.setMarkersVisible(kind, box.checked);
      if (kind === "star") viewer.setMarkersVisible("starAbsent", box.checked);
      list.style.display = box.checked && list.childElementCount > 0 ? "" : "none";
    });
    hud.append(row, list);
    jumpRows[kind] = { row, count, list, box };
  }

  // Ground-truth capture (corpus labelling). Only built when a capture handler
  // is supplied (main.ts always supplies one, in the exe too). Saves what the
  // user knows about the spot Mario is standing on, with the surface pool that
  // produced it, so the claim can be replayed offline forever.
  const capture = document.createElement("div");
  capture.className = "capture";
  capture.style.display = "none";
  let captureReady = false;
  const captureNote = document.createElement("input");
  const captureWall = document.createElement("button");
  const captureClear = document.createElement("button");
  const captureStatus = document.createElement("div");
  if (callbacks.onCaptureLabel) {
    const capTitle = document.createElement("div");
    capTitle.className = "insp-title";
    capTitle.textContent = "Ground truth";
    captureNote.type = "text";
    captureNote.placeholder = "what happens here (required)";
    captureNote.className = "capture-note";
    captureWall.textContent = "Wall here";
    captureClear.textContent = "Clear here";
    captureStatus.className = "hint";
    const row = document.createElement("div");
    row.className = "capture-row";
    row.append(captureWall, captureClear);
    capture.append(capTitle, captureNote, row, captureStatus);
    hud.appendChild(capture);

    const save = (label: "wall" | "clear") => {
      const note = captureNote.value.trim();
      if (!note) {
        captureStatus.textContent = "add a note first — it's the evidence";
        captureNote.focus();
        return;
      }
      captureStatus.textContent = "saving…";
      callbacks
        .onCaptureLabel?.(label, note)
        .then((msg) => {
          captureStatus.textContent = msg;
          captureNote.value = "";
        })
        .catch((err: unknown) => {
          captureStatus.textContent = `failed: ${(err as Error).message}`;
        });
    };
    captureWall.addEventListener("click", () => save("wall"));
    captureClear.addEventListener("click", () => save("clear"));
    // Typing a note must not fly the camera through the level. Only the
    // PRESS is kept from the viewer: it has to see every release, or a key
    // held while clicking into this field stays down forever.
    captureNote.addEventListener("keydown", (e) => e.stopPropagation());
  }

  // Fly-speed slider: log₂ scale so slow (⅛×) and fast (8×) get equal travel.
  const speedLabel = document.createElement("label");
  speedLabel.className = "speed";
  const speedName = document.createElement("span");
  speedName.textContent = "Fly speed";
  const speedSlider = document.createElement("input");
  speedSlider.type = "range";
  speedSlider.min = "-3";
  speedSlider.max = "3";
  speedSlider.step = "0.05";
  speedSlider.value = "0";
  const speedValue = document.createElement("span");
  speedValue.className = "count";
  const applySpeed = () => {
    const mult = Math.pow(2, Number(speedSlider.value));
    viewer.setFlySpeedScale(mult);
    speedValue.textContent =
      (mult >= 1 ? mult.toFixed(1) : mult.toFixed(2)) + "×";
  };
  speedSlider.addEventListener("input", applySpeed);
  // Drop focus after a drag so Space flies up instead of poking the slider.
  speedSlider.addEventListener("pointerup", () => speedSlider.blur());
  applySpeed();
  speedLabel.append(speedName, speedSlider, speedValue);
  hud.appendChild(speedLabel);

  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent =
    "WASD fly · Space/C up/down · Shift fast · drag to look\nM jump to Mario";
  hint.style.whiteSpace = "pre-line";
  hud.appendChild(hint);

  container.appendChild(hud);

  return {
    setStatus(text, connected, active = connected) {
      status.textContent = text;
      status.className = "status" + (connected ? " connected" : "");
      connectBtn.textContent = active ? "Disconnect" : "Connect to Project64";
      connectBtn.classList.toggle("secondary", active);
    },
    setCounts(counts) {
      for (const kind of ORDER) countEls[kind].textContent = String(counts[kind]);
    },
    setContext(level, area, pos, scale, scaleVerified) {
      // An unmeasured scale is shown even at 1×: a scale carried over from
      // another level is exactly the silent 4× error this line exists to expose.
      const sc =
        scale === undefined
          ? ""
          : scaleVerified === false
            ? ` · scale ${scale}× (not yet measured here)`
            : scale === 1
              ? ""
              : ` · scale ${scale}×`;
      context.textContent =
        `level ${level} · area ${area}${sc}\n` +
        `mario (${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}, ${pos.z.toFixed(0)})`;
    },
    setOracle(result) {
      if (!result) {
        oracle.style.display = "none";
        return;
      }
      oracle.style.display = "block";
      oracle.className = "oracle " + (result.ok ? "ok" : "bad");
      oracleHead.textContent = `core vs game  ${mark(result.ok)}`;

      const f = result.floor;
      floorLine.textContent =
        `floor ${mark(f.ok)}  ${hex(f.ourAddr)} ↔ ${hex(f.gameAddr)}` +
        (f.coplanar ? "  coplanar" : "");
      floorLine.title = `our height ${f.ourHeight.toFixed(1)} · game ${f.gameHeight.toFixed(1)}`;

      const c = result.ceil;
      ceilLine.textContent =
        `ceil  ${mark(c.ok)}  ${hex(c.ourAddr)} ↔ ${hex(c.gameAddr)}` +
        (c.coplanar ? "  coplanar" : "");
      ceilLine.title = `our height ${c.ourHeight.toFixed(1)} · game ${c.gameHeight.toFixed(1)}`;

      const w = result.wall;
      wallLine.textContent = `wall  ${mark(w.ok)}  game ${hex(w.gameAddr)}${wallNote(w)}`;
      wallLine.title = `we detected ${w.ourAddrs.length} wall(s) at Mario's position`;
    },
    setProbe(result) {
      if (!result) {
        probeLabel.style.display = "none";
        probeLine.style.display = "none";
        for (const k of ANOMALY_KINDS) kindLabels[k].style.display = "none";
        inspector.style.display = "none";
        return;
      }
      probeLabel.style.display = "";
      probeLine.style.display = "";
      probeCount.textContent = String(result.segments.length);
      const counts = {
        "exposed-ceiling": 0,
        "out-of-bounds": 0,
      } as Record<InvisibleWallKind, number>;
      for (const s of result.segments) counts[s.kind]++;
      // Only surface a kind's toggle when it actually found something, so the
      // legend stays tight.
      for (const k of ANOMALY_KINDS) {
        kindCountEls[k].textContent = String(counts[k]);
        kindLabels[k].style.display = counts[k] > 0 ? "" : "none";
      }
      const ms = result.elapsedMs;
      probeLine.textContent =
        `probe: ${ms >= 10000 ? (ms / 1000).toFixed(1) + "s" : ms.toFixed(0) + "ms"}`;
      probeLine.classList.remove("error");
      probeLine.title =
        `${result.ceilingsProbed} ceilings + ${result.floorsProbed} floors marched, ` +
        `${result.samplesProbed} samples` +
        (result.workers ? `, across ${result.workers} worker${result.workers === 1 ? "" : "s"}` : "");
    },
    setProbeError(message) {
      probeLine.style.display = "";
      probeLine.classList.add("error");
      probeLine.textContent = `probe failed: ${message}`;
      probeLine.title = "";
    },
    setInspector(info) {
      if (!info) {
        inspector.style.display = "none";
        return;
      }
      inspector.style.display = "block";
      inspector.style.borderLeftColor = swatchHex(ANOMALY_KIND_COLOR[info.kind]);
      inspTitle.textContent = ANOMALY_KIND_LABEL[info.kind];
      const lines: string[] = [];
      const c = info.cells;
      if (c) {
        // The clicked box's own numbers: every cell in it has this interval.
        lines.push(
          c.count === 1
            ? `column at (${c.x.toFixed(0)}, ${c.z.toFixed(0)})`
            : `${c.count} columns around (${c.x.toFixed(0)}, ${c.z.toFixed(0)})`,
        );
        lines.push(`blocked y ${c.yLow.toFixed(0)} → ${c.yHigh.toFixed(0)}`);
      }
      if (info.blockerAddr) {
        lines.push(`blocked by ${info.blockerKind ?? "surface"} ${hex(info.blockerAddr)}`);
      } else {
        lines.push("no blocking surface (missing floor)");
      }
      lines.push(`stepping from floor y ${info.standY.toFixed(0)}`);
      lines.push(`edge ${info.sourceKind ?? "surface"} ${hex(info.sourceAddr)}`);
      lines.push(
        `run: ${info.samples} sample${info.samples === 1 ? "" : "s"}, ` +
          `y ${info.runLow.toFixed(0)} → ${info.runHigh.toFixed(0)} overall`,
      );
      inspBody.textContent = lines.join("\n");
    },
    setTexturedAvailable(available) {
      texturedLabel.style.display = available ? "" : "none";
    },
    setSkyboxAvailable(available) {
      skyboxLabel.style.display = available ? "" : "none";
    },
    setFogAvailable(available) {
      fogLabel.style.display = available ? "" : "none";
    },
    setProbeBusy(busy, text) {
      probing.style.display = busy ? "" : "none";
      probing.textContent = text ?? "Probing invisible walls…";
    },
    setProfile(info) {
      if (!info.known) {
        profileLine.style.display = "none";
        return;
      }
      const p = info.profile;
      const patched = p.wallThreshold === 0.05 || p.walls === "frame";
      const via = (s: string | null) =>
        s === "code" ? "read from the ROM's code"
          : s === "partition" ? "inferred from the level's partition"
            : s === "observed" ? "observed under Mario"
              // Inferred from the wall threshold — which, on an unpatched
              // ROM, is not "the patch" (the line used to say so regardless).
              : s === "threshold"
                ? patched ? "assumed from the patch" : "assumed: unpatched ROM"
                : "default";
      profileLine.style.display = "";
      profileLine.textContent =
        (patched ? "Frame's patch detected" : "collision: vanilla (unpatched)") +
        `\nfloor pick: ${p.select === "extreme" ? "highest" : "first in list"}` +
        ` (${via(info.selectSource)})`;
      profileLine.title =
        `wall threshold ±${p.wallThreshold} (${via(info.thresholdSource)})\n` +
        `wall routine: ${p.walls === "frame" ? "one-sided (Frame)" : "vanilla"}` +
        ` (${via(info.wallsSource)})`;
    },
    setMarioAvailable(available) {
      marioBtn.style.display = available ? "" : "none";
    },
    setJumpList(kind, items) {
      const { row, count, list, box } = jumpRows[kind];
      row.style.display = items.length > 0 ? "" : "none";
      count.textContent = String(items.length);
      list.replaceChildren(
        ...items.map((item) => {
          const b = document.createElement("button");
          const label = document.createElement("span");
          label.textContent = item.label;
          b.appendChild(label);
          if (item.note) {
            const note = document.createElement("span");
            note.className = "note";
            note.textContent = item.note;
            b.appendChild(note);
          }
          if (item.title) b.title = item.title;
          if (item.dim) b.classList.add("dim");
          const pos = item.pos;
          if (!pos) b.disabled = true;
          else {
            b.addEventListener("click", () => {
              callbacks.onJump?.(pos);
              b.blur(); // or Space (fly up) would press it again
            });
          }
          return b;
        }),
      );
      list.style.display = box.checked && items.length > 0 ? "" : "none";
    },
    setCaptureReady(ready) {
      if (!callbacks.onCaptureLabel || ready === captureReady) return;
      captureReady = ready;
      capture.style.display = ready ? "" : "none";
      captureWall.disabled = !ready;
      captureClear.disabled = !ready;
    },
  };
}

/** Suffix explaining the wall verdict: none / exact match / coplanar sibling /
 * stale (Mario standing still, so the game's pointer is left over) / not found. */
function wallNote(w: {
  gameAddr: number;
  ourAddrs: number[];
  stale: boolean;
  coplanar: boolean;
}): string {
  if (w.gameAddr === 0) return ""; // hex() already prints "none"
  if (w.ourAddrs.includes(w.gameAddr)) return `  ∈ ${w.ourAddrs.length} ours`;
  if (w.coplanar) return "  coplanar ∈ ours";
  if (w.stale) return "  stale (standing)";
  return `  ∉ ${w.ourAddrs.length} ours`;
}
