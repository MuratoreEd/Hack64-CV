// Orchestrates the textured-level build: RDRAM snapshot bytes → segment table
// → area graph walk → F3D interpretation → material batches ready for THREE.

import { Ram, readSegmentTable } from "./ram";
import {
  collectAreaDisplayLists,
  findPerspectiveNode,
  type PerspectiveNode,
} from "./graph";
import {
  interpretDisplayList,
  type FogState,
  type GfxBatch,
} from "./f3d";
import type { DecodedTexture } from "./texture";
import { parseSkybox, type SkyboxImage } from "./skybox";

export interface LevelFog {
  /** Fog blend color, sRGB 0..1. */
  color: [number, number, number];
  /** Eye distance (world units) where fog starts. */
  near: number;
  /** Eye distance where fog fully saturates. */
  far: number;
}

export interface LevelModel {
  batches: GfxBatch[];
  displayLists: number;
  triangles: number;
  /** The area's sky panorama, when it has a textured skybox. */
  skybox: SkyboxImage | null;
  /** The area's fog, when any material draws with G_FOG. */
  fog: LevelFog | null;
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
  const fogState: FogState = { color: null, fm: 0, fo: 0, used: false };
  for (const dl of dls) {
    interpretDisplayList(
      ram,
      segs,
      dl.addr,
      dl.layer,
      batches,
      textureCache,
      fogState,
    );
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
    fog: buildFog(fogState, findPerspectiveNode(ram)),
  };
}

/** Convert the captured N64 fog factor into eye-space distances.
 *
 * gSPFogPosition(min, max) encodes fm = 128000/(max-min) and
 * fo = (500-min)*256/(max-min); the RSP's per-vertex fog ramps linearly in
 * NDC z from z0 = -fo/fm to z1 = (256-fo)/fm, where NDC z ∈ [-1, 1] spans
 * near→far plane. Inverting the projection gives eye distances, which is
 * what THREE.Fog wants. (THREE interpolates linearly in eye distance rather
 * than NDC z, so the ramp's shape differs slightly mid-range — endpoints
 * are exact.) */
function buildFog(f: FogState, persp: PerspectiveNode | null): LevelFog | null {
  if (!f.used || !f.color || f.fm <= 0) return null;
  const n = persp?.near ?? 100; // vanilla defaults when the frustum node
  const far = persp?.far ?? 12800; // isn't found or reads garbage
  const zToEye = (z: number): number => {
    const zc = Math.min(1, Math.max(-1, z));
    return (2 * far * n) / (far + n - zc * (far - n));
  };
  return {
    color: [f.color[0] / 255, f.color[1] / 255, f.color[2] / 255],
    near: zToEye(-f.fo / f.fm),
    far: zToEye((256 - f.fo) / f.fm),
  };
}
