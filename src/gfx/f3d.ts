// Fast3D (SM64's microcode) display-list interpreter: walks a terrain DL and
// emits triangles grouped by material (texture + sampling state). Confirmed
// against this hack's live DLs (bridge/scripts/probeGfx.ts hexdump):
//   04 G_VTX      w0 = 04 | (n-1)<<20 | v0<<16 | n*0x10 ; w1 = addr
//   bf G_TRI1     w1 bytes [_, v0*10, v1*10, v2*10]
//   06 G_DL       w0 byte1: 0 push / 1 branch ; w1 = addr
//   b8 G_ENDDL
//   fd G_SETTIMG  fmt/siz in w0, addr in w1
//   f5 G_SETTILE  render tile 0 carries fmt/siz/wrap/palette
//   f2 G_SETTILESIZE  tile dimensions (10.2 fixed)
//   f3/f4 G_LOADBLOCK/LOADTILE  bind the pending SETTIMG as the loaded texture
//   f0 G_LOADTLUT palette for CI formats
//   bb G_TEXTURE  on/off + S/T scale
//   b6/b7 geometry mode (G_LIGHTING flips vertex colors to normals)
//   03 G_MOVEMEM  0x86 = directional light (color + dir), 0x88 = ambient
//   f8 G_SETFOGCOLOR + bc G_MOVEWORD[G_MW_FOG] — fog color and fm/fo factor
// Lighting starts ON: SM64's init_rsp sets G_LIGHTING every frame, and level
// materials rely on that default (they only clear it for vertex-colored
// geometry). Under lighting the vertex color bytes are signed normals, so we
// evaluate the RSP's diffuse shade (ambient + light·max(0, n̂·l̂)) per vertex.
// Fog state is captured (last color/factor seen, plus whether any triangle was
// drawn with G_FOG set) so the viewer can reproduce it as scene fog; per-batch
// `fogged` records which materials participate. Everything else (syncs,
// combine, othermode) is ignored — the viewer approximates the common SM64
// combine (texture × shade) only.

import { Ram, resolveAddr } from "./ram";
import { decodeTexture, type DecodedTexture } from "./texture";

export type WrapMode = "repeat" | "mirror" | "clamp";

export interface GfxBatch {
  key: string;
  texture: DecodedTexture | null;
  wrapS: WrapMode;
  wrapT: WrapMode;
  layer: number;
  /** Whether this material draws with G_FOG set (participates in scene fog). */
  fogged: boolean;
  /** xyz per vertex (world units). */
  positions: number[];
  /** uv per vertex (texture units, row 0 = top). */
  uvs: number[];
  /** rgba per vertex, 0..1. */
  colors: number[];
}

/** Fog state accumulated across a level's display lists. SM64 materials set
 * one fog color + position for the whole scene (per-material variation is
 * possible in principle but unused), so last-seen wins. */
export interface FogState {
  /** RGB 0..255 from the last G_SETFOGCOLOR, or null if never set. */
  color: [number, number, number] | null;
  /** Fog factor from the last G_MW_FOG moveword: fm = 128000/(max-min),
   * fo = (500-min)*256/(max-min) per gSPFogPosition(min, max). */
  fm: number;
  fo: number;
  /** True once any triangle was emitted with G_FOG set. */
  used: boolean;
}

const G_FOG = 0x00010000;
const G_LIGHTING = 0x00020000;
const G_TEXTURE_GEN = 0x00040000;

interface Vtx {
  x: number;
  y: number;
  z: number;
  u: number;
  v: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

const WRAP: WrapMode[] = ["repeat", "mirror", "clamp", "clamp"];

/**
 * Interpret one display list, appending triangles into `batches` (shared
 * across DLs so identical materials merge into one draw). `layer` is the
 * graph-node drawing layer, kept per batch for transparency handling.
 */
export function interpretDisplayList(
  ram: Ram,
  segs: number[],
  dlAddr: number,
  layer: number,
  batches: Map<string, GfxBatch>,
  textureCache: Map<string, DecodedTexture | null>,
  fog?: FogState,
): void {
  const vtx: Vtx[] = new Array(16);

  // Texture state
  let timg = 0; // pending G_SETTIMG address (resolved)
  let loadedTimg = 0; // bound at G_LOADBLOCK/G_LOADTILE time
  let tlut = 0;
  let fmt = 0;
  let siz = 2;
  let palette = 0;
  let wrapS: WrapMode = "repeat";
  let wrapT: WrapMode = "clamp";
  let tileW = 32;
  let tileH = 32;
  let texOn = false;
  let scaleS = 0xffff;
  let scaleT = 0xffff;
  let geoMode = G_LIGHTING; // init_rsp default; materials clear it if unlit

  // Light state (G_MOVEMEM). Until a DL sets lights, shade defaults to full
  // white so untouched geometry isn't darkened.
  let ambient = [255, 255, 255];
  let lightCol = [0, 0, 0];
  let lightDir = [0, 0, 127];

  const stack: number[] = [];
  let pc = resolveAddr(dlAddr, segs);
  let steps = 0;

  const materialKey = (): string => {
    // Fog participation splits the batch: fogged and unfogged triangles need
    // different Three materials even when the texture state matches.
    const fogBit = (geoMode & G_FOG) !== 0 ? 1 : 0;
    if (!texOn || !loadedTimg || (geoMode & G_TEXTURE_GEN) !== 0) {
      return `flat:${layer}:${fogBit}`;
    }
    return `${loadedTimg}:${fmt}:${siz}:${tileW}x${tileH}:${tlut}:${palette}:${wrapS}:${wrapT}:${layer}:${fogBit}`;
  };

  const getBatch = (): GfxBatch => {
    const key = materialKey();
    let batch = batches.get(key);
    if (batch) return batch;
    let texture: DecodedTexture | null = null;
    if (!key.startsWith("flat:")) {
      if (!textureCache.has(key)) {
        textureCache.set(
          key,
          decodeTexture(ram, loadedTimg, fmt, siz, tileW, tileH, tlut, palette),
        );
      }
      texture = textureCache.get(key) ?? null;
    }
    batch = {
      key,
      texture,
      wrapS,
      wrapT,
      layer,
      fogged: (geoMode & G_FOG) !== 0,
      positions: [],
      uvs: [],
      colors: [],
    };
    batches.set(key, batch);
    return batch;
  };

  const emitTri = (i0: number, i1: number, i2: number): void => {
    const batch = getBatch();
    if (fog && batch.fogged) fog.used = true;
    for (const i of [i0, i1, i2]) {
      const v = vtx[i];
      if (!v) return;
      batch.positions.push(v.x, v.y, v.z);
      if (batch.texture) {
        // s/t are 10.5 fixed texels; G_TEXTURE scale is /0x10000.
        const sPx = (v.u * (scaleS / 0x10000)) / 32;
        const tPx = (v.v * (scaleT / 0x10000)) / 32;
        batch.uvs.push(sPx / batch.texture.width, tPx / batch.texture.height);
      } else {
        batch.uvs.push(0, 0);
      }
      batch.colors.push(v.r / 255, v.g / 255, v.b / 255, v.a / 255);
    }
  };

  while (ram.ok(pc, 8) && steps++ < 200000) {
    const w0 = ram.u32(pc);
    const w1 = ram.u32(pc + 4);
    pc += 8;
    const op = w0 >>> 24;

    switch (op) {
      case 0x04: {
        // G_VTX
        const n = ((w0 >>> 20) & 0xf) + 1;
        const v0 = (w0 >>> 16) & 0xf;
        const addr = resolveAddr(w1, segs);
        if (!ram.ok(addr, n * 0x10)) break;
        const lit = (geoMode & G_LIGHTING) !== 0;
        for (let i = 0; i < n && v0 + i < 16; i++) {
          const a = addr + i * 0x10;
          let r = ram.u8(a + 12);
          let g = ram.u8(a + 13);
          let b = ram.u8(a + 14);
          if (lit) {
            // Bytes 12-14 are a signed normal; diffuse-shade it against the
            // current light (both vectors normalized, backfacing clamped to 0).
            const s8 = (v: number): number => (v << 24) >> 24;
            const nx = s8(r);
            const ny = s8(g);
            const nz = s8(b);
            const nLen = Math.hypot(nx, ny, nz) || 1;
            const lLen = Math.hypot(lightDir[0], lightDir[1], lightDir[2]) || 1;
            const t = Math.max(
              0,
              (nx * lightDir[0] + ny * lightDir[1] + nz * lightDir[2]) /
                (nLen * lLen),
            );
            r = Math.min(255, ambient[0] + lightCol[0] * t);
            g = Math.min(255, ambient[1] + lightCol[1] * t);
            b = Math.min(255, ambient[2] + lightCol[2] * t);
          }
          vtx[v0 + i] = {
            x: ram.s16(a),
            y: ram.s16(a + 2),
            z: ram.s16(a + 4),
            u: ram.s16(a + 8),
            v: ram.s16(a + 10),
            r,
            g,
            b,
            a: ram.u8(a + 15),
          };
        }
        break;
      }
      case 0xbf: // G_TRI1 (indices premultiplied by 10)
        emitTri(
          ((w1 >>> 16) & 0xff) / 10,
          ((w1 >>> 8) & 0xff) / 10,
          (w1 & 0xff) / 10,
        );
        break;
      case 0x06: // G_DL
        if (((w0 >>> 16) & 0xff) === 0) stack.push(pc);
        pc = resolveAddr(w1, segs);
        break;
      case 0xb8: {
        // G_ENDDL
        const ret = stack.pop();
        if (ret === undefined) return;
        pc = ret;
        break;
      }
      case 0xfd: // G_SETTIMG
        timg = resolveAddr(w1, segs);
        break;
      case 0xf3: // G_LOADBLOCK
      case 0xf4: // G_LOADTILE
        loadedTimg = timg;
        break;
      case 0xf0: // G_LOADTLUT
        tlut = timg;
        break;
      case 0xf5: {
        // G_SETTILE — only the render tile (0) drives sampling state
        const tile = (w1 >>> 24) & 0x7;
        if (tile === 0) {
          fmt = (w0 >>> 21) & 0x7;
          siz = (w0 >>> 19) & 0x3;
          palette = (w1 >>> 20) & 0xf;
          wrapT = WRAP[(w1 >>> 18) & 0x3];
          wrapS = WRAP[(w1 >>> 8) & 0x3];
        }
        break;
      }
      case 0xf2: {
        // G_SETTILESIZE (10.2 fixed texel coords)
        const tile = (w1 >>> 24) & 0x7;
        if (tile === 0) {
          const uls = (w0 >>> 12) & 0xfff;
          const ult = w0 & 0xfff;
          tileW = (((w1 >>> 12) & 0xfff) - uls) / 4 + 1;
          tileH = ((w1 & 0xfff) - ult) / 4 + 1;
        }
        break;
      }
      case 0xbb: // G_TEXTURE
        texOn = (w0 & 0xff) !== 0;
        scaleS = (w1 >>> 16) & 0xffff;
        scaleT = w1 & 0xffff;
        break;
      case 0x03: {
        // G_MOVEMEM: gsSPSetLights1 loads the directional light at index 0x86
        // (Light_t: color u8×3 @0, dir s8×3 @8) and the ambient at 0x88
        // (color u8×3 @0). SM64 areas use exactly one directional light.
        const index = (w0 >>> 16) & 0xff;
        const addr = resolveAddr(w1, segs);
        if (!ram.ok(addr, 12)) break;
        if (index === 0x86) {
          lightCol = [ram.u8(addr), ram.u8(addr + 1), ram.u8(addr + 2)];
          const s8 = (v: number): number => (v << 24) >> 24;
          lightDir = [
            s8(ram.u8(addr + 8)),
            s8(ram.u8(addr + 9)),
            s8(ram.u8(addr + 10)),
          ];
        } else if (index === 0x88) {
          ambient = [ram.u8(addr), ram.u8(addr + 1), ram.u8(addr + 2)];
        }
        break;
      }
      case 0xb7: // G_SETGEOMETRYMODE
        geoMode |= w1;
        break;
      case 0xb6: // G_CLEARGEOMETRYMODE
        geoMode &= ~w1;
        break;
      case 0xf8: // G_SETFOGCOLOR (rgba packed in w1)
        if (fog) {
          fog.color = [(w1 >>> 24) & 0xff, (w1 >>> 16) & 0xff, (w1 >>> 8) & 0xff];
        }
        break;
      case 0xbc: {
        // G_MOVEWORD (F3D: index in the LOW 16 bits, offset in bits 16-23 —
        // gSPPerspNormalize's famous BC00000E has G_MW_PERSPNORM=0x0E low).
        // G_MW_FOG=0x08 @ offset 0 carries (fm << 16) | (fo & 0xffff);
        // fo is signed (negative for the usual 900..1000 range). Confirmed
        // live: bc000008:0b1cf5e4 = fogPosition(955, 1000).
        const index = w0 & 0xffff;
        if (fog && index === 0x08 && ((w0 >>> 16) & 0xff) === 0) {
          fog.fm = (w1 >>> 16) & 0xffff;
          fog.fo = ((w1 & 0xffff) << 16) >> 16;
        }
        break;
      }
      default:
        break; // syncs, combine, othermode: ignored
    }
  }
}
