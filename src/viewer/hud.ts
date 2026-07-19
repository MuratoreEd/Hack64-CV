// DOM overlay: connect button, connection status, live level/area/Mario info,
// the "core vs game" oracle panel, and per-kind visibility toggles with counts.

import type { Viewer } from "./viewer";
import { SurfaceKind } from "../collision/surface";
import {
  KIND_COLOR,
  ANOMALY_COLOR,
  ANOMALY_KIND_COLOR,
  ANOMALY_KIND_LABEL,
  ANOMALY_KINDS,
} from "./palette";
import type { OracleResult } from "../collision/oracle";
import type { ProbeResult, InvisibleWallKind } from "../probe/invisibleWalls";

const swatchHex = (c: number): string => "#" + c.toString(16).padStart(6, "0");

/** A picked anomaly, resolved to the surfaces behind it (built in main.ts,
 * which alone knows the surface pool and world scale). */
export interface InspectorInfo {
  kind: InvisibleWallKind;
  /** World-space center of the segment (collision coords × scale). */
  worldCenter: { x: number; y: number; z: number };
  /** World-space vertical extent of the blocked region. */
  regionLow: number;
  regionHigh: number;
  samples: number;
  blockerAddr: number;
  blockerKind: string | null;
  sourceAddr: number;
  sourceKind: string | null;
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

export interface HudCallbacks {
  onConnect(): void;
}

export interface Hud {
  setStatus(text: string, connected: boolean): void;
  setCounts(counts: Record<SurfaceKind, number>): void;
  setContext(
    level: number,
    area: number,
    pos: { x: number; y: number; z: number },
    scale?: number,
  ): void;
  /** Update the "core vs game" panel, or pass null to hide it. */
  setOracle(result: OracleResult | null): void;
  /** Update the probe line (invisible-wall count + timing), or null to hide. */
  setProbe(result: ProbeResult | null): void;
  /** Show the inspector for a picked anomaly, or null to clear it. */
  setInspector(info: InspectorInfo | null): void;
  /** Show/hide the textured-view toggle (once a level model is parsed). */
  setTexturedAvailable(available: boolean): void;
  /** Show/hide the skybox toggle (once a sky panorama is parsed). */
  setSkyboxAvailable(available: boolean): void;
  /** Show/hide the fog toggle (once the level's fog is parsed). */
  setFogAvailable(available: boolean): void;
  /** Show/hide the "probing…" banner while probe runs are in flight. */
  setProbeBusy(busy: boolean): void;
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
  hint.textContent = "WASD fly · Space/C up/down · Shift fast · drag to look";
  hud.appendChild(hint);

  container.appendChild(hud);

  return {
    setStatus(text, connected) {
      status.textContent = text;
      status.className = "status" + (connected ? " connected" : "");
    },
    setCounts(counts) {
      for (const kind of ORDER) countEls[kind].textContent = String(counts[kind]);
    },
    setContext(level, area, pos, scale) {
      const sc = scale === undefined || scale === 1 ? "" : ` · scale ${scale}×`;
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
      probeLine.textContent = `probe: ${result.elapsedMs.toFixed(0)}ms`;
      probeLine.title =
        `${result.ceilingsProbed} ceilings + ${result.floorsProbed} floors marched, ` +
        `${result.samplesProbed} samples`;
    },
    setInspector(info) {
      if (!info) {
        inspector.style.display = "none";
        return;
      }
      inspector.style.display = "block";
      inspector.style.borderLeftColor = swatchHex(ANOMALY_KIND_COLOR[info.kind]);
      inspTitle.textContent = ANOMALY_KIND_LABEL[info.kind];
      const c = info.worldCenter;
      const lines = [`at (${c.x.toFixed(0)}, ${c.y.toFixed(0)}, ${c.z.toFixed(0)})`];
      lines.push(
        `spans y ${info.regionLow.toFixed(0)} → ${info.regionHigh.toFixed(0)}`,
      );
      if (info.blockerAddr) {
        lines.push(`blocked by ${info.blockerKind ?? "surface"} ${hex(info.blockerAddr)}`);
      } else {
        lines.push("no blocking surface (missing floor)");
      }
      lines.push(`edge ${info.sourceKind ?? "surface"} ${hex(info.sourceAddr)}`);
      lines.push(`${info.samples} sample${info.samples === 1 ? "" : "s"} merged`);
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
    setProbeBusy(busy) {
      probing.style.display = busy ? "" : "none";
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
