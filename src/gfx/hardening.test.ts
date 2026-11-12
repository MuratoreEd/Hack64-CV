import { describe, it, expect } from "vitest";
import { Ram } from "./ram";
import { decodeTexture } from "./texture";
import { collectAreaDisplayLists, findBackgroundNode, US_GCURRENT_AREA } from "./graph";
import { buildLevelModel } from "./level";
import { interpretDisplayList, type GfxBatch } from "./f3d";
import type { DecodedTexture } from "./texture";

describe("decodeTexture", () => {
  const ram = new Ram(new Uint8Array(0x10000));

  it("decodes an integer-sized RGBA16 tile", () => {
    const t = decodeTexture(ram, 0x80000100, 0, 2, 32, 32, 0, 0);
    expect(t?.rgba.length).toBe(32 * 32 * 4);
  });

  it("refuses a fractional size rather than building a lopsided buffer", () => {
    expect(decodeTexture(ram, 0x80000100, 0, 2, 32.25, 32, 0, 0)).toBeNull();
    expect(decodeTexture(ram, 0x80000100, 0, 2, 32, 15.5, 0, 0)).toBeNull();
    expect(decodeTexture(ram, 0x80000100, 0, 2, NaN, 32, 0, 0)).toBeNull();
  });
});

describe("G_SETTILESIZE", () => {
  it("drops the 10.2 fraction like the RDP, so sizes stay whole", () => {
    // Tile rect lrs = 0x7d (31.25 texels) and lrt = 0x7e (31.5): the old /4
    // made a 32.25 x 32.5 "texture".
    const bytes = new Uint8Array(0x8000);
    const v = new DataView(bytes.buffer);
    const DL = 0x1000;
    const VTX = 0x2000;
    const TEX = 0x3000;
    const cmds: [number, number][] = [
      [0xbb000001, 0xffffffff], // G_TEXTURE on
      [0xfd100000, 0x80000000 + TEX], // G_SETTIMG rgba16
      [0xf5100000, 0x00000000], // G_SETTILE tile 0, rgba16
      [0xf3000000, 0x073ff000], // G_LOADBLOCK
      [0xf2000000, (0x7d << 12) | 0x7e], // G_SETTILESIZE
      [(0x04 << 24) | (2 << 20) | 48, 0x80000000 + VTX], // G_VTX 3 @ 0
      [0xbf000000, (0 << 16) | (10 << 8) | 20], // G_TRI1 0 1 2
      [0xb8000000, 0], // G_ENDDL
    ];
    cmds.forEach(([w0, w1], i) => {
      v.setUint32(DL + i * 8, w0 >>> 0);
      v.setUint32(DL + i * 8 + 4, w1 >>> 0);
    });
    [[0, 0, 0], [100, 0, 0], [0, 0, 100]].forEach(([x, y, z], i) => {
      v.setInt16(VTX + i * 16, x);
      v.setInt16(VTX + i * 16 + 2, y);
      v.setInt16(VTX + i * 16 + 4, z);
    });
    const batches = new Map<string, GfxBatch>();
    interpretDisplayList(
      new Ram(bytes), new Array(32).fill(0), 0x80000000 + DL, 1,
      batches, new Map<string, DecodedTexture | null>(),
    );
    const [batch] = [...batches.values()];
    expect(batch.texture).not.toBeNull();
    expect(batch.texture!.width).toBe(32);
    expect(batch.texture!.height).toBe(32);
  });
});

describe("area graph walk on a short snapshot", () => {
  it("reads 'no area' instead of throwing when the root pointer is past the end", () => {
    // A 4 MB snapshot whose gCurrentArea points at an Area whose graph root
    // lies in the (absent) expansion RAM: KSEG0, but not in this buffer.
    const bytes = new Uint8Array(0x400000);
    const v = new DataView(bytes.buffer);
    const area = 0x80300000;
    v.setUint32(US_GCURRENT_AREA & 0x1fffffff, area);
    v.setUint32((area & 0x1fffffff) + 4, 0x80700000);
    const ram = new Ram(bytes);
    expect(() => collectAreaDisplayLists(ram)).not.toThrow();
    expect(collectAreaDisplayLists(ram)).toBeNull();
    expect(findBackgroundNode(ram)).toBeNull();
    expect(buildLevelModel(bytes)).toBeNull();
  });
});
