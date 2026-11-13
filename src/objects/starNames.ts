// The hack's own star names, read out of an RDRAM snapshot.
//
// SM64 keeps its menu text in segment 0x02, which stays loaded for the whole
// session: seg2_act_name_table is 97 pointers to strings in the game's dialog
// encoding — six act names for each of the 15 main courses, then seven extra
// lines. Hack authors rename their stars by editing exactly these strings, so
// what is in RAM is what the pause menu shows.
//
// The table sits at 0x0201192C in a US ROM (and in the hack this was checked
// against, 2026-11-13: dialog table 0x02010A68, course names 0x02010F68, act
// names 0x0201192C). A text tool that rebuilt the segment may have moved it,
// so if that address doesn't hold a plausible table the segment is searched
// for one: a run of exactly 97 segment-2 pointers.

import { Ram, readSegmentTable, resolveAddr } from "../gfx/ram";

const TEXT_SEGMENT = 0x02;
const US_ACT_NAME_TABLE = 0x0201192c;
const ACT_NAMES = 97; // 15 courses x 6 acts + 7 extra lines
const ACTS_PER_COURSE = 6;
const MAIN_COURSES = 15;
const SEGMENT_SCAN_BYTES = 0x40000;
const MAX_NAME_BYTES = 96;

const SPECIAL: Record<number, string> = {
  0x3e: "'", 0x3f: ".", 0x50: "▲", 0x51: "▼", 0x52: "◀", 0x53: "▶",
  0x54: "[A]", 0x55: "[B]", 0x56: "[C]", 0x57: "[Z]", 0x58: "[R]",
  0x6f: ",", 0x9e: " ", 0x9f: "-", 0xd0: "/", 0xd1: "the", 0xd2: "you",
  0xe0: "%", 0xe1: "(", 0xe2: ")(", 0xe3: ")", 0xe4: "+", 0xe5: "&",
  0xe6: ":", 0xf2: "!", 0xf3: "%", 0xf4: "?", 0xf5: "“", 0xf6: "”",
  0xf7: "~", 0xf9: "$", 0xfa: "★", 0xfb: "×", 0xfc: "·", 0xfd: "☆",
  0xfe: " ", // line break: a name is shown on one line here
};

/** One byte of SM64 (US) dialog text, or null for a byte with no glyph. */
function glyph(b: number): string | null {
  if (b <= 0x09) return String.fromCharCode(0x30 + b);
  if (b <= 0x23) return String.fromCharCode(0x41 + b - 0x0a);
  if (b <= 0x3d) return String.fromCharCode(0x61 + b - 0x24);
  return SPECIAL[b] ?? null;
}

/** Decode a 0xFF-terminated string at `addr`. Null if it runs past the limit
 * or the snapshot: that is not a string. Unknown bytes become "?". */
export function decodeText(ram: Ram, addr: number, maxBytes = MAX_NAME_BYTES): string | null {
  let out = "";
  for (let i = 0; i < maxBytes; i++) {
    if (!ram.ok(addr + i)) return null;
    const b = ram.u8(addr + i);
    if (b === 0xff) return out.replace(/\s+/g, " ").trim();
    out += glyph(b) ?? "?";
  }
  return null;
}

export interface StarNames {
  /** The name of star `starId` (0-based) of course `course` (1-based), or
   * null when the game has no name for it: a castle or bonus-course star, the
   * 100-coin star, an empty string. */
  actName(course: number, starId: number): string | null;
  /** Segmented address the table was found at (for diagnostics). */
  tableAddr: number;
}

/** Read the table at `table` (KSEG0): every entry must be a segment-2 pointer
 * to a decodable string, and the names must mostly be real text — a run of
 * pointers into texture data decodes too, as "?" soup. */
function readTable(ram: Ram, table: number, segs: number[]): string[] | null {
  if (!ram.ok(table, ACT_NAMES * 4)) return null;
  const names: string[] = [];
  let unknown = 0;
  let chars = 0;
  for (let i = 0; i < ACT_NAMES; i++) {
    const ptr = ram.u32(table + i * 4);
    if (ptr >>> 24 !== TEXT_SEGMENT) return null;
    const name = decodeText(ram, resolveAddr(ptr, segs));
    if (name === null) return null;
    names.push(name);
    chars += name.length;
    unknown += name.split("?").length - 1;
  }
  if (chars === 0 || unknown * 10 > chars) return null;
  return names;
}

/** The act names in this snapshot, or null when no table can be found (not a
 * US ROM, or segment 2 isn't loaded yet). */
export function readStarNames(rdram: Uint8Array): StarNames | null {
  const ram = new Ram(rdram);
  if (!ram.ok(0x8033b400, 32 * 4)) return null;
  const segs = readSegmentTable(ram);
  const base = resolveAddr(TEXT_SEGMENT << 24, segs);

  let tableAddr = US_ACT_NAME_TABLE;
  let names = readTable(ram, resolveAddr(tableAddr, segs), segs);
  if (!names) {
    // Search the segment for a run of exactly ACT_NAMES segment-2 pointers.
    let run = 0;
    for (let off = 0; off <= SEGMENT_SCAN_BYTES && !names; off += 4) {
      const isPtr =
        off < SEGMENT_SCAN_BYTES &&
        ram.ok(base + off, 4) &&
        ram.u32(base + off) >>> 24 === TEXT_SEGMENT;
      if (isPtr) {
        run++;
        continue;
      }
      if (run === ACT_NAMES) {
        const start = off - run * 4;
        names = readTable(ram, base + start, segs);
        if (names) tableAddr = ((TEXT_SEGMENT << 24) | start) >>> 0;
      }
      run = 0;
    }
  }
  if (!names) return null;

  const table = names;
  return {
    tableAddr,
    actName(course, starId) {
      if (!Number.isInteger(course) || course < 1 || course > MAIN_COURSES) return null;
      if (!Number.isInteger(starId) || starId < 0 || starId >= ACTS_PER_COURSE) return null;
      return table[(course - 1) * ACTS_PER_COURSE + starId] || null;
    },
  };
}
