import { describe, it, expect } from "vitest";
import { decodeText, readStarNames } from "./starNames";
import { Ram, US_SEGMENT_TABLE } from "../gfx/ram";

const SEG2 = 0x64f80; // physical base of segment 2 (as in the running hack)
const RAM_SIZE = 0x400000;

/** ASCII → SM64 dialog bytes (the subset the fixtures use), 0xFF-terminated. */
function encode(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (ch >= "0" && ch <= "9") out.push(c - 0x30);
    else if (ch >= "A" && ch <= "Z") out.push(c - 0x41 + 0x0a);
    else if (ch >= "a" && ch <= "z") out.push(c - 0x61 + 0x24);
    else if (ch === " ") out.push(0x9e);
    else if (ch === "'") out.push(0x3e);
    else if (ch === "!") out.push(0xf2);
    else if (ch === "-") out.push(0x9f);
    else throw new Error(`no fixture encoding for ${ch}`);
  }
  out.push(0xff);
  return out;
}

/** An RDRAM image whose segment 2 holds `names` and a pointer table to them at
 * `tableOffset` (segment-relative). */
function image(names: string[], tableOffset: number): Uint8Array {
  const bytes = new Uint8Array(RAM_SIZE);
  const dv = new DataView(bytes.buffer);
  dv.setUint32((US_SEGMENT_TABLE & 0x1fffffff) + 2 * 4, SEG2);
  let text = 0x10000; // strings, well away from either table position
  names.forEach((name, i) => {
    dv.setUint32(SEG2 + tableOffset + i * 4, 0x02000000 + text);
    const enc = encode(name);
    bytes.set(enc, SEG2 + text);
    text += enc.length;
  });
  return bytes;
}

/** 97 names: "C<course> ACT <n>" for the 90 acts, then 7 extras. */
function vanillaShapedNames(): string[] {
  const names: string[] = [];
  for (let course = 1; course <= 15; course++) {
    for (let act = 1; act <= 6; act++) names.push(`C${course} ACT ${act}`);
  }
  for (let i = 0; i < 7; i++) names.push(i === 0 ? "ONE OF THE CASTLE'S SECRET STARS!" : "");
  return names;
}

describe("decodeText", () => {
  it("decodes the dialog charset up to the terminator", () => {
    const bytes = new Uint8Array(64);
    bytes.set([0x0b, 0x12, 0x10, 0x9e, 0x0b, 0x18, 0x0b, 0x9f, 0x18, 0x16, 0x0b, 0xf2, 0xff]);
    expect(decodeText(new Ram(bytes), 0x80000000)).toBe("BIG BOB-OMB!");
  });

  it("expands the multi-letter glyphs and flattens line breaks", () => {
    const bytes = new Uint8Array(64);
    // "to" + <the> + newline + "top" (0xD1 is one glyph that reads "the")
    bytes.set([0x37, 0x32, 0x9e, 0xd1, 0xfe, 0x37, 0x32, 0x33, 0xff]);
    expect(decodeText(new Ram(bytes), 0x80000000)).toBe("to the top");
  });

  it("gives up on something that never terminates", () => {
    const bytes = new Uint8Array(256).fill(0x0a);
    expect(decodeText(new Ram(bytes), 0x80000000)).toBeNull();
    expect(decodeText(new Ram(bytes), 0x800000f0)).toBeNull(); // runs off the end
  });
});

describe("readStarNames", () => {
  it("reads the act names at the US table address", () => {
    const names = readStarNames(image(vanillaShapedNames(), 0x1192c));
    expect(names).not.toBeNull();
    expect(names!.tableAddr).toBe(0x0201192c);
    expect(names!.actName(1, 0)).toBe("C1 ACT 1");
    expect(names!.actName(15, 4)).toBe("C15 ACT 5");
    expect(names!.actName(8, 5)).toBe("C8 ACT 6");
  });

  it("has no name outside the 15 main courses' six acts", () => {
    const names = readStarNames(image(vanillaShapedNames(), 0x1192c))!;
    expect(names.actName(1, 6)).toBeNull(); // 100-coin star
    expect(names.actName(0, 0)).toBeNull(); // castle
    expect(names.actName(16, 0)).toBeNull(); // a Bowser course
    expect(names.actName(15, 7)).toBeNull();
    expect(names.actName(1.5, 0)).toBeNull();
  });

  it("finds a table that a text tool moved", () => {
    const names = readStarNames(image(vanillaShapedNames(), 0x20000));
    expect(names).not.toBeNull();
    expect(names!.tableAddr).toBe(0x02020000);
    expect(names!.actName(3, 2)).toBe("C3 ACT 3");
  });

  it("reports an empty name as no name", () => {
    const list = vanillaShapedNames();
    list[7] = ""; // course 2, act 2
    expect(readStarNames(image(list, 0x1192c))!.actName(2, 1)).toBeNull();
  });

  it("returns null when there is no table", () => {
    const bytes = new Uint8Array(RAM_SIZE);
    new DataView(bytes.buffer).setUint32((US_SEGMENT_TABLE & 0x1fffffff) + 8, SEG2);
    expect(readStarNames(bytes)).toBeNull();
    expect(readStarNames(new Uint8Array(16))).toBeNull(); // not a snapshot at all
  });

  it("isn't fooled by 97 pointers into data that isn't text", () => {
    const bytes = new Uint8Array(RAM_SIZE);
    const dv = new DataView(bytes.buffer);
    dv.setUint32((US_SEGMENT_TABLE & 0x1fffffff) + 8, SEG2);
    // Pointers to bytes with no glyph (0x4x, 0x7x...), each "terminated".
    for (let i = 0; i < 97; i++) {
      dv.setUint32(SEG2 + 0x1192c + i * 4, 0x02030000 + i * 8);
      bytes.set([0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x76, 0xff], SEG2 + 0x30000 + i * 8);
    }
    expect(readStarNames(bytes)).toBeNull();
  });
});
