import { SurfaceKind } from "../collision/surface";
import type { InvisibleWallKind } from "../probe/invisibleWalls";

/** Base colors for each collision surface kind (0xRRGGBB). */
export const KIND_COLOR: Record<SurfaceKind, number> = {
  [SurfaceKind.Floor]: 0x4c9aff, // blue
  [SurfaceKind.Wall]: 0xff7043, // orange
  [SurfaceKind.Ceiling]: 0xab8bff, // purple
};

/** Distinct highlight color per invisible-wall kind, so the overlay and the
 * legend read the same. Kept vivid against the dark collision mesh. */
export const ANOMALY_KIND_COLOR: Record<InvisibleWallKind, number> = {
  "exposed-ceiling": 0xff2d6f, // magenta-red — blocked above a ceiling
  "out-of-bounds": 0x36d6e0, // cyan — no geometry below (truncation crack)
};

/** Human-readable labels for the legend/inspector. */
export const ANOMALY_KIND_LABEL: Record<InvisibleWallKind, string> = {
  "exposed-ceiling": "exposed ceiling",
  "out-of-bounds": "out of bounds",
};

/** Order the anomaly kinds appear in the legend. */
export const ANOMALY_KINDS: InvisibleWallKind[] = [
  "exposed-ceiling",
  "out-of-bounds",
];

/** Back-compat single color (used where a kind isn't known). */
export const ANOMALY_COLOR = ANOMALY_KIND_COLOR["exposed-ceiling"];
