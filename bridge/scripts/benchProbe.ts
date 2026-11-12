// Clean single-run probe benchmark on the live pool (fresh process per mode,
// no instrumentation). Also asserts accel/plain output equivalence when both
// are run in one invocation.
//   npx tsx scripts/benchProbe.ts accel|plain|both [worldScale] [--patched]
//
// --patched probes with Frame's patch profile (±0.05 threshold, its wall
// routine, highest-floor selection) — what the app runs on such a ROM.

import { ProcessMemory, findProject64Pid } from "../src/win32.js";
import { discoverRdram, readSurfacePool } from "../src/rdram.js";
import { parseSurfacePool } from "../../src/collision/surface.js";
import { findInvisibleWalls } from "../../src/probe/invisibleWalls.js";
import { sessionProbeOptions } from "../../src/probe/config.js";
import { deriveBoundary } from "../../src/collision/partition.js";
import { PATCHED_PROFILE, VANILLA_PROFILE } from "../../src/collision/profile.js";

function main(): void {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const mode = args[0] ?? "accel";
  const worldScale = Number(args[1] ?? 4);
  const profile = process.argv.includes("--patched") ? PATCHED_PROFILE : VANILLA_PROFILE;
  const pid = findProject64Pid();
  if (pid == null) throw new Error("Project64 not running");
  const proc = new ProcessMemory(pid);
  const rd = discoverRdram(proc);
  if (!rd) throw new Error("RDRAM not found");
  const pool = readSurfacePool(rd);
  proc.close();
  if (!pool) throw new Error("no valid surface pool (enter a level first)");
  const surfaces = parseSurfacePool(
    pool.bytes.buffer.slice(
      pool.bytes.byteOffset,
      pool.bytes.byteOffset + pool.bytes.byteLength,
    ) as ArrayBuffer,
    pool.count,
    { baseAddress: pool.poolBase, wallThreshold: profile.wallThreshold },
  );

  // The app's own session configuration, so the benchmark measures what runs.
  const opts = sessionProbeOptions({
    worldScale,
    select: profile.select,
    walls: profile.walls,
    boundary: deriveBoundary(surfaces),
  });

  const run = (accel: boolean) => {
    const t0 = process.hrtime.bigint();
    const r = findInvisibleWalls(surfaces, { ...opts, accel });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(
      `${accel ? "accel" : "plain"}: ${ms.toFixed(0)}ms  ` +
        `(probe-internal ${r.elapsedMs.toFixed(0)}ms, ${r.segments.length} segments, ${r.samplesProbed} samples)`,
    );
    return r;
  };

  console.log(`pool: ${surfaces.length} surfaces, scale ${worldScale}x`);
  if (mode === "both") {
    const a = run(true);
    const p = run(false);
    const key = (s: (typeof a.segments)[number]): string =>
      JSON.stringify([s.x0, s.z0, s.x1, s.z1, s.yBase, s.yLow, s.yHigh, s.kind, s.blockerAddr, s.samples]);
    const ka = a.segments.map(key).sort();
    const kp = p.segments.map(key).sort();
    const equal = ka.length === kp.length && ka.every((k, i) => k === kp[i]);
    console.log(`outputs identical: ${equal}`);
    if (!equal) process.exitCode = 1;
  } else {
    run(mode === "accel");
  }
}

main();
