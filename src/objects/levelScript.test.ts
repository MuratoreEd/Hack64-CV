import { describe, it, expect } from "vitest";
import { actsInclude, readLevelObjects, type RomReader } from "./levelScript";
import { US_SEGMENT_TABLE } from "../gfx/ram";

const RAM_SIZE = 0x400000;
const SCRIPT_SEG = 0x19;
const SCRIPT_BASE = 0x102560; // where the running hack's script segment sat
const DATA_SEG = 0x0e;
const DATA_BASE = 0x300000;
const CURRENT_CMD = 0x38be28; // sCurrentCmd, physical

const be32 = (v: number): number[] => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const be16 = (v: number): number[] => [(v >> 8) & 0xff, v & 0xff];

// Level commands, as the game encodes them.
const OBJECT = (
  acts: number,
  pos: [number, number, number],
  behParams: number,
  behavior: number,
  model = 0x7a,
): number[] => [
  0x24, 0x18, acts, model,
  ...be16(pos[0]), ...be16(pos[1]), ...be16(pos[2]),
  0, 0, 0, 0, 0, 0, // angle
  ...be32(behParams), ...be32(behavior),
];
const AREA = (index: number, geo = 0x19005df0): number[] => [0x1f, 0x08, index, 0, ...be32(geo)];
const END_AREA = [0x20, 0x04, 0, 0];
const JUMP_LINK = (addr: number): number[] => [0x06, 0x08, 0, 0, ...be32(addr)];
const JUMP = (addr: number): number[] => [0x05, 0x08, 0, 0, ...be32(addr)];
const RETURN = [0x07, 0x04, 0, 0];
const TERRAIN = (addr: number): number[] => [0x2e, 0x08, 0, 0, ...be32(addr)];
const LOAD_RAW = (seg: number, start: number, end: number, flag = 0): number[] =>
  [0x17, 0x0c, flag, seg, ...be32(start), ...be32(end)];
const CALL_LOOP = [0x12, 0x08, 0, 1, ...be32(0x8024bcd8)];
const EXIT = [0x02, 0x04, 0, 0];

const STAR = 0x13003e3c;
const RED_COIN = 0x13003eac;

/** An RDRAM image running `script` (placed at `at` in the script segment);
 * sCurrentCmd is put on the script's CALL_LOOP. */
function image(script: number[], at = 0x1c): Uint8Array {
  const bytes = new Uint8Array(RAM_SIZE);
  const dv = new DataView(bytes.buffer);
  const segTable = US_SEGMENT_TABLE & 0x1fffffff;
  dv.setUint32(segTable + SCRIPT_SEG * 4, SCRIPT_BASE);
  dv.setUint32(segTable + DATA_SEG * 4, DATA_BASE);
  // What the hack leaves at the head of its script segment, and at the start
  // of the data segment once the level is running: neither is a command.
  bytes.set([0x80, 0x08, 0, 0, 0x19, 0, 0, 0x1c], SCRIPT_BASE);
  bytes.set([0x7f, 0x7f, 0x7f, 0, 0x7f, 0x7f, 0x7f, 0], DATA_BASE);
  bytes.set(script, SCRIPT_BASE + at);
  let loop = -1;
  for (let i = 0; i + 8 <= script.length; i += 4) {
    if (script[i] === 0x12 && script[i + 1] === 0x08) loop = i;
  }
  if (loop < 0) throw new Error("fixture script has no CALL_LOOP");
  dv.setUint32(CURRENT_CMD, 0x80000000 + SCRIPT_BASE + at + loop);
  return bytes;
}

/** A ROM that holds `data` at `offset`, served the way the app serves it. */
function romWith(offset: number, data: number[]): RomReader {
  return (o, len) => {
    if (o < offset || o + len > offset + data.length) return null;
    return new Uint8Array(data.slice(o - offset, o - offset + len));
  };
}

describe("actsInclude", () => {
  it("treats 0x1F as every act and anything else as a bit per act", () => {
    for (let act = 0; act <= 6; act++) expect(actsInclude(0x1f, act)).toBe(true);
    expect([1, 2, 3, 4, 5, 6].map((a) => actsInclude(0b000101, a))).toEqual([
      true, false, true, false, false, false,
    ]);
    expect(actsInclude(0x20, 6)).toBe(true);
    expect(actsInclude(0b000101, 0)).toBe(false); // no act: only "every act" objects
    expect(actsInclude(0, 1)).toBe(false);
  });
});

describe("readLevelObjects", () => {
  // The hack's shape: the area calls a sub-script in a segment the script
  // loaded from the ROM, and that segment now points at level data.
  const romObjects = [
    ...OBJECT(0x1f, [8607, 4581, 5399], 0x04000000, STAR),
    ...OBJECT(0x02, [-4401, 9006, 313], 0x01000000, STAR),
    ...OBJECT(0x1f, [17832, -5319, -16780], 0, RED_COIN, 0xd7),
    ...RETURN,
  ];
  const ROM_AT = 0x1944b80;
  const hackScript = [
    ...LOAD_RAW(DATA_SEG, ROM_AT, ROM_AT + romObjects.length, 1),
    ...AREA(1),
    ...JUMP_LINK(0x0e000000),
    ...TERRAIN(0x0e074f10),
    ...END_AREA,
    ...CALL_LOOP,
    ...EXIT,
  ];

  it("asks for the ROM range an area's objects are in, then reads them", () => {
    const ram = image(hackScript);
    const first = readLevelObjects(ram, () => undefined);
    expect(first).toEqual({
      areas: [1],
      objects: [],
      missing: [{ offset: ROM_AT, length: romObjects.length }],
    });

    const second = readLevelObjects(ram, romWith(ROM_AT, romObjects))!;
    expect(second.missing).toEqual([]);
    expect(second.areas).toEqual([1]);
    expect(second.objects).toEqual([
      { area: 1, acts: 0x1f, model: 0x7a, pos: { x: 8607, y: 4581, z: 5399 }, behParams: 0x04000000, behavior: STAR },
      { area: 1, acts: 0x02, model: 0x7a, pos: { x: -4401, y: 9006, z: 313 }, behParams: 0x01000000, behavior: STAR },
      { area: 1, acts: 0x1f, model: 0xd7, pos: { x: 17832, y: -5319, z: -16780 }, behParams: 0, behavior: RED_COIN },
    ]);
  });

  it("finds nothing, and asks for nothing more, when there is no ROM to read", () => {
    const found = readLevelObjects(image(hackScript), () => null)!;
    // Falls back to RAM, where the segment now holds level data.
    expect(found).toEqual({ areas: [1], objects: [], missing: [] });
  });

  it("reads inline objects and same-segment sub-scripts from RAM, per area", () => {
    // The unmodified game's shape: local sub-scripts first, then the entry.
    const local = [...OBJECT(0x1f, [100, 200, -300], 0x02000000, STAR), ...RETURN];
    const entry = [
      ...AREA(1, 0x0e000a00),
      ...JUMP_LINK(0x19000000 + 0x1c), // the local sub-script
      ...OBJECT(0x01, [1, 2, 3], 0x00000000, STAR),
      ...END_AREA,
      ...AREA(2, 0x0e000b00),
      ...OBJECT(0x1f, [-1, -2, -3], 0x03000000, STAR),
      ...END_AREA,
      ...CALL_LOOP,
    ];
    const found = readLevelObjects(image([...local, ...entry]), () => null)!;
    expect(found.areas).toEqual([1, 2]);
    expect(found.objects.map((o) => [o.area, o.acts, o.behParams >>> 24, o.pos.x])).toEqual([
      [1, 0x1f, 2, 100],
      [1, 0x01, 0, 1],
      [2, 0x1f, 3, -1],
    ]);
    expect(found.missing).toEqual([]);
  });

  it("follows a JUMP inside an area", () => {
    const tail = [...OBJECT(0x1f, [7, 8, 9], 0x05000000, STAR), ...END_AREA];
    const script = [
      ...tail, // at +0x1c
      ...AREA(3),
      ...JUMP(0x19000000 + 0x1c),
      ...CALL_LOOP,
    ];
    const found = readLevelObjects(image(script), () => null)!;
    // The area at the jump is found; so is nothing bogus from the tail alone.
    expect(found.areas).toEqual([3]);
    expect(found.objects.map((o) => o.pos)).toEqual([{ x: 7, y: 8, z: 9 }]);
  });

  it("ignores something that looks like AREA but never ends as one", () => {
    const script = [
      ...AREA(1),
      0x3d, 0x04, 0, 0, // not a command
      ...AREA(2),
      ...OBJECT(0x1f, [5, 5, 5], 0, STAR),
      ...END_AREA,
      ...CALL_LOOP,
    ];
    const found = readLevelObjects(image(script), () => null)!;
    expect(found.areas).toEqual([2]);
    expect(found.objects).toHaveLength(1);
  });

  it("does not read past the running command", () => {
    // A second area AFTER the CALL_LOOP is not part of what ran (stale bytes
    // from the level loaded before this one live there).
    const script = [...AREA(1), ...END_AREA, ...CALL_LOOP, ...AREA(2), ...END_AREA];
    expect(readLevelObjects(image(script), () => null)!.areas).toEqual([1]);
  });

  it("survives a sub-script that calls itself", () => {
    const script = [
      ...OBJECT(0x1f, [1, 1, 1], 0, STAR), // +0x1c
      ...JUMP_LINK(0x19000000 + 0x1c),
      ...RETURN,
      ...AREA(1),
      ...JUMP_LINK(0x19000000 + 0x1c),
      ...END_AREA,
      ...CALL_LOOP,
    ];
    const found = readLevelObjects(image(script), () => null)!;
    expect(found.areas).toEqual([1]);
    expect(found.objects.length).toBeGreaterThan(0);
    expect(found.objects.length).toBeLessThan(10);
  });

  it("returns null when no level script is running", () => {
    expect(readLevelObjects(new Uint8Array(RAM_SIZE), () => null)).toBeNull(); // sCurrentCmd = 0
    expect(readLevelObjects(new Uint8Array(64), () => null)).toBeNull(); // not a snapshot
    expect(readLevelObjects(image([...CALL_LOOP]), () => null)).toBeNull(); // no areas
  });
});
