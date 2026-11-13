// Every object the current level places — all of its areas, all of its acts —
// read from the level script instead of the live object pool.
//
// The object pool (collectibles.ts) only holds what the game loaded: the
// current area, filtered for the current act. The level script is where those
// objects came from: inside each AREA ... END_AREA block, OBJECT commands give
// a model, a position, parameters, a behaviour and a mask of the acts the
// object exists in.
//
// Where the script is:
//   - sCurrentCmd (the level-script interpreter's program counter) sits, for
//     as long as a level runs, on the CALL_LOOP near the end of that level's
//     script. The script's AREA blocks are in the same segment, before it.
//     There is no pointer to the script's first command, and hack tools put
//     their own header there, so the AREA commands are found by signature.
//   - An area's objects are often not inline but in a sub-script it calls
//     (JUMP_LINK). In an unmodified game that sub-script is in the same
//     segment, in RAM. In the hack this was built against (ROM Manager-style
//     level, 2026-11-13) the area calls 0x0E000000, the script has loaded
//     segment 0x0E straight from the ROM (LOAD_RAW), and by the time the
//     level is running that segment points at something else entirely: the
//     object list exists only in the ROM. So a segment the script LOAD_RAWs
//     is read from the ROM, through `rom` (the bridge reads it out of the
//     emulator's memory); everything else is read from RAM.
//
// Not read: macro objects (MACRO_OBJECTS, a separate preset-indexed list that
// vanilla levels use for coins and boxes) and anything a compressed segment
// (LOAD_MIO0) would hold.

import { Ram, readSegmentTable } from "../gfx/ram";

/** US address of sCurrentCmd (checked live: it pointed at a CALL_LOOP of
 * lvl_init_or_update inside the level's script segment). */
const US_CURRENT_CMD = 0x8038be28;

const CMD_JUMP = 0x05;
const CMD_JUMP_LINK = 0x06;
const CMD_RETURN = 0x07;
const CMD_EXIT = 0x02;
const CMD_LOAD_RAW = 0x17;
const CMD_AREA = 0x1f;
const CMD_END_AREA = 0x20;
const CMD_OBJECT = 0x24;
const CMD_MAX = 0x3c;

/** How far back from sCurrentCmd a level's script can start. */
const SCRIPT_SCAN_BYTES = 0x20000;
/** How much of a ROM-backed sub-script is fetched at once. */
const ROM_CHUNK_BYTES = 0x10000;
const MAX_ROM_BYTES = 0x4000000;
const MAX_COMMANDS = 20000;
const MAX_CALL_DEPTH = 4;
const MAX_AREAS = 8;

export interface ScriptObject {
  area: number;
  /** Act mask: bit n = act n+1; 0x1F = every act. */
  acts: number;
  model: number;
  /** World units (s16 in the script). */
  pos: { x: number; y: number; z: number };
  behParams: number;
  /** Segmented behaviour address (0x13xxxxxx), as the script names it. */
  behavior: number;
}

export interface RomRange {
  offset: number;
  length: number;
}

/** ROM bytes for a range: the bytes, null when they can't be had, undefined
 * when they haven't been fetched yet (the range is then reported as missing,
 * and the caller is expected to fetch it and run the parse again). */
export type RomReader = (offset: number, length: number) => Uint8Array | null | undefined;

export interface LevelObjects {
  /** Area indices the script defines, in script order. */
  areas: number[];
  objects: ScriptObject[];
  /** ROM ranges the parse needed and didn't have. */
  missing: RomRange[];
}

/** Whether the game loads an object with this act mask in act `act` (the test
 * in the engine's OBJECT_WITH_ACTS handler; act 0 = no act, as in the castle). */
export function actsInclude(acts: number, act: number): boolean {
  if (acts === 0x1f) return true;
  return act >= 1 && act <= 8 && (acts & (1 << (act - 1))) !== 0;
}

interface Code {
  bytes: Uint8Array;
  pos: number;
}

/** The level's object placements, or null when no level script is running
 * (or none can be recognised). */
export function readLevelObjects(rdram: Uint8Array, rom: RomReader): LevelObjects | null {
  const ram = new Ram(rdram);
  if (!ram.ok(US_CURRENT_CMD, 4)) return null;
  const cur = ram.u32(US_CURRENT_CMD);
  const curOff = cur & 0x1fffffff;
  if (cur >>> 24 !== 0x80 || cur % 4 !== 0 || curOff + 4 > rdram.length) return null;
  if (rdram[curOff] > CMD_MAX) return null;

  const segs = readSegmentTable(ram);
  // The script's segment: the one that starts closest below sCurrentCmd.
  let base = 0;
  for (const s of segs) if (s <= curOff && s > base) base = s;
  const scanFrom = Math.max(base, curOff - SCRIPT_SCAN_BYTES) & ~3;
  const u32 = (b: Uint8Array, o: number): number =>
    ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const s16 = (b: Uint8Array, o: number): number => (((b[o] << 8) | b[o + 1]) << 16) >> 16;

  // Segments the script loads straight from the ROM: segment -> ROM range.
  const romSegs = new Map<number, { start: number; end: number }>();
  for (let o = scanFrom; o + 12 <= curOff; o += 4) {
    if (rdram[o] !== CMD_LOAD_RAW || rdram[o + 1] !== 0x0c || rdram[o + 3] >= 0x20) continue;
    const start = u32(rdram, o + 4);
    const end = u32(rdram, o + 8);
    if (start < end && end <= MAX_ROM_BYTES) romSegs.set(rdram[o + 3], { start, end });
  }

  const missing: RomRange[] = [];
  /** Where a segmented (or KSEG0) script address can be read from. */
  const resolve = (addr: number): Code | null => {
    if (addr >>> 24 >= 0x80) {
      const o = addr & 0x1fffffff;
      return o < rdram.length ? { bytes: rdram, pos: o } : null;
    }
    const seg = addr >>> 24;
    const off = addr & 0xffffff;
    const loaded = romSegs.get(seg);
    if (loaded && off < loaded.end - loaded.start) {
      const offset = loaded.start + off;
      const length = Math.min(loaded.end - offset, ROM_CHUNK_BYTES);
      const got = rom(offset, length);
      if (got) return { bytes: got, pos: 0 };
      if (got === undefined && !missing.some((m) => m.offset === offset && m.length === length)) {
        missing.push({ offset, length });
      }
      if (got === undefined) return null;
      // No ROM to be had: RAM is the only other place it could be.
    }
    if (seg >= 0x20 || segs[seg] === 0) return null;
    const o = segs[seg] + off;
    return o < rdram.length ? { bytes: rdram, pos: o } : null;
  };

  let budget = MAX_COMMANDS;
  /** Run commands from `code` collecting OBJECTs. Returns -1 unless the stream
   * ends with END_AREA; then the RAM offset just past it, or 0 when a JUMP took
   * the stream somewhere else first (nothing to resume a scan from). */
  const run = (code: Code, area: number, depth: number, out: ScriptObject[]): number => {
    let { bytes, pos } = code;
    while (budget-- > 0) {
      if (pos + 4 > bytes.length) return -1;
      const type = bytes[pos];
      const size = bytes[pos + 1];
      if (type > CMD_MAX || size === 0 || size % 4 !== 0 || pos + size > bytes.length) return -1;
      if (type === CMD_END_AREA) return bytes === code.bytes && pos >= code.pos ? pos + size : 0;
      if (type === CMD_RETURN || type === CMD_EXIT) return -1;
      if (type === CMD_OBJECT && size >= 24) {
        out.push({
          area,
          acts: bytes[pos + 2],
          model: bytes[pos + 3],
          pos: { x: s16(bytes, pos + 4), y: s16(bytes, pos + 6), z: s16(bytes, pos + 8) },
          behParams: u32(bytes, pos + 16),
          behavior: u32(bytes, pos + 20),
        });
      } else if (type === CMD_JUMP_LINK && size >= 8 && depth < MAX_CALL_DEPTH) {
        const sub = resolve(u32(bytes, pos + 4));
        if (sub) run(sub, area, depth + 1, out);
      } else if (type === CMD_JUMP && size >= 8) {
        const target = resolve(u32(bytes, pos + 4));
        if (!target) return -1;
        ({ bytes, pos } = target);
        continue;
      }
      pos += size;
    }
    return -1;
  };

  const areas: number[] = [];
  const objects: ScriptObject[] = [];
  for (let o = scanFrom; o + 8 <= curOff; ) {
    // AREA(index, geo): 1F 08 <index> 00 <geo layout address>
    const geo = u32(rdram, o + 4);
    const geoOk =
      geo >>> 24 >= 0x80 ? geo < 0x80800000 : geo >>> 24 < 0x20 && segs[geo >>> 24] !== 0;
    if (
      rdram[o] !== CMD_AREA || rdram[o + 1] !== 0x08 ||
      rdram[o + 2] >= MAX_AREAS || rdram[o + 3] !== 0 || !geoOk
    ) {
      o += 4;
      continue;
    }
    const found: ScriptObject[] = [];
    const end = run({ bytes: rdram, pos: o + 8 }, rdram[o + 2], 0, found);
    if (end < 0) {
      o += 4; // not an area block after all (or one we can't follow)
      continue;
    }
    areas.push(rdram[o + 2]);
    objects.push(...found);
    o = Math.max(end, o + 8); // only ever forwards
  }
  if (areas.length === 0) return null;
  return { areas, objects, missing };
}
