// One-shot diagnostic for the graphics side (P5 textured view):
//   npx tsx scripts/probeGfx.ts
//
// Validates the US addresses we need against the LIVE game before any app code
// trusts them: the segment table, the current Area struct (and its graph-node
// root), then walks the area's graph tree counting node types and hexdumps the
// first terrain display list so we can confirm the microcode encoding
// (Fast3D vs F3DEX) actually used by this hack.

import { ProcessMemory, findProject64Pid } from "../src/win32.js";
import { discoverRdram, type Rdram } from "../src/rdram.js";

// Candidates (US, from sm64.us.map / community docs — VERIFY, don't trust).
const CAND = {
  sSegmentTable: 0x8033b400, // uintptr_t[32], physical offsets
  gCurrentArea: 0x8032ddcc, // struct Area*
  gAreas: 0x8033a090, // struct Area[8], size 0x3c each
  gCurrAreaIndex: 0x8033baca, // s16 (known-good from P1)
  gCurrLevelNum: 0x8032ddf8, // s16 (known-good from P1)
};

const KSEG0 = (a: number): boolean => a >= 0x80000000 && a < 0x80800000;

const hex = (n: number): string => "0x" + (n >>> 0).toString(16);

function main(): void {
  const pid = findProject64Pid();
  if (pid == null) throw new Error("Project64 not running");
  const proc = new ProcessMemory(pid);
  const rd = discoverRdram(proc);
  if (!rd) throw new Error("RDRAM not found");
  console.log(`attached; rdram base ${rd.base.toString(16)} order ${rd.order}`);

  const level = rd.s16(CAND.gCurrLevelNum);
  const areaIdx = rd.s16(CAND.gCurrAreaIndex);
  console.log(`level ${level} area ${areaIdx}`);

  // --- Segment table ---
  console.log("\n--- segment table @ " + hex(CAND.sSegmentTable) + " ---");
  const segs: number[] = [];
  for (let i = 0; i < 32; i++) {
    const v = rd.u32(CAND.sSegmentTable + i * 4);
    segs.push(v);
    if (v !== 0) console.log(`  seg ${hex(i)} -> ${hex(v)}${v < 0x800000 ? "" : "  (!! not a phys offset)"}`);
  }

  // --- Area struct via gCurrentArea ---
  const areaPtr = rd.u32(CAND.gCurrentArea);
  console.log(`\ngCurrentArea @ ${hex(CAND.gCurrentArea)} -> ${hex(areaPtr)} ${KSEG0(areaPtr) ? "" : "(!! not KSEG0)"}`);
  let root = 0;
  if (KSEG0(areaPtr)) {
    const index = rd.readBytes(areaPtr, 1)[0];
    const terrainType = rd.s16(areaPtr + 2);
    root = rd.u32(areaPtr + 4);
    const terrainData = rd.u32(areaPtr + 8);
    console.log(`  index ${index} (want ${areaIdx}), terrainType ${hex(terrainType)}`);
    console.log(`  graphRoot ${hex(root)} ${KSEG0(root) ? `type ${hex(rd.s16(root))}` : "(!! bad ptr)"}`);
    console.log(`  terrainData ${hex(terrainData)}`);
  }

  // Cross-check against gAreas[areaIdx]
  const areaByArray = CAND.gAreas + areaIdx * 0x3c;
  console.log(`gAreas[${areaIdx}] @ ${hex(areaByArray)}: index ${rd.readBytes(areaByArray, 1)[0]}, graphRoot ${hex(rd.u32(areaByArray + 4))}`);

  if (!KSEG0(root)) {
    console.log("no valid root; stopping");
    return;
  }

  // --- Walk the graph tree ---
  console.log("\n--- graph walk ---");
  const typeCounts = new Map<number, number>();
  const dlNodes: { addr: number; type: number; flags: number; dl: number }[] = [];
  const visited = new Set<number>();
  const DL_TYPES = new Set([0x015, 0x016, 0x017, 0x019, 0x01a, 0x01b, 0x01c]);

  const walk = (node: number, depth: number): void => {
    if (!KSEG0(node) || visited.has(node) || visited.size > 20000 || depth > 40) return;
    visited.add(node);
    const type = rd.s16(node) & 0xffff;
    const flags = rd.s16(node + 2) & 0xffff;
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    if (DL_TYPES.has(type & 0xff | (0))) { /* placeholder */ }
    if (DL_TYPES.has(type)) {
      const dl = rd.u32(node + 0x14);
      if (KSEG0(dl) || dl >> 24 <= 0x20) dlNodes.push({ addr: node, type, flags, dl });
    }
    if (type === 0x018) return; // OBJECT: skip objects entirely
    // children @0x10, circular doubly-linked list via next @8
    const first = rd.u32(node + 0x10);
    if (!KSEG0(first)) return;
    let child = first;
    for (let i = 0; i < 512; i++) {
      walk(child, depth + 1);
      child = rd.u32(child + 8);
      if (child === first || !KSEG0(child)) break;
    }
  };
  walk(root, 0);

  console.log(`visited ${visited.size} nodes`);
  for (const [t, c] of [...typeCounts.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  type ${hex(t)}: ${c}`);
  }
  console.log(`display-list-carrying nodes: ${dlNodes.length}`);
  for (const n of dlNodes.slice(0, 12)) {
    console.log(`  node ${hex(n.addr)} type ${hex(n.type)} layer ${(n.flags >> 8) & 0xff} dl ${hex(n.dl)}`);
  }

  // --- Hexdump the start of the first few DLs (resolve segmented if needed) ---
  const resolve = (addr: number): number => {
    if (KSEG0(addr)) return addr;
    const seg = (addr >>> 24) & 0x1f;
    return (0x80000000 | (segs[seg] + (addr & 0xffffff))) >>> 0;
  };
  for (const n of dlNodes.slice(0, 3)) {
    const dl = resolve(n.dl);
    console.log(`\n--- DL @ ${hex(n.dl)} (resolved ${hex(dl)}) ---`);
    const bytes = rd.readBytes(dl, 8 * 24);
    for (let i = 0; i < 24; i++) {
      const w0 = bytes.readUInt32BE(i * 8);
      const w1 = bytes.readUInt32BE(i * 8 + 4);
      console.log(`  ${w0.toString(16).padStart(8, "0")} ${w1.toString(16).padStart(8, "0")}`);
      if (w0 >>> 24 === 0xb8) break; // G_ENDDL
    }
  }

  proc.close();
}

main();
