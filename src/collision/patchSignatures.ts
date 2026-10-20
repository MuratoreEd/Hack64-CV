// Identify Frame's collision patch from the ROM's own CODE in an RDRAM snapshot.
//
// FramePerfection's SM64CollisionPatcher edits fixed US ROM offsets and checks
// the bytes it expects before touching them, so the same offsets — mapped into
// RAM — tell us afterwards what it did:
//
//   - find_wall_collisions calls find_wall_collisions_from_list twice (dynamic
//     and static lists). The patcher re-points those two JALs at its own routine,
//     injected into expansion RAM ("frauber space", 0x80400000+). We look for
//     JALs near the expected call sites, like the patcher does, and confirm a
//     redirected call really lands on the patch's routine by its first bytes.
//   - add_surface_to_cell loads its wall threshold from two rodata doubles
//     (±0.01); the patcher rewrites them to ±0.05.
//
// The engine segment is loaded from ROM 0x0F5580 at RAM 0x80378800 (US), so
// ROM offset r lives at RAM 0x80378800 + (r - 0x0F5580). Anything we don't
// recognise returns null — a relocated or differently-patched ROM falls back
// to the partition walk in patchDetect.ts rather than being guessed at.

import type { WallModel } from "./profile";

const ENGINE_RAM = 0x80378800;
const ENGINE_ROM = 0x0f5580;
const ramOf = (rom: number): number => ENGINE_RAM + (rom - ENGINE_ROM);

/** Where the patcher expects the first JAL (ROM 0xFDD18) and how far it looks
 * around it for hacks whose code shifted (±0x400). */
const JAL_SEARCH_CENTER = ramOf(0x0fdd18);
const JAL_SEARCH_RANGE = 0x400;
/** The extra call to the OLD routine the patcher adds on extended-boundary
 * ROMs (its camera "band-aid", ROM 0xFDD8C) — skipped, as the patcher does. */
const BAND_AID_JAL = ramOf(0x0fdd8c);
/** Vanilla find_wall_collisions_from_list. */
const VANILLA_WALL_ROUTINE = 0x80380690;

/** The first 13 instructions of the patch's injected routine, identical in its
 * regular- and extended-boundary builds (Program.cs byte tables). */
const FRAME_ROUTINE_PROLOGUE = [
  0x27bdff20, 0xafbf0054, 0xafb30050, 0xafb2004c, 0xafb10048, 0xafb00044,
  0xf7be0038, 0xf7bc0030, 0xf7ba0028, 0xf7b80020, 0xf7b60018, 0xf7b40010,
  0xc4aa0010,
];

/** add_surface_to_cell's threshold doubles (ROM 0x108930 / 0x108938). */
const THRESHOLD_ADDR = ramOf(0x108930);
/** Where some hacks (King Boo's Revenge 1) keep them instead (ROM 0xFFCB0). */
const ALT_THRESHOLD_ADDR = ramOf(0x0ffcb0);

export interface PatchSignatures {
  /** Which wall routine find_wall_collisions calls, or null if unrecognised. */
  walls: WallModel | null;
  /** The wall threshold in the rodata the game loads, or null. */
  wallThreshold: number | null;
}

export function detectPatchSignatures(rdram: Uint8Array): PatchSignatures {
  const view = new DataView(rdram.buffer, rdram.byteOffset, rdram.byteLength);
  const has = (addr: number, len: number): boolean =>
    ((addr & 0x1fffffff) >>> 0) + len <= rdram.length;
  const u32 = (addr: number): number => view.getUint32((addr & 0x1fffffff) >>> 0) >>> 0;
  const f64 = (addr: number): number => view.getFloat64((addr & 0x1fffffff) >>> 0);

  // --- wall routine ---
  let vanillaCalls = 0;
  let frameCalls = 0;
  const lo = JAL_SEARCH_CENTER - JAL_SEARCH_RANGE;
  const hi = JAL_SEARCH_CENTER + JAL_SEARCH_RANGE;
  if (has(hi, 4)) {
    for (let a = lo; a < hi; a += 4) {
      if (a === BAND_AID_JAL) continue;
      const w = u32(a);
      if (w >>> 26 !== 3) continue; // JAL
      const target = (0x80000000 | ((w & 0x03ffffff) << 2)) >>> 0;
      if (target === VANILLA_WALL_ROUTINE) vanillaCalls++;
      else if (target >= 0x80400000 && isFrameRoutine(target)) frameCalls++;
    }
  }
  function isFrameRoutine(addr: number): boolean {
    if (!has(addr, FRAME_ROUTINE_PROLOGUE.length * 4)) return false;
    return FRAME_ROUTINE_PROLOGUE.every((w, i) => u32(addr + i * 4) === w);
  }
  const walls: WallModel | null =
    frameCalls > 0 && vanillaCalls === 0
      ? "frame"
      : vanillaCalls > 0 && frameCalls === 0
        ? "vanilla"
        : null;

  // --- wall threshold ---
  const pair = (addr: number): [number, number] | null =>
    has(addr, 16) ? [f64(addr), f64(addr + 8)] : null;
  const is = (p: [number, number] | null, t: number): boolean =>
    p !== null && p[0] === t && p[1] === -t;
  const main = pair(THRESHOLD_ADDR);
  const alt = pair(ALT_THRESHOLD_ADDR);
  let wallThreshold: number | null = null;
  if (is(alt, 0.05) || is(main, 0.05)) wallThreshold = 0.05;
  // The alternate location in its unpatched form holds +0.0001 / -0.01: an
  // asymmetric threshold the profile can't express, so say nothing rather
  // than read the unused vanilla constants next door.
  else if (alt !== null && alt[0] === 1e-4 && alt[1] === -0.01) wallThreshold = null;
  else if (is(main, 0.01)) wallThreshold = 0.01;

  return { walls, wallThreshold };
}
