import { describe, it, expect } from "vitest";
import { Ram } from "./ram";
import { interpretDisplayList, type GfxBatch } from "./f3d";
import type { DecodedTexture } from "./texture";

// A tiny RDRAM image: a display list at 0x80001000 and a vertex buffer at
// 0x80002000, addressed virtually (segment table unused).
const DL = 0x1000;
const VTX = 0x2000;

function run(commands: [number, number][], verts: [number, number, number][]): GfxBatch[] {
  const bytes = new Uint8Array(0x4000);
  const v = new DataView(bytes.buffer);
  commands.forEach(([w0, w1], i) => {
    v.setUint32(DL + i * 8, w0 >>> 0);
    v.setUint32(DL + i * 8 + 4, w1 >>> 0);
  });
  verts.forEach(([x, y, z], i) => {
    v.setInt16(VTX + i * 16, x);
    v.setInt16(VTX + i * 16 + 2, y);
    v.setInt16(VTX + i * 16 + 4, z);
    v.setUint8(VTX + i * 16 + 13, 127); // a +y normal under lighting
    v.setUint8(VTX + i * 16 + 15, 255);
  });
  const batches = new Map<string, GfxBatch>();
  interpretDisplayList(
    new Ram(bytes), new Array(32).fill(0), 0x80000000 + DL, 1,
    batches, new Map<string, DecodedTexture | null>(),
  );
  return [...batches.values()];
}

const G_VTX = (n: number, v0: number, addr: number): [number, number] =>
  [(0x04 << 24) | ((n - 1) << 20) | (v0 << 16) | (n * 16), 0x80000000 + addr];
const G_TRI1 = (a: number, b: number, c: number): [number, number] =>
  [0xbf << 24, ((a * 10) << 16) | ((b * 10) << 8) | (c * 10)];
const G_ENDDL: [number, number] = [0xb8 << 24, 0];

describe("interpretDisplayList", () => {
  it("emits a triangle's three vertices", () => {
    const [batch] = run(
      [G_VTX(3, 0, VTX), G_TRI1(0, 1, 2), G_ENDDL],
      [[0, 0, 0], [100, 0, 0], [0, 0, 100]],
    );
    expect(batch.positions).toEqual([0, 0, 0, 100, 0, 0, 0, 0, 100]);
  });

  it("drops a triangle that references an unloaded slot, whole", () => {
    // Slot 5 was never loaded. Pushing the first two vertices before noticing
    // left the batch one-and-a-bit triangles long, skewing every later one.
    const [batch] = run(
      [G_VTX(3, 0, VTX), G_TRI1(0, 1, 5), G_TRI1(0, 1, 2), G_ENDDL],
      [[0, 0, 0], [100, 0, 0], [0, 0, 100]],
    );
    expect(batch.positions).toEqual([0, 0, 0, 100, 0, 0, 0, 0, 100]);
    expect(batch.uvs.length).toBe(6);
    expect(batch.colors.length).toBe(12);
  });
});
