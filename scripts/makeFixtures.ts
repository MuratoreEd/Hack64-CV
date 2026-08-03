// Regenerates the corpus fixtures: synthetic captures that exercise the whole
// ground-truth pipeline (stored pool bytes → parse → probe → judge → cell
// baseline) before any real labels exist, and keep exercising it afterwards.
//
//   npx vite-node scripts/makeFixtures.ts
//
// The geometry is the probe suite's canonical leaked-ceiling scene: a 400x400
// floor with a ceiling covering x <= 0 at height 100. Mario (160 tall) doesn't
// fit under it, so the columns just past the ceiling's edge are blocked with no
// wall to explain the stop — an invisible wall by any definition — while the
// open floor to the east is plainly walkable.

import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { makeSurface } from "../src/collision/geometry";
import { encodeSurfacePool } from "../src/collision/surfaceEncode";
import { CORPUS_SCHEMA_VERSION } from "../src/corpus/schema";
import type { StoredLabel, StoredPool, CapturedProfile } from "../src/corpus/schema";
import { APP_VERSION } from "../src/version";

const dir = (rel: string): string =>
  fileURLToPath(new URL(`../corpus/fixtures/${rel}`, import.meta.url));

const CAPTURED_AT = "2026-08-02T00:00:00.000Z";
const PROFILE: CapturedProfile = {
  wallThreshold: 0.01,
  select: "first",
  known: true,
};

const surfaces = [
  // Floor: 400x400 at y=0.
  makeSurface([-200, 0, -200], [-200, 0, 200], [200, 0, 200])!,
  makeSurface([-200, 0, -200], [200, 0, 200], [200, 0, -200])!,
  // Ceiling at y=100 over x <= 0 (wound so normal.y < 0), uncapped at x = 0.
  makeSurface([-200, 100, -200], [0, 100, 200], [-200, 100, 200])!,
  makeSurface([-200, 100, -200], [0, 100, -200], [0, 100, 200])!,
].map((s, index) => ({ ...s, index }));

const bytes = new Uint8Array(encodeSurfacePool(surfaces));
const data = gzipSync(bytes).toString("base64");
const hash = createHash("sha256").update(data).digest("hex").slice(0, 8);
const poolFile = `L0-A0-${hash}.json`;

const pool: StoredPool = {
  schemaVersion: CORPUS_SCHEMA_VERSION,
  level: 0,
  area: 0,
  capturedAt: CAPTURED_AT,
  worldScale: 1,
  profile: PROFILE,
  pool: {
    count: surfaces.length,
    poolBase: 0x8038ee9c,
    encoding: "gzip+base64",
    data,
  },
};

const label = (
  name: string,
  verdict: "wall" | "clear",
  pos: { x: number; y: number; z: number },
  note: string,
): [string, StoredLabel] => [
  name,
  {
    schemaVersion: CORPUS_SCHEMA_VERSION,
    appVersion: APP_VERSION,
    capturedAt: CAPTURED_AT,
    level: 0,
    area: 0,
    worldScale: 1,
    profile: PROFILE,
    marioWorldPos: pos,
    label: verdict,
    note,
    poolFile,
  },
];

const labels = [
  label(
    "L0-A0-wall-ceiling-edge.json",
    "wall",
    { x: 30, y: 0, z: 0 },
    "synthetic: walking west into the uncapped edge of a 100-high ceiling; " +
      "Mario is 160 tall so the columns past x=0 are blocked with no wall there",
  ),
  label(
    "L0-A0-clear-open-floor.json",
    "clear",
    { x: 150, y: 0, z: 100 },
    "synthetic: open floor well east of the ceiling's footprint; nothing may " +
      "be reported here",
  ),
];

mkdirSync(dir("pools"), { recursive: true });
mkdirSync(dir("labels"), { recursive: true });
mkdirSync(dir("baselines"), { recursive: true });

const write = (path: string, value: unknown): void => {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
  console.log(`wrote ${path}`);
};

write(dir(`pools/${poolFile}`), pool);
for (const [name, rec] of labels) write(dir(`labels/${name}`), rec);
console.log(
  `${surfaces.length} surfaces, ${bytes.length} raw bytes, ${data.length} stored chars`,
);
