// Live end-to-end test of the textured-level parsing chain (P5) without the
// browser: snapshot RDRAM from the running game, run the same buildLevelModel
// the web app uses, and print material/texture/triangle stats + bounds.
//   npx tsx scripts/dumpModel.ts

import { ProcessMemory, findProject64Pid } from "../src/win32.js";
import { discoverRdram, readRdramSnapshot } from "../src/rdram.js";
import { buildLevelModel } from "../../src/gfx/level.js";

function main(): void {
  const pid = findProject64Pid();
  if (pid == null) throw new Error("Project64 not running");
  const proc = new ProcessMemory(pid);
  const rd = discoverRdram(proc);
  if (!rd) throw new Error("RDRAM not found");

  const t0 = performance.now();
  const snap = readRdramSnapshot(rd);
  const tSnap = performance.now();
  const model = buildLevelModel(new Uint8Array(snap));
  const tModel = performance.now();
  proc.close();

  console.log(
    `snapshot ${snap.length / 1024 / 1024} MB in ${(tSnap - t0).toFixed(0)}ms; ` +
      `model built in ${(tModel - tSnap).toFixed(0)}ms`,
  );
  if (!model) {
    console.log("no model (no loaded area found)");
    return;
  }
  console.log(
    `display lists: ${model.displayLists}, triangles: ${model.triangles}, batches: ${model.batches.length}`,
  );

  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (const b of model.batches) {
    for (let i = 0; i < b.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], b.positions[i + k]);
        max[k] = Math.max(max[k], b.positions[i + k]);
      }
    }
  }
  console.log(`bounds min (${min.join(", ")}) max (${max.join(", ")})`);

  for (const b of model.batches.slice(0, 40)) {
    const tex = b.texture
      ? `${b.texture.width}x${b.texture.height}`
      : "flat";
    const uv =
      b.uvs.length >= 6
        ? ` uv[0..2]=(${b.uvs[0].toFixed(2)},${b.uvs[1].toFixed(2)}) (${b.uvs[2].toFixed(2)},${b.uvs[3].toFixed(2)})`
        : "";
    console.log(
      `  ${b.key.slice(0, 60).padEnd(60)} layer ${b.layer} tris ${(b.positions.length / 9).toFixed(0).padStart(5)} tex ${tex} wrap ${b.wrapS}/${b.wrapT}${uv}`,
    );
  }
  if (model.batches.length > 40) console.log(`  … ${model.batches.length - 40} more`);
}

main();
