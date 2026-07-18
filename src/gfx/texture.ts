// N64 texture format decoders → RGBA8. Formats/sizes follow the RDP SETTIMG
// encoding: fmt 0=RGBA 2=CI 3=IA 4=I; siz 0=4bpp 1=8bpp 2=16bpp 3=32bpp.
// CI formats index a TLUT of RGBA16 entries (loaded via G_LOADTLUT).

import { Ram } from "./ram";

export interface DecodedTexture {
  width: number;
  height: number;
  /** RGBA8, width*height*4 bytes, row 0 = top. (Concretely ArrayBuffer-backed
   * so it can feed THREE.DataTexture without casts.) */
  rgba: Uint8Array<ArrayBuffer>;
}

/** Expand a 5-bit channel to 8 bits. */
const c5 = (v: number): number => (v << 3) | (v >> 2);

function rgba16(v: number, out: Uint8Array, o: number): void {
  out[o] = c5((v >> 11) & 31);
  out[o + 1] = c5((v >> 6) & 31);
  out[o + 2] = c5((v >> 1) & 31);
  out[o + 3] = (v & 1) * 255;
}

/**
 * Decode `w`×`h` texels at KSEG0 `addr`. `tlutAddr` is required for CI
 * formats (16 entries for CI4 at palette*16, 256 for CI8). Returns null when
 * the data lies outside the snapshot or the format is unsupported.
 */
export function decodeTexture(
  ram: Ram,
  addr: number,
  fmt: number,
  siz: number,
  w: number,
  h: number,
  tlutAddr: number,
  palette: number,
): DecodedTexture | null {
  if (w <= 0 || h <= 0 || w > 1024 || h > 1024) return null;
  const texels = w * h;
  const bits = 4 << siz; // siz 0..3 -> 4/8/16/32 bpp
  if (!ram.ok(addr, (texels * bits) / 8)) return null;
  const rgba = new Uint8Array(texels * 4);

  if (fmt === 0 && siz === 2) {
    // RGBA16
    for (let i = 0; i < texels; i++) rgba16(ram.u16(addr + i * 2), rgba, i * 4);
  } else if (fmt === 0 && siz === 3) {
    // RGBA32
    for (let i = 0; i < texels; i++) {
      const v = ram.u32(addr + i * 4);
      rgba[i * 4] = (v >>> 24) & 0xff;
      rgba[i * 4 + 1] = (v >>> 16) & 0xff;
      rgba[i * 4 + 2] = (v >>> 8) & 0xff;
      rgba[i * 4 + 3] = v & 0xff;
    }
  } else if (fmt === 2 && siz === 1) {
    // CI8 -> TLUT
    if (!ram.ok(tlutAddr, 256 * 2)) return null;
    for (let i = 0; i < texels; i++) {
      rgba16(ram.u16(tlutAddr + ram.u8(addr + i) * 2), rgba, i * 4);
    }
  } else if (fmt === 2 && siz === 0) {
    // CI4 -> TLUT (16 entries at palette*16)
    const base = tlutAddr + palette * 16 * 2;
    if (!ram.ok(base, 16 * 2)) return null;
    for (let i = 0; i < texels; i++) {
      const b = ram.u8(addr + (i >> 1));
      const idx = i & 1 ? b & 0xf : b >> 4;
      rgba16(ram.u16(base + idx * 2), rgba, i * 4);
    }
  } else if (fmt === 3 && siz === 2) {
    // IA16: intensity byte + alpha byte
    for (let i = 0; i < texels; i++) {
      const v = ram.u16(addr + i * 2);
      const int = v >> 8;
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = int;
      rgba[i * 4 + 3] = v & 0xff;
    }
  } else if (fmt === 3 && siz === 1) {
    // IA8: 4-bit intensity, 4-bit alpha
    for (let i = 0; i < texels; i++) {
      const v = ram.u8(addr + i);
      const int = (v >> 4) * 17;
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = int;
      rgba[i * 4 + 3] = (v & 0xf) * 17;
    }
  } else if (fmt === 3 && siz === 0) {
    // IA4: 3-bit intensity, 1-bit alpha
    for (let i = 0; i < texels; i++) {
      const b = ram.u8(addr + (i >> 1));
      const v = i & 1 ? b & 0xf : b >> 4;
      const int = Math.round(((v >> 1) * 255) / 7);
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = int;
      rgba[i * 4 + 3] = (v & 1) * 255;
    }
  } else if (fmt === 4 && siz === 1) {
    // I8
    for (let i = 0; i < texels; i++) {
      const v = ram.u8(addr + i);
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = v;
    }
  } else if (fmt === 4 && siz === 0) {
    // I4
    for (let i = 0; i < texels; i++) {
      const b = ram.u8(addr + (i >> 1));
      const v = (i & 1 ? b & 0xf : b >> 4) * 17;
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = v;
    }
  } else {
    return null; // YUV / exotic combos: not used by SM64 terrain
  }
  return { width: w, height: h, rgba };
}
