// Builds Three.js meshes from parsed collision surfaces, one translucent mesh
// per kind (floor/wall/ceiling) plus wireframe edges, grouped so each kind can
// be toggled independently.

import * as THREE from "three";
import type { Surface } from "../collision/surface";
import { SurfaceKind } from "../collision/surface";
import { KIND_COLOR } from "./palette";

const KINDS: SurfaceKind[] = [
  SurfaceKind.Floor,
  SurfaceKind.Wall,
  SurfaceKind.Ceiling,
];

export interface CollisionMeshView {
  group: THREE.Group;
  counts: Record<SurfaceKind, number>;
  setKindVisible(kind: SurfaceKind, visible: boolean): void;
  dispose(): void;
}

export interface BuildOptions {
  /** Negate Z (and normal.z) to better match in-game orientation. */
  zFlip?: boolean;
  opacity?: number;
}

export function buildCollisionMesh(
  surfaces: Surface[],
  opts: BuildOptions = {},
): CollisionMeshView {
  const zs = opts.zFlip ? -1 : 1;
  const opacity = opts.opacity ?? 0.7;

  const group = new THREE.Group();
  group.name = "collision";
  const counts = {
    [SurfaceKind.Floor]: 0,
    [SurfaceKind.Wall]: 0,
    [SurfaceKind.Ceiling]: 0,
  } as Record<SurfaceKind, number>;
  const kindGroups = {} as Record<SurfaceKind, THREE.Group>;
  const disposables: Array<{ dispose(): void }> = [];

  for (const kind of KINDS) {
    const list = surfaces.filter((s) => s.kind === kind);
    counts[kind] = list.length;

    const kindGroup = new THREE.Group();
    kindGroup.name = kind;
    kindGroups[kind] = kindGroup;
    group.add(kindGroup);
    if (list.length === 0) continue;

    const positions = new Float32Array(list.length * 9);
    const normals = new Float32Array(list.length * 9);
    let p = 0;
    for (const s of list) {
      const n = s.normal;
      for (const v of s.vertices) {
        positions[p] = v[0];
        positions[p + 1] = v[1];
        positions[p + 2] = v[2] * zs;
        normals[p] = n.x;
        normals[p + 1] = n.y;
        normals[p + 2] = n.z * zs;
        p += 3;
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geom.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    disposables.push(geom);

    const mat = new THREE.MeshStandardMaterial({
      color: KIND_COLOR[kind],
      transparent: true,
      opacity,
      side: THREE.DoubleSide,
      roughness: 1,
      metalness: 0,
    });
    disposables.push(mat);
    kindGroup.add(new THREE.Mesh(geom, mat));

    const wire = new THREE.WireframeGeometry(geom);
    disposables.push(wire);
    const lineMat = new THREE.LineBasicMaterial({
      color: 0x0b0d12,
      transparent: true,
      opacity: 0.25,
    });
    disposables.push(lineMat);
    kindGroup.add(new THREE.LineSegments(wire, lineMat));
  }

  return {
    group,
    counts,
    setKindVisible(kind, visible) {
      kindGroups[kind].visible = visible;
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
