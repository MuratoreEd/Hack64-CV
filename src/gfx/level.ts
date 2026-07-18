// Orchestrates the textured-level build: RDRAM snapshot bytes → segment table
// → area graph walk → F3D interpretation → material batches ready for THREE.

import { Ram, readSegmentTable } from "./ram";
import { collectAreaDisplayLists } from "./graph";
import { interpretDisplayList, type GfxBatch } from "./f3d";
import type { DecodedTexture } from "./texture";
import { parseSkybox, type SkyboxImage } from "./skybox";

export interface LevelModel {
  batches: GfxBatch[];
  displayLists: number;
  triangles: number;
  /** The area's sky panorama, when it has a textured skybox. */
  skybox: SkyboxImage | null;
}

/** Parse the visual level geometry out of an RDRAM snapshot. Returns null when
 * no loaded area is found (e.g. title screen). */
export function buildLevelModel(rdram: Uint8Array): LevelModel | null {
  const ram = new Ram(rdram);
  const segs = readSegmentTable(ram);
  const dls = collectAreaDisplayLists(ram);
  if (!dls || dls.length === 0) return null;

  const batches = new Map<string, GfxBatch>();
  const textureCache = new Map<string, DecodedTexture | null>();
  for (const dl of dls) {
    interpretDisplayList(ram, segs, dl.addr, dl.layer, batches, textureCache);
  }

  const out = [...batches.values()].filter((b) => b.positions.length > 0);
  let triangles = 0;
  for (const b of out) triangles += b.positions.length / 9;
  if (triangles === 0) return null;
  return {
    batches: out,
    displayLists: dls.length,
    triangles,
    skybox: parseSkybox(ram, segs),
  };
}
