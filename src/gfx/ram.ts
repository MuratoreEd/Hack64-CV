// Big-endian reads over a canonical RDRAM snapshot, plus segmented-address
// resolution via the game's live segment table. Pure TS (no DOM/THREE) so the
// F3D interpreter can be unit-tested and reused from Node scripts.

/** US address of sSegmentTable (uintptr_t[32] of physical offsets) —
 * validated live against the running hack (bridge/scripts/probeGfx.ts). */
export const US_SEGMENT_TABLE = 0x8033b400;

const RDRAM_MASK = 0x1fffffff;

export class Ram {
  private dv: DataView;

  constructor(readonly bytes: Uint8Array) {
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** KSEG0/KSEG1 virtual → snapshot offset. */
  private off(addr: number): number {
    return (addr & RDRAM_MASK) >>> 0;
  }

  /** Whether [addr, addr+len) lies inside the snapshot. */
  ok(addr: number, len = 1): boolean {
    const o = this.off(addr);
    return o + len <= this.bytes.length;
  }

  u8(addr: number): number {
    return this.dv.getUint8(this.off(addr));
  }
  s8(addr: number): number {
    return this.dv.getInt8(this.off(addr));
  }
  u16(addr: number): number {
    return this.dv.getUint16(this.off(addr));
  }
  s16(addr: number): number {
    return this.dv.getInt16(this.off(addr));
  }
  u32(addr: number): number {
    return this.dv.getUint32(this.off(addr)) >>> 0;
  }
  f32(addr: number): number {
    return this.dv.getFloat32(this.off(addr));
  }
}

/** The game's segment table: 32 physical base offsets. */
export function readSegmentTable(ram: Ram): number[] {
  const segs: number[] = [];
  for (let i = 0; i < 32; i++) segs.push(ram.u32(US_SEGMENT_TABLE + i * 4));
  return segs;
}

/** Segmented (0xSSxxxxxx) or virtual (0x80xxxxxx) address → KSEG0 virtual.
 * Mirrors the game's segmented_to_virtual. */
export function resolveAddr(addr: number, segs: number[]): number {
  if (addr >>> 24 >= 0x80) return addr >>> 0;
  const seg = (addr >>> 24) & 0x1f;
  return (0x80000000 + segs[seg] + (addr & 0xffffff)) >>> 0;
}
