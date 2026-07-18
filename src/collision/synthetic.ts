// Synthetic collision scenes for developing the renderer/probe without a live
// emulator. `demoScene` builds a simple closed room + a ramp so all three
// surface kinds are present.

import type { Surface, Vec3s } from "./surface";
import { makeSurface } from "./geometry";

export function demoScene(): Surface[] {
  const surfaces: Surface[] = [];
  let index = 0;

  const tri = (a: Vec3s, b: Vec3s, c: Vec3s) => {
    const s = makeSurface(a, b, c, { index });
    if (s) {
      surfaces.push(s);
      index++;
    }
  };
  // Two triangles per quad, wound (a,b,c) + (a,c,d).
  const quad = (a: Vec3s, b: Vec3s, c: Vec3s, d: Vec3s) => {
    tri(a, b, c);
    tri(a, c, d);
  };

  const MIN = -2000;
  const MAX = 2000;
  const CEIL = 3000;

  // Floor (normal +Y).
  quad([MIN, 0, MAX], [MAX, 0, MAX], [MAX, 0, MIN], [MIN, 0, MIN]);
  // Ceiling (normal -Y).
  quad([MIN, CEIL, MIN], [MAX, CEIL, MIN], [MAX, CEIL, MAX], [MIN, CEIL, MAX]);
  // Four perimeter walls.
  quad([MIN, 0, MIN], [MAX, 0, MIN], [MAX, CEIL, MIN], [MIN, CEIL, MIN]); // z = MIN
  quad([MAX, 0, MAX], [MIN, 0, MAX], [MIN, CEIL, MAX], [MAX, CEIL, MAX]); // z = MAX
  quad([MIN, 0, MAX], [MIN, 0, MIN], [MIN, CEIL, MIN], [MIN, CEIL, MAX]); // x = MIN
  quad([MAX, 0, MIN], [MAX, 0, MAX], [MAX, CEIL, MAX], [MAX, CEIL, MIN]); // x = MAX
  // A ramp (walkable slope -> classified as floor).
  quad([-500, 0, -800], [500, 0, -800], [500, 1400, -1700], [-500, 1400, -1700]);

  return surfaces;
}
