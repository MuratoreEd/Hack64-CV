// Diagnose the textured-view color bug: are the vertex "colors" the DLs feed
// us actually lighting NORMALS (signed xyz, |v| ≈ 127)? Also tally geometry
// mode and combine ops so we know what state the DLs assume at entry.
//   npx tsx scripts/dumpColors.ts

import { ProcessMemory, findProject64Pid } from "../src/win32.js";
import { discoverRdram, readRdramSnapshot } from "../src/rdram.js";
import { buildLevelModel } from "../../src/gfx/level.js";
import { Ram, readSegmentTable, resolveAddr } from "../../src/gfx/ram.js";
import { collectAreaDisplayLists } from "../../src/gfx/graph.js";

const G_LIGHTING = 0x00020000;

function main(): void {
  const pid = findProject64Pid();
  if (pid == null) throw new Error("Project64 not running");
  const proc = new ProcessMemory(pid);
  const rd = discoverRdram(proc);
  if (!rd) throw new Error("RDRAM not found");
  const snap = readRdramSnapshot(rd);
  proc.close();
  const bytes = new Uint8Array(snap);

  // --- 1. Normal-vs-color test on what the interpreter currently emits ---
  const model = buildLevelModel(bytes);
  if (!model) throw new Error("no model");
  console.log(`batches: ${model.batches.length}, tris: ${model.triangles}\n`);
  console.log("per-batch vertex 'color' stats (signed-length ≈127 ⇒ normals):");
  for (const b of model.batches) {
    const n = b.colors.length / 4;
    if (n === 0) continue;
    let normalish = 0;
    const sample: string[] = [];
    for (let i = 0; i < n; i++) {
      const r = Math.round(b.colors[i * 4] * 255);
      const g = Math.round(b.colors[i * 4 + 1] * 255);
      const bb = Math.round(b.colors[i * 4 + 2] * 255);
      const s = (v: number): number => (v >= 128 ? v - 256 : v);
      const len = Math.hypot(s(r), s(g), s(bb));
      if (len > 100 && len < 145) normalish++;
      if (i < 3) sample.push(`(${r},${g},${bb})`);
    }
    console.log(
      `  ${b.key.slice(0, 52).padEnd(52)} verts ${String(n).padStart(5)} ` +
        `normal-like ${((100 * normalish) / n).toFixed(0).padStart(3)}%  ` +
        sample.join(" "),
    );
  }

  // --- 2. Opcode tally across the same DLs (what state do they set?) ---
  const ram = new Ram(bytes);
  const segs = readSegmentTable(ram);
  if (!segs) throw new Error("no segment table");
  const dls = collectAreaDisplayLists(ram);
  if (!dls) throw new Error("no area DLs");

  let setLight = 0;
  let clearLight = 0;
  let setOther = 0;
  let clearOther = 0;
  const combines = new Map<string, number>();
  for (const dl of dls) {
    const stack: number[] = [];
    let pc = resolveAddr(dl.addr, segs);
    let steps = 0;
    while (ram.ok(pc, 8) && steps++ < 200000) {
      const w0 = ram.u32(pc);
      const w1 = ram.u32(pc + 4);
      pc += 8;
      const op = w0 >>> 24;
      if (op === 0xb8) {
        const ret = stack.pop();
        if (ret === undefined) break;
        pc = ret;
      } else if (op === 0x06) {
        if (((w0 >>> 16) & 0xff) === 0) stack.push(pc);
        pc = resolveAddr(w1, segs);
      } else if (op === 0xb7) {
        if (w1 & G_LIGHTING) setLight++;
        else setOther++;
      } else if (op === 0xb6) {
        if (w1 & G_LIGHTING) clearLight++;
        else clearOther++;
      } else if (op === 0xfc) {
        const k = `${(w0 & 0xffffff).toString(16)}:${(w1 >>> 0).toString(16)}`;
        combines.set(k, (combines.get(k) ?? 0) + 1);
      }
    }
  }
  console.log(
    `\ngeometry mode: SET lighting ×${setLight}, CLEAR lighting ×${clearLight}, ` +
      `other set ×${setOther} / clear ×${clearOther}`,
  );
  console.log("combine modes (fc w0lo24:w1):");
  for (const [k, c] of combines) console.log(`  ${k} ×${c}`);
}

main();
