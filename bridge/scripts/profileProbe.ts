// Profile findInvisibleWalls on the LIVE surface pool: where does the time go?
// Wraps every SpatialPartition query with call counters + accumulated time,
// times the merge pass separately, and reports the breakdown.
//   npx tsx scripts/profileProbe.ts [worldScale]

import { ProcessMemory, findProject64Pid } from "../src/win32.js";
import { discoverRdram, readSurfacePool } from "../src/rdram.js";
import { parseSurfacePool } from "../../src/collision/surface.js";
import { SpatialPartition } from "../../src/collision/partition.js";
import {
  findInvisibleWalls,
  mergeSegments,
} from "../../src/probe/invisibleWalls.js";

function main(): void {
  const worldScale = Number(process.argv[2] ?? 4);
  const pid = findProject64Pid();
  if (pid == null) throw new Error("Project64 not running");
  const proc = new ProcessMemory(pid);
  const rd = discoverRdram(proc);
  if (!rd) throw new Error("RDRAM not found");
  const pool = readSurfacePool(rd);
  proc.close();

  const surfaces = parseSurfacePool(
    pool.bytes.buffer.slice(
      pool.bytes.byteOffset,
      pool.bytes.byteOffset + pool.bytes.byteLength,
    ),
    pool.count,
    { baseAddress: pool.poolBase },
  );
  console.log(`pool: ${surfaces.length} surfaces, scale ${worldScale}x\n`);

  // --- Instrument the partition queries ---
  const stats = new Map<string, { calls: number; ns: bigint }>();
  const proto = SpatialPartition.prototype as unknown as Record<
    string,
    (...a: unknown[]) => unknown
  >;
  const originals: Record<string, (...a: unknown[]) => unknown> = {};
  for (const name of ["findFloor", "findCeil", "findWallCollisions", "floorsAt"]) {
    originals[name] = proto[name];
    stats.set(name, { calls: 0, ns: 0n });
    proto[name] = function (...args: unknown[]) {
      const s = stats.get(name)!;
      s.calls++;
      const t0 = process.hrtime.bigint();
      const r = originals[name].apply(this, args);
      s.ns += process.hrtime.bigint() - t0;
      return r;
    };
  }

  const opts = {
    marioHeight: 160 / worldScale,
    ledgeGrace: 100 / worldScale,
    wallOffset: 60 / worldScale,
    wallRadius: 50 / worldScale,
    merge: false as const,
  };

  const t0 = process.hrtime.bigint();
  const raw = findInvisibleWalls(surfaces, opts);
  const probeMs = Number(process.hrtime.bigint() - t0) / 1e6;

  for (const name of Object.keys(originals)) proto[name] = originals[name];

  const t1 = process.hrtime.bigint();
  const merged = mergeSegments(raw.segments);
  const mergeMs = Number(process.hrtime.bigint() - t1) / 1e6;

  console.log(`march+verdicts (merge off, instrumented): ${probeMs.toFixed(0)}ms`);
  console.log(`  ceilings ${raw.ceilingsProbed}, floors ${raw.floorsProbed}, samples ${raw.samplesProbed}`);
  console.log(`  raw segments ${raw.segments.length} -> merged ${merged.length} in ${mergeMs.toFixed(0)}ms\n`);

  console.log("per-query breakdown (incl. wrapper overhead):");
  let attributed = 0;
  for (const [name, s] of stats) {
    const ms = Number(s.ns) / 1e6;
    attributed += ms;
    console.log(
      `  ${name.padEnd(20)} ${String(s.calls).padStart(9)} calls  ` +
        `${ms.toFixed(0).padStart(7)}ms  ${((ms / probeMs) * 100).toFixed(0).padStart(3)}%`,
    );
  }
  console.log(`  ${"(unattributed)".padEnd(20)} ${" ".repeat(9)}        ${(probeMs - attributed).toFixed(0).padStart(7)}ms`);

  // --- Clean re-run without instrumentation for a true baseline ---
  const t2 = process.hrtime.bigint();
  const clean = findInvisibleWalls(surfaces, opts);
  const cleanMs = Number(process.hrtime.bigint() - t2) / 1e6;
  console.log(`\nclean run (merge off): ${cleanMs.toFixed(0)}ms, segments ${clean.segments.length}`);
}

main();
