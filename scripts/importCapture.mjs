// Files a downloaded ground-truth capture into the corpus.
//
//   npm run corpus:import                 # scan the Downloads folder
//   npm run corpus:import -- file.json    # or name files / folders
//
// A capture carries its whole surface pool, so twenty labels from one level
// would otherwise be twenty copies of the same 600 kB. Pools are split out and
// deduplicated by the hash of their DECOMPRESSED bytes (the pool's real
// identity — gzip output can differ between the browser and Node), then
// re-compressed here so a pool file is byte-stable no matter who imported it.
//
// Re-running is safe: an already-imported label is recognised and skipped.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = 1;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const poolsDir = path.join(root, "corpus", "pools");
const labelsDir = path.join(root, "corpus", "labels");

const inputs = process.argv.slice(2);
const sources = inputs.length > 0 ? inputs : [path.join(os.homedir(), "Downloads")];

/** Every .json file named by the arguments (directories scanned one level). */
function candidates() {
  const out = [];
  for (const src of sources) {
    const p = path.resolve(src);
    if (!fs.existsSync(p)) {
      console.warn(`! not found: ${p}`);
      continue;
    }
    if (fs.statSync(p).isDirectory()) {
      for (const f of fs.readdirSync(p)) {
        if (f.toLowerCase().endsWith(".json")) out.push(path.join(p, f));
      }
    } else {
      out.push(p);
    }
  }
  return out;
}

/** Parse a file as a capture, or return null if it plainly isn't one. */
function readCapture(file) {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  if (!json.pool || !json.label || json.marioWorldPos === undefined) return null;
  if (json.schemaVersion !== SCHEMA_VERSION) {
    console.warn(
      `! ${path.basename(file)}: schema version ${json.schemaVersion}, this script writes ${SCHEMA_VERSION} — skipped`,
    );
    return null;
  }
  if (!json.note || !String(json.note).trim()) {
    console.warn(`! ${path.basename(file)}: no note — skipped (a label without evidence isn't ground truth)`);
    return null;
  }
  return json;
}

function poolBytes(pool) {
  const raw = Buffer.from(pool.data, "base64");
  return pool.encoding === "gzip+base64" ? gunzipSync(raw) : raw;
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function writeIfNew(file, value) {
  if (fs.existsSync(file)) {
    const existing = JSON.parse(fs.readFileSync(file, "utf8"));
    return sameJson(existing, value) ? "same" : "conflict";
  }
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
  return "written";
}

fs.mkdirSync(poolsDir, { recursive: true });
fs.mkdirSync(labelsDir, { recursive: true });

let imported = 0;
let skipped = 0;
let poolsWritten = 0;

for (const file of candidates()) {
  const cap = readCapture(file);
  if (!cap) continue;

  const bytes = poolBytes(cap.pool);
  const expected = cap.pool.count * 0x30;
  if (bytes.length !== expected) {
    console.warn(
      `! ${path.basename(file)}: pool is ${bytes.length} bytes, expected ${expected} for ${cap.pool.count} surfaces — skipped`,
    );
    continue;
  }
  if (!cap.profile?.known) {
    console.warn(
      `! ${path.basename(file)}: captured before the collision profile was identified — ` +
        `the corpus runner will reject it. Re-capture once the HUD shows the patch verdict.`,
    );
  }
  if (cap.worldScaleVerified === false) {
    console.warn(
      `! ${path.basename(file)}: captured while the world scale was carried over from ` +
        `another level — the corpus runner will reject it. Re-capture once the HUD ` +
        `stops saying "not yet measured here".`,
    );
  }

  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  const poolFile = `L${cap.level}-A${cap.area}-${hash}.json`;
  const poolRecord = {
    schemaVersion: SCHEMA_VERSION,
    level: cap.level,
    area: cap.area,
    capturedAt: cap.capturedAt,
    worldScale: cap.worldScale,
    profile: cap.profile,
    pool: {
      count: cap.pool.count,
      poolBase: cap.pool.poolBase,
      encoding: "gzip+base64",
      data: gzipSync(bytes, { level: 9 }).toString("base64"),
    },
  };
  const poolPath = path.join(poolsDir, poolFile);
  if (!fs.existsSync(poolPath)) {
    fs.writeFileSync(poolPath, JSON.stringify(poolRecord, null, 2) + "\n");
    poolsWritten++;
    console.log(`+ pool  ${poolFile}  (${cap.pool.count} surfaces, scale ${cap.worldScale}x)`);
  }

  const { pool: _pool, ...rest } = cap;
  const label = { ...rest, poolFile };
  const stamp = String(cap.capturedAt).replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const base = `L${cap.level}-A${cap.area}-${cap.label}-${stamp}`;
  let labelPath = path.join(labelsDir, `${base}.json`);
  let outcome = writeIfNew(labelPath, label);
  for (let n = 2; outcome === "conflict" && n < 100; n++) {
    labelPath = path.join(labelsDir, `${base}-${n}.json`);
    outcome = writeIfNew(labelPath, label);
  }

  if (outcome === "written") {
    imported++;
    console.log(`+ label ${path.basename(labelPath)}  ${cap.label}: ${cap.note}`);
  } else {
    skipped++;
    console.log(`= label ${path.basename(labelPath)} already imported`);
  }
}

console.log(
  `\n${imported} label(s) imported, ${skipped} already present, ${poolsWritten} new pool(s).`,
);
if (imported > 0) {
  console.log("Next: npm run corpus   (then commit corpus/ with the baselines)");
}
