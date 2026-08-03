// The inverse of parseSurfacePool: write surfaces back out as a raw pool in the
// game's own byte layout.
//
// The corpus stores pool BYTES, so synthetic fixtures have to become bytes too
// — otherwise the fixture would enter the pipeline a step later than real
// captures and wouldn't exercise the parse. Not used by the app itself.

import type { Surface } from "./surface";
import { SURFACE_STRUCT_SIZE, SURFACE_OFFSETS } from "./constants";

/** Serialize surfaces into a canonical big-endian surface pool. Round-trips
 * through parseSurfacePool (see surfaceEncode.test.ts) except for `kind` and
 * `xProjection`, which the parser derives rather than stores. */
export function encodeSurfacePool(surfaces: readonly Surface[]): ArrayBuffer {
  const buf = new ArrayBuffer(surfaces.length * SURFACE_STRUCT_SIZE);
  const view = new DataView(buf);
  const o = SURFACE_OFFSETS;
  surfaces.forEach((s, i) => {
    const at = i * SURFACE_STRUCT_SIZE;
    view.setInt16(at + o.type, s.type);
    view.setInt16(at + o.force, s.force);
    view.setUint8(at + o.flags, s.flags & 0xff);
    view.setInt8(at + o.room, s.room);
    view.setInt16(at + o.lowerY, s.lowerY);
    view.setInt16(at + o.upperY, s.upperY);
    const vOff = [o.vertex1, o.vertex2, o.vertex3];
    s.vertices.forEach((v, vi) => {
      view.setInt16(at + vOff[vi], v[0]);
      view.setInt16(at + vOff[vi] + 2, v[1]);
      view.setInt16(at + vOff[vi] + 4, v[2]);
    });
    view.setFloat32(at + o.normalX, s.normal.x);
    view.setFloat32(at + o.normalY, s.normal.y);
    view.setFloat32(at + o.normalZ, s.normal.z);
    view.setFloat32(at + o.originOffset, s.originOffset);
    view.setUint32(at + o.object, s.object >>> 0);
  });
  return buf;
}
