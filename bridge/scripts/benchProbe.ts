// Clean single-run probe benchmark on the live pool (fresh process per mode,
// no instrumentation). Also asserts accel/plain output equivalence when both
// are run in one invocation.
//   npx tsx scripts/benchProbe.ts accel|plain|both [worldScale]

import { ProcessMemory, findProject64Pid } from "../src/win32.js";
import { discoverRdram, readSurfacePool } from "../src/rdram.js";
import { parseSurfacePool } from "../../src/collision/surface.js";
import { findInvisibleWalls } from "../../src/probe/invisibleWalls.js";

function main(): void {
  const mode = process.argv[2] ?? "accel";
  const worldScale = Number(process.argv[3] ?? 4);
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

  const opts = {
    marioHeight: 160 / worldScale,
    ledgeGrace: 100 / worldScale,
    wallOffset: 60 / worldScale,
    wallRadius: 50 / worldScale,
  };

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
