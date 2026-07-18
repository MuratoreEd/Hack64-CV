// Exploratory probe for skybox rendering: find the area's GEO_BACKGROUND node
// (type 0x104), the segment-0x0A base, and the 80-entry skybox tile pointer
// table (8 rows x 10 cols, cols 8/9 duplicating cols 0/1 for wraparound).
//   npx tsx scripts/probeSkybox.ts

import { ProcessMemory, findProject64Pid } from "../src/win32.js";
import { discoverRdram, readRdramSnapshot } from "../src/rdram.js";
import { Ram, readSegmentTable, resolveAddr } from "../../src/gfx/ram.js";
import { US_GCURRENT_AREA } from "../../src/gfx/graph.js";

const KSEG0 = (a: number): boolean => a >= 0x80000000 && a < 0x80800000;

function main(): void {
  const pid = findProject64Pid();
  if (pid == null) throw new Error("Project64 not running");
  const proc = new ProcessMemory(pid);
  const rd = discoverRdram(proc);
  if (!rd) throw new Error("RDRAM not found");
  const snap = readRdramSnapshot(rd);
  proc.close();
  const ram = new Ram(new Uint8Array(snap));

  // --- 1. Walk the graph, list ALL node types seen + background candidates ---
  const areaPtr = ram.u32(US_GCURRENT_AREA);
  const root = ram.u32(areaPtr + 4);
  console.log(`area ${areaPtr.toString(16)} root ${root.toString(16)}`);
  const typeCounts = new Map<number, number>();
  const bgNodes: number[] = [];
  const visited = new Set<number>();
  const walk = (node: number, depth: number): void => {
    if (!KSEG0(node) || visited.has(node) || visited.size > 20000 || depth > 40) return;
    visited.add(node);
    const type = ram.s16(node) & 0xffff;
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    if (type === 0x12c) bgNodes.push(node);
    if (type === 0x018) return;
    const first = ram.u32(node + 0x10);
    if (!KSEG0(first)) return;
    let child = first;
    for (let i = 0; i < 1024; i++) {
      walk(child, depth + 1);
      child = ram.u32(child + 8);
      if (child === first || !KSEG0(child)) break;
    }
  };
  walk(root, 0);
  console.log("node types:", [...typeCounts.entries()]
    .map(([t, n]) => `0x${t.toString(16)}:${n}`).join(" "));

  for (const n of bgNodes) {
    const func = ram.u32(n + 0x14);
    const bg = ram.u32(n + 0x18);
    console.log(`BACKGROUND node ${n.toString(16)}: func ${func.toString(16)} background ${bg} (0x${bg.toString(16)})`);
  }

  // --- 2. Segment 0x0A + tile table hunt ---
  const segs = readSegmentTable(ram);
  console.log(`segment 0x0A base: phys ${segs[0x0a].toString(16)}`);
  const segVirt = 0x80000000 + segs[0x0a];

  const validTable = (base: number): boolean => {
    if (!ram.ok(base, 80 * 4)) return false;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 10; c++) {
        const p = ram.u32(base + (r * 10 + c) * 4);
        if (p >>> 24 !== 0x0a) return false;
      }
      if (ram.u32(base + (r * 10 + 8) * 4) !== ram.u32(base + r * 10 * 4)) return false;
      if (ram.u32(base + (r * 10 + 9) * 4) !== ram.u32(base + (r * 10 + 1) * 4)) return false;
    }
    return true;
  };

  console.log(`table at seg+0x20000: ${validTable(segVirt + 0x20000)}`);
  const hits: number[] = [];
  for (let off = 0; off < 0x40000 && hits.length < 5; off += 8) {
    if (validTable(segVirt + off)) hits.push(off);
  }
  console.log(`scan hits (seg offsets): ${hits.map((o) => "0x" + o.toString(16)).join(", ") || "none"}`);

  if (hits.length > 0) {
    const base = segVirt + hits[0];
    const first = ram.u32(base);
    const tile0 = resolveAddr(first, segs);
    console.log(`first tile ptr ${first.toString(16)} -> ${tile0.toString(16)}`);
    // Sample a few texels of tile 0 as RGBA16 sanity.
    const px: string[] = [];
    for (let i = 0; i < 4; i++) px.push(ram.u16(tile0 + i * 2).toString(16));
    console.log(`tile0 first texels: ${px.join(" ")}`);
    // Distinct tiles:
    const uniq = new Set<number>();
    for (let i = 0; i < 80; i++) uniq.add(ram.u32(base + i * 4));
    console.log(`distinct tile pointers: ${uniq.size}`);
  }
}

main();
