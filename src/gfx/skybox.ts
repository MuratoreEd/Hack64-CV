// Skybox reconstruction from RDRAM. SM64 skies are 248×248 panoramas split by
// skyconv into 64 unique 32×32 RGBA16 tiles (31 effective px each, 1 px of
// overlap baked into neighbors). The loaded sky lives in segment 0x0A: 64 tile
// bitmaps followed by an 80-entry pointer table — 8 rows × 10 columns, where
// columns 8/9 duplicate columns 0/1 so the in-game mesh can wrap horizontally.
// The panorama covers 360° of yaw; the game scrolls a camera-facing window of
// it (skybox.c). The area's GEO_BACKGROUND node distinguishes a textured sky
// (fnNode.func = geo_skybox_main) from a solid fill color (func = 0).
//
// Layout validated live against the hack (bridge/scripts/probeSkybox.ts):
// table at segment offset 0x20000, 64 distinct tile pointers, wrap columns
// matching. A bounded scan backs up the fixed offset in case a custom build
// packs the segment differently.

import { Ram, resolveAddr } from "./ram";
import { findBackgroundNode } from "./graph";
import { decodeTexture } from "./texture";

const TILE = 32; // stored tile size (px)
const EFF = 31; // effective (non-overlapping) px per tile
const COLS = 8; // unique tile grid
const ROWS = 8;
const TABLE_ENTRIES = 80; // 8 rows × 10 cols (2 wrap duplicates per row)

export interface SkyboxImage {
  width: number;
  height: number;
  /** RGBA8, bottom row first (WebGL convention — feed straight to a texture
   * with flipY left off). Fully opaque. */
  rgba: Uint8Array<ArrayBuffer>;
  /** Average colors of the panorama's top/bottom pixel rows, 0..1 RGB — for
   * capping the sky above/below the textured band. */
  topColor: [number, number, number];
  bottomColor: [number, number, number];
}

/** True when `base` holds a plausible 80-entry skybox tile table: every entry
 * 0x0A-segmented, and each row's columns 8/9 duplicating columns 0/1. */
function validTable(ram: Ram, base: number): boolean {
  if (!ram.ok(base, TABLE_ENTRIES * 4)) return false;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < 10; c++) {
      if (ram.u32(base + (r * 10 + c) * 4) >>> 24 !== 0x0a) return false;
    }
    if (ram.u32(base + (r * 10 + 8) * 4) !== ram.u32(base + r * 10 * 4)) return false;
    if (ram.u32(base + (r * 10 + 9) * 4) !== ram.u32(base + (r * 10 + 1) * 4)) return false;
  }
  return true;
}

/** Reconstruct the currently loaded skybox panorama, or null when the area has
 * no textured sky (solid-color background, title screen, missing segment). */
export function parseSkybox(ram: Ram, segs: number[]): SkyboxImage | null {
  const bg = findBackgroundNode(ram);
  if (!bg || bg.func === 0) return null; // solid color or no background
  const segBase = segs[0x0a];
  if (!segBase) return null;
  const segVirt = 0x80000000 + segBase;

  // Standard skyconv layout puts the table right after 64×0x800 tile bytes.
  let table = segVirt + 0x20000;
  if (!validTable(ram, table)) {
    let found = -1;
    for (let off = 0; off < 0x40000; off += 8) {
      if (validTable(ram, segVirt + off)) {
        found = off;
        break;
      }
    }
    if (found < 0) return null;
    table = segVirt + found;
  }

  const width = COLS * EFF;
  const height = ROWS * EFF;
  const rgba = new Uint8Array(width * height * 4);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const ptr = ram.u32(table + (r * 10 + c) * 4);
      const tile = decodeTexture(ram, resolveAddr(ptr, segs), 0, 2, TILE, TILE, 0, 0);
      if (!tile) return null;
      for (let py = 0; py < EFF; py++) {
        const imgY = r * EFF + py; // 0 = top of the panorama
        const outY = height - 1 - imgY; // stored bottom-first
        for (let px = 0; px < EFF; px++) {
          const src = (py * TILE + px) * 4;
          const dst = (outY * width + c * EFF + px) * 4;
          rgba[dst] = tile.rgba[src];
          rgba[dst + 1] = tile.rgba[src + 1];
          rgba[dst + 2] = tile.rgba[src + 2];
          rgba[dst + 3] = 255; // sky is opaque regardless of the alpha bit
        }
      }
    }
  }

  const rowAvg = (outY: number): [number, number, number] => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let x = 0; x < width; x++) {
      const o = (outY * width + x) * 4;
      r += rgba[o];
      g += rgba[o + 1];
      b += rgba[o + 2];
    }
    const n = width * 255;
    return [r / n, g / n, b / n];
  };

  return {
    width,
    height,
    rgba,
    topColor: rowAvg(height - 1), // stored bottom-first: last row = image top
    bottomColor: rowAvg(0),
  };
}
