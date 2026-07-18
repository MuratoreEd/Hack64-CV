// Walk the current area's graph-node tree in RDRAM and collect the static
// terrain display lists. Node layouts from decomp include/types.h:
//   struct GraphNode { s16 type; s16 flags; prev; next; parent; children; }
// (0x14 bytes; children is a circular doubly-linked list via `next`).
// Display-list-carrying node types store the DL pointer at +0x14 — but ONLY
// non-functional types (0x100 flag types keep a function pointer there).
//
// Validated live (bridge/scripts/probeGfx.ts): this hack's terrain is plain
// GRAPH_NODE_TYPE_DISPLAY_LIST (0x1b) nodes under the area root.

import { Ram } from "./ram";

/** US address of gCurrentArea (struct Area*) — validated live; the Area's
 * GraphNodeRoot pointer sits at +0x04. (The gAreas array candidate at
 * 0x8033a090 read garbage — do not use it.) */
export const US_GCURRENT_AREA = 0x8032ddcc;

const KSEG0 = (a: number): boolean => a >= 0x80000000 && a < 0x80800000;

// Non-functional node types whose struct carries a display list at +0x14.
const DL_TYPES = new Set([
  0x015, // TRANSLATION_ROTATION
  0x016, // TRANSLATION
  0x017, // ROTATION
  0x019, // ANIMATED_PART
  0x01a, // BILLBOARD
  0x01b, // DISPLAY_LIST
  0x01c, // SCALE
]);

const TYPE_OBJECT = 0x018;
// GRAPH_NODE_TYPE_BACKGROUND = 0x02C | GRAPH_NODE_TYPE_FUNCTIONAL (0x100).
const TYPE_BACKGROUND = 0x12c;

export interface AreaDisplayList {
  /** DL address as stored (may be segmented 0xSSxxxxxx). */
  addr: number;
  /** Drawing layer (flags >> 8): 1-3 opaque/decal, 4 alpha, 5+ transparent. */
  layer: number;
}

/** Collect the terrain display lists of the currently loaded area. Objects
 * (type 0x018) are skipped — they move every frame and have their own models —
 * as are functional nodes (backgrounds, generated lists). Returns null when
 * the snapshot doesn't contain a loaded area. */
export function collectAreaDisplayLists(ram: Ram): AreaDisplayList[] | null {
  if (!ram.ok(US_GCURRENT_AREA, 4)) return null;
  const areaPtr = ram.u32(US_GCURRENT_AREA);
  if (!KSEG0(areaPtr) || !ram.ok(areaPtr, 0x3c)) return null;
  const root = ram.u32(areaPtr + 4);
  if (!KSEG0(root) || (ram.s16(root) & 0xffff) !== 0x001) return null;

  const out: AreaDisplayList[] = [];
  const visited = new Set<number>();

  const walk = (node: number, depth: number): void => {
    if (!KSEG0(node) || !ram.ok(node, 0x18)) return;
    if (visited.has(node) || visited.size > 20000 || depth > 40) return;
    visited.add(node);

    const type = ram.s16(node) & 0xffff;
    const flags = ram.s16(node + 2) & 0xffff;
    if (type === TYPE_OBJECT) return; // dynamic objects: not terrain

    if (DL_TYPES.has(type)) {
      const dl = ram.u32(node + 0x14);
      if (dl !== 0) out.push({ addr: dl, layer: (flags >> 8) & 0xff });
    }

    const first = ram.u32(node + 0x10); // children
    if (!KSEG0(first)) return;
    let child = first;
    for (let i = 0; i < 1024; i++) {
      walk(child, depth + 1);
      child = ram.u32(child + 8); // next sibling (circular)
      if (child === first || !KSEG0(child)) break;
    }
  };
  walk(root, 0);
  return out;
}

export interface BackgroundNode {
  /** GraphNodeFunc (geo_skybox_main for textured skies; 0 = solid color). */
  func: number;
  /** Skybox id when func is set, else an RGBA5551 fill color. */
  background: number;
}

/** Find the area's GEO_BACKGROUND node (struct GraphNodeBackground: FnGraphNode
 * at +0x14, s32 background at +0x18). Returns null when the snapshot has no
 * loaded area or the graph carries no background node. */
export function findBackgroundNode(ram: Ram): BackgroundNode | null {
  if (!ram.ok(US_GCURRENT_AREA, 4)) return null;
  const areaPtr = ram.u32(US_GCURRENT_AREA);
  if (!KSEG0(areaPtr) || !ram.ok(areaPtr, 0x3c)) return null;
  const root = ram.u32(areaPtr + 4);
  if (!KSEG0(root) || (ram.s16(root) & 0xffff) !== 0x001) return null;

  const visited = new Set<number>();
  const walk = (node: number, depth: number): BackgroundNode | null => {
    if (!KSEG0(node) || !ram.ok(node, 0x1c)) return null;
    if (visited.has(node) || visited.size > 20000 || depth > 40) return null;
    visited.add(node);
    const type = ram.s16(node) & 0xffff;
    if (type === TYPE_BACKGROUND) {
      return { func: ram.u32(node + 0x14), background: ram.u32(node + 0x18) };
    }
    if (type === TYPE_OBJECT) return null;
    const first = ram.u32(node + 0x10);
    if (!KSEG0(first)) return null;
    let child = first;
    for (let i = 0; i < 1024; i++) {
      const found = walk(child, depth + 1);
      if (found) return found;
      child = ram.u32(child + 8);
      if (child === first || !KSEG0(child)) break;
    }
    return null;
  };
  return walk(root, 0);
}
