// The corpus runner: replays every labelled spot through the real detector and
// checks the verdict against what the user said, plus a cell-level baseline per
// pool so any change in what the tool reports shows up as a reviewable diff.
//
//   npm run corpus            # run it
//   npm run corpus -- -u      # accept new cell baselines (justify in the commit)
//
// It is NOT part of `npm test`: a single dense pool takes ~35 s to probe. It is
// the gate for detector changes — run it before and after, and read the diff.
//
// Baseline discipline (P11's lesson, learned the hard way): compare at CELL
// level, never at segment keys. Segment keys reshape whenever merging changes,
// which looks like a detection change and isn't; the cells are the claim.

import { describe, it, expect, beforeAll } from "vitest";
import { parseSurfacePool } from "../src/collision/surface";
import { deriveBoundary } from "../src/collision/partition";
import { findInvisibleWalls } from "../src/probe/invisibleWalls";
import type { ProbeResult } from "../src/probe/invisibleWalls";
import { sessionProbeOptions } from "../src/probe/config";
import { decodePool, CORPUS_SCHEMA_VERSION } from "../src/corpus/schema";
import type { StoredLabel, StoredPool } from "../src/corpus/schema";
import { judgeLabel } from "../src/corpus/judge";
import { wallsForThreshold } from "../src/collision/profile";

type JsonModule<T> = { default: T };

/** Both trees are loaded the same way: `fixtures/` holds synthetic scenes that
 * keep the pipeline honest when the real corpus is small; the top level holds
 * spots labelled at a live emulator. */
const poolModules = {
  ...import.meta.glob<JsonModule<StoredPool>>("./pools/*.json", { eager: true }),
  ...import.meta.glob<JsonModule<StoredPool>>("./fixtures/pools/*.json", {
    eager: true,
  }),
};
const labelModules = {
  ...import.meta.glob<JsonModule<StoredLabel>>("./labels/*.json", { eager: true }),
  ...import.meta.glob<JsonModule<StoredLabel>>("./fixtures/labels/*.json", {
    eager: true,
  }),
};

const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const isFixture = (p: string): boolean => p.startsWith("./fixtures/");

interface PoolEntry {
  file: string;
  fixture: boolean;
  pool: StoredPool;
  labels: { file: string; label: StoredLabel }[];
}

const pools = new Map<string, PoolEntry>();
for (const [path, mod] of Object.entries(poolModules)) {
  pools.set(basename(path), {
    file: basename(path),
    fixture: isFixture(path),
    pool: mod.default,
    labels: [],
  });
}
const orphans: string[] = [];
for (const [path, mod] of Object.entries(labelModules)) {
  const entry = pools.get(mod.default.poolFile);
  if (!entry) {
    orphans.push(`${basename(path)} → ${mod.default.poolFile}`);
    continue;
  }
  entry.labels.push({ file: basename(path), label: mod.default });
}

describe("corpus integrity", () => {
  it("every label points at a pool that exists", () => {
    expect(orphans).toEqual([]);
  });

  it("every record uses a schema version this runner understands", () => {
    const bad = [
      ...Object.values(poolModules).map((m) => m.default.schemaVersion),
      ...Object.values(labelModules).map((m) => m.default.schemaVersion),
    ].filter((v) => v !== CORPUS_SCHEMA_VERSION);
    expect(bad).toEqual([]);
  });

  it("every label was taken with a known collision profile", () => {
    // A label captured before the patch verdict settled describes a probe run
    // under an unproven engine — it can't be ground truth for this ROM.
    const unknown = Object.entries(labelModules)
      .filter(([, m]) => !m.default.profile.known)
      .map(([p]) => basename(p));
    expect(unknown).toEqual([]);
  });

  it("every label was taken with a measured (not carried-over) world scale", () => {
    // A scale inherited from the previous level can be off by 4×, which moves
    // every blocked cell. Older captures don't record it (undefined): allowed.
    const inherited = Object.entries(labelModules)
      .filter(([, m]) => m.default.worldScaleVerified === false)
      .map(([p]) => basename(p));
    expect(inherited).toEqual([]);
  });

  it("has real (non-fixture) labels", () => {
    // Fails until the R1 labelling session happens. That is the point: the
    // corpus is the gate, and an empty corpus should not look green.
    const real = Object.keys(labelModules).filter((p) => !isFixture(p));
    expect(real.length, "no ground-truth labels captured yet — see corpus/README.md").toBeGreaterThan(0);
  });
});

/** One line per blocked cell: the tool's actual claim, order-independent and
 * sorted by position so a diff reads as a map, not as churn. */
function cellLines(result: ProbeResult): string {
  const cells = new Map<string, { x: number; z: number; line: string }>();
  for (const seg of result.segments) {
    for (const c of seg.columns) {
      const line =
        `${c.x},${c.z},${seg.kind},0x${(seg.blockerAddr >>> 0).toString(16)},` +
        `${c.yLow.toFixed(2)},${c.yHigh.toFixed(2)}`;
      cells.set(line, { x: c.x, z: c.z, line });
    }
  }
  return (
    [...cells.values()]
      .sort((a, b) => a.x - b.x || a.z - b.z || a.line.localeCompare(b.line))
      .map((c) => c.line)
      .join("\n") + "\n"
  );
}

for (const entry of [...pools.values()].sort((a, b) => a.file.localeCompare(b.file))) {
  const { pool } = entry;
  describe(`${entry.file} (level ${pool.level} area ${pool.area}, scale ${pool.worldScale}x, ${pool.profile.select})`, () => {
    let result: ProbeResult;

    beforeAll(async () => {
      const buffer = await decodePool(pool.pool);
      const surfaces = parseSurfacePool(buffer, pool.pool.count, {
        baseAddress: pool.pool.poolBase,
        wallThreshold: pool.profile.wallThreshold,
      });
      // Mirror the app exactly: the boundary is the one its partition derives,
      // and the probe options come from the shared session config.
      result = findInvisibleWalls(
        surfaces,
        sessionProbeOptions({
          worldScale: pool.worldScale,
          select: pool.profile.select,
          walls: pool.profile.walls ?? wallsForThreshold(pool.profile.wallThreshold),
          boundary: deriveBoundary(surfaces),
        }),
      );
    }, 600_000);

    it("blocked cells match the baseline", async () => {
      const dir = entry.fixture ? "./fixtures/baselines" : "./baselines";
      await expect(cellLines(result)).toMatchFileSnapshot(
        `${dir}/${entry.file.replace(/\.json$/, "")}.cells.txt`,
      );
    });

    for (const { file, label } of entry.labels.sort((a, b) =>
      a.file.localeCompare(b.file),
    )) {
      it(`${label.label}: ${file} — ${label.note.slice(0, 60)}`, () => {
        const judgement = judgeLabel(result.segments, label);
        expect(judgement.ok, `${file}\n  ${judgement.reason}`).toBe(true);
      });
    }
  });
}
