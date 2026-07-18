// Three.js scene wrapper: camera, WASD fly controls, lighting, helpers, and
// the live-swappable collision mesh + Mario marker.

import * as THREE from "three";
import type { Surface, LevelBounds } from "../collision/surface";
import { SurfaceKind, deriveLevelBounds } from "../collision/surface";
import { buildCollisionMesh } from "./collisionMesh";
import type { CollisionMeshView } from "./collisionMesh";
import type {
  InvisibleWallSegment,
  InvisibleWallKind,
} from "../probe/invisibleWalls";
import { ANOMALY_KIND_COLOR, ANOMALY_KINDS } from "./palette";
import type { LevelModel } from "../gfx/level";
import type { GfxBatch, WrapMode } from "../gfx/f3d";
import type { SkyboxImage } from "../gfx/skybox";

const EMPTY_COUNTS = (): Record<SurfaceKind, number> => ({
  [SurfaceKind.Floor]: 0,
  [SurfaceKind.Wall]: 0,
  [SurfaceKind.Ceiling]: 0,
});

export interface ViewerOptions {
  zFlip?: boolean;
}

export class Viewer {
  readonly scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private helpers = new THREE.Group();

  // Fly camera: WASD move, Space/C up/down, Shift fast, drag to look.
  // Orientation is yaw/pitch ("YXZ" Euler — no roll); speed scales with the
  // loaded level's size so vanilla and 4×-scale hacks both feel right.
  private keys = new Set<string>();
  private clock = new THREE.Clock();
  private flySpeed = 4000; // units/sec, overwritten by frame()
  private flySpeedScale = 1; // user multiplier from the HUD slider
  // Render-on-demand: skip the draw entirely on frames where neither the
  // camera nor the scene changed. While the camera IS moving on a high-DPI
  // screen, render at pixel ratio 1 (motion masks the softness) and restore
  // the full-resolution frame the moment it stops.
  private needsRender = true;
  private baseRatio = 1;
  private lowRes = false;
  private yaw = 0;
  private pitch = 0;
  private lastPointer: { x: number; y: number } | null = null;
  private meshView: CollisionMeshView | null = null;
  private marioMarker: THREE.Mesh | null = null;
  private zFlip: boolean;

  // Textured level model (parsed from the game's own display lists). Lives in
  // WORLD units; the scene is collision space, so the group is scaled by
  // 1/worldScale. The textured/collision toggle swaps which mesh renders —
  // the anomaly overlay stays visible in both views.
  private modelGroup: THREE.Group | null = null;
  private modelScale = 1;
  private texturedVisible = false;

  // Sky panorama parsed from the game (an inverted cylinder that follows the
  // camera, drawn first and never writing depth, so it acts as a background).
  private skyboxGroup: THREE.Group | null = null;
  private skyboxVisible = true;

  // Probe anomalies: one mesh per kind (for per-kind color + toggles + a
  // single draw call regardless of box count) grouped together, plus one
  // owning-segment entry per rendered box (a segment tiles into many boxes)
  // so a raycast face maps back to its segment. A separate highlight mesh
  // marks the picked one.
  private anomalyGroup = new THREE.Group();
  private anomalyMeshes = new Map<InvisibleWallKind, THREE.Mesh>();
  private anomalySegsByKind = new Map<InvisibleWallKind, InvisibleWallSegment[]>();
  private anomalyKindVisible = new Map<InvisibleWallKind, boolean>();
  // User-chosen overlay color per kind (HUD color pickers), overriding the
  // palette default; persists across anomaly rebuilds.
  private anomalyKindColor = new Map<InvisibleWallKind, number>();
  private anomalyHighlight: THREE.Mesh | null = null;
  private raycaster = new THREE.Raycaster();
  private pointerDown: { x: number; y: number } | null = null;
  /** Called on a click that hits (or misses) an anomaly quad. */
  onAnomalyPick: ((seg: InvisibleWallSegment | null) => void) | null = null;

  constructor(
    private container: HTMLElement,
    opts: ViewerOptions = {},
  ) {
    this.zFlip = opts.zFlip ?? false;
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;

    this.scene.background = new THREE.Color(0x12141a);

    this.camera = new THREE.PerspectiveCamera(60, w / h, 10, 500000);
    this.camera.position.set(4000, 4000, 4000);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setSize(w, h);
    this.baseRatio = Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(this.baseRatio);
    container.appendChild(this.renderer.domElement);

    this.camera.rotation.order = "YXZ";

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x40404f, 1.1));
    const dir = new THREE.DirectionalLight(0xffffff, 1.15);
    dir.position.set(1, 2, 1.5);
    this.scene.add(dir);

    this.scene.add(this.helpers);
    this.anomalyGroup.renderOrder = 2;
    this.scene.add(this.anomalyGroup);
    for (const k of ANOMALY_KINDS) {
      this.anomalyKindVisible.set(k, true);
      this.anomalyKindColor.set(k, ANOMALY_KIND_COLOR[k]);
    }

    // Mouse look + click-to-inspect: a drag rotates the view; a press that
    // moves <5px is a pick. Move/up live on window so drags survive leaving
    // the canvas.
    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointerdown", (e) => {
      this.pointerDown = { x: e.clientX, y: e.clientY };
      this.lastPointer = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener("pointermove", (e) => {
      if (!this.lastPointer) return;
      const dx = e.clientX - this.lastPointer.x;
      const dy = e.clientY - this.lastPointer.y;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      this.yaw -= dx * 0.0035;
      this.pitch = THREE.MathUtils.clamp(
        this.pitch - dy * 0.0035,
        -Math.PI / 2 + 0.02,
        Math.PI / 2 - 0.02,
      );
      this.applyLook();
    });
    window.addEventListener("pointerup", (e) => {
      this.lastPointer = null;
      const d = this.pointerDown;
      this.pointerDown = null;
      if (!d) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return; // a drag
      this.handlePick(e.clientX, e.clientY);
    });

    // Fly keys. KeyboardEvent.code keeps WASD physical on non-QWERTY layouts.
    window.addEventListener("keydown", (e) => this.onKey(e, true));
    window.addEventListener("keyup", (e) => this.onKey(e, false));
    window.addEventListener("blur", () => this.keys.clear());

    new ResizeObserver(() => this.onResize()).observe(container);
    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  setSurfaces(surfaces: Surface[]): void {
    if (this.meshView) {
      this.scene.remove(this.meshView.group);
      this.meshView.dispose();
      this.meshView = null;
    }
    this.meshView = buildCollisionMesh(surfaces, { zFlip: this.zFlip });
    this.scene.add(this.meshView.group);
    this.applyViewMode();

    const bounds = deriveLevelBounds(surfaces);
    this.rebuildHelpers(bounds);
    this.frame(bounds);
  }

  get counts(): Record<SurfaceKind, number> {
    return this.meshView ? this.meshView.counts : EMPTY_COUNTS();
  }

  setKindVisible(kind: SurfaceKind, visible: boolean): void {
    this.meshView?.setKindVisible(kind, visible);
    this.needsRender = true;
  }

  // --- Textured level model ---

  get hasLevelModel(): boolean {
    return this.modelGroup !== null;
  }

  /** Swap in a freshly parsed level model (null to clear). */
  setLevelModel(model: LevelModel | null): void {
    if (this.modelGroup) {
      this.scene.remove(this.modelGroup);
      this.modelGroup.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const mat = obj.material as THREE.MeshBasicMaterial;
          mat.map?.dispose();
          mat.dispose();
        }
      });
      this.modelGroup = null;
    }
    if (this.skyboxGroup) {
      this.scene.remove(this.skyboxGroup);
      this.skyboxGroup.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const mat = obj.material as THREE.MeshBasicMaterial;
          mat.map?.dispose();
          mat.dispose();
        }
      });
      this.skyboxGroup = null;
    }
    if (model) {
      const group = new THREE.Group();
      for (const batch of model.batches) group.add(this.batchMesh(batch));
      this.modelGroup = group;
      this.scene.add(group);
      this.updateModelTransform();
      if (model.skybox) {
        this.skyboxGroup = this.buildSkybox(model.skybox);
        this.skyboxGroup.visible = this.skyboxVisible;
        this.scene.add(this.skyboxGroup);
      }
    }
    this.applyViewMode();
  }

  get hasSkybox(): boolean {
    return this.skyboxGroup !== null;
  }

  setSkyboxVisible(visible: boolean): void {
    this.skyboxVisible = visible;
    if (this.skyboxGroup) this.skyboxGroup.visible = visible;
    this.needsRender = true;
  }

  /** Show/hide the origin axes + XZ grid helpers. Survives level swaps —
   * rebuildHelpers repopulates the same group. */
  setHelpersVisible(visible: boolean): void {
    this.helpers.visible = visible;
    this.needsRender = true;
  }

  /** The game's 360° sky panorama on the inside of a cylinder (band covers
   * roughly ±45° of pitch), capped by solid disks tinted from the panorama's
   * top/bottom rows. Drawn before everything else without touching the depth
   * buffer, so level geometry always wins — a pure background. */
  private buildSkybox(sky: SkyboxImage): THREE.Group {
    const R = 5000; // arbitrary: depth is ignored, it only must sit in-frustum
    const group = new THREE.Group();

    const map = new THREE.DataTexture(
      sky.rgba,
      sky.width,
      sky.height,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
    map.wrapS = THREE.RepeatWrapping; // seamless around the yaw seam
    map.wrapT = THREE.ClampToEdgeWrapping;
    map.magFilter = THREE.LinearFilter;
    map.minFilter = THREE.LinearFilter;
    map.colorSpace = THREE.SRGBColorSpace;
    map.needsUpdate = true;

    const skyMat = (opts: THREE.MeshBasicMaterialParameters): THREE.MeshBasicMaterial =>
      new THREE.MeshBasicMaterial({
        depthWrite: false,
        depthTest: false,
        ...opts,
      });

    const band = new THREE.Mesh(
      new THREE.CylinderGeometry(R, R, 2 * R, 48, 1, true),
      skyMat({ map, side: THREE.BackSide }),
    );
    const cap = (y: number, color: [number, number, number]): THREE.Mesh => {
      const m = new THREE.Mesh(
        new THREE.CircleGeometry(R, 48),
        skyMat({ color: new THREE.Color(...color), side: THREE.DoubleSide }),
      );
      m.rotation.x = Math.PI / 2;
      m.position.y = y;
      return m;
    };
    for (const mesh of [band, cap(R, sky.topColor), cap(-R, sky.bottomColor)]) {
      mesh.renderOrder = -10;
      mesh.frustumCulled = false; // always centered on the camera anyway
      group.add(mesh);
    }
    return group;
  }

  /** World→collision scale for placing the model in collision space. */
  setModelScale(scale: number): void {
    if (scale === this.modelScale) return;
    this.modelScale = scale;
    this.updateModelTransform();
  }

  /** true = show the textured level, false = show collision surfaces. The
   * anomaly overlay renders in both. */
  setTexturedVisible(visible: boolean): void {
    this.texturedVisible = visible;
    this.applyViewMode();
  }

  private updateModelTransform(): void {
    if (!this.modelGroup) return;
    const s = 1 / this.modelScale;
    this.modelGroup.scale.set(s, s, this.zFlip ? -s : s);
    this.needsRender = true;
  }

  private applyViewMode(): void {
    const textured = this.texturedVisible && this.modelGroup !== null;
    if (this.modelGroup) this.modelGroup.visible = textured;
    if (this.meshView) this.meshView.group.visible = !textured;
    this.needsRender = true;
  }

  private batchMesh(batch: GfxBatch): THREE.Mesh {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(batch.positions, 3),
    );
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(batch.uvs, 2));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(batch.colors, 4));

    const wrap = (m: WrapMode): THREE.Wrapping =>
      m === "repeat"
        ? THREE.RepeatWrapping
        : m === "mirror"
          ? THREE.MirroredRepeatWrapping
          : THREE.ClampToEdgeWrapping;

    let map: THREE.DataTexture | undefined;
    if (batch.texture) {
      map = new THREE.DataTexture(
        batch.texture.rgba,
        batch.texture.width,
        batch.texture.height,
        THREE.RGBAFormat,
        THREE.UnsignedByteType,
      );
      map.wrapS = wrap(batch.wrapS);
      map.wrapT = wrap(batch.wrapT);
      map.magFilter = THREE.LinearFilter;
      map.minFilter = THREE.LinearMipmapLinearFilter;
      map.generateMipmaps = true;
      map.colorSpace = THREE.SRGBColorSpace;
      map.needsUpdate = true;
    }
    const mat = new THREE.MeshBasicMaterial({
      map,
      vertexColors: true, // N64 combine approximation: texture × shade
      side: THREE.DoubleSide,
    });
    if (batch.layer >= 5) {
      mat.transparent = true;
      mat.depthWrite = false;
    } else {
      mat.alphaTest = 0.3; // cutout foliage/fences (RGBA16 has 1-bit alpha)
    }
    return new THREE.Mesh(geo, mat);
  }

  /** Append the 36 vertices (12 triangles, 108 floats) of an axis-aligned box
   * spanning [x0,x1]×[yLow,yHigh]×[z0,z1] (z coords already flip-adjusted).
   * A degenerate vertical interval is inflated slightly to stay visible;
   * winding doesn't matter — the anomaly material is double-sided. */
  private static pushBox(
    out: number[],
    x0: number, x1: number,
    yLow: number, yHigh: number,
    z0: number, z1: number,
  ): void {
    const yB = Math.min(yLow, yHigh);
    const yT = Math.max(yHigh, yB + 2);
    const za = Math.min(z0, z1);
    const zb = Math.max(z0, z1);
    out.push(
      // -Z / +Z faces
      x0, yB, za, x1, yB, za, x1, yT, za, x0, yB, za, x1, yT, za, x0, yT, za,
      x0, yB, zb, x1, yB, zb, x1, yT, zb, x0, yB, zb, x1, yT, zb, x0, yT, zb,
      // -X / +X faces
      x0, yB, za, x0, yB, zb, x0, yT, zb, x0, yB, za, x0, yT, zb, x0, yT, za,
      x1, yB, za, x1, yB, zb, x1, yT, zb, x1, yB, za, x1, yT, zb, x1, yT, za,
      // bottom / top faces
      x0, yB, za, x1, yB, za, x1, yB, zb, x0, yB, za, x1, yB, zb, x0, yB, zb,
      x0, yT, za, x1, yT, za, x1, yT, zb, x0, yT, za, x1, yT, zb, x0, yT, zb,
    );
  }

  /** Build the boxes for one segment: every blocked unit column renders as a
   * unit-footprint box from its own yLow to yHigh — exactly the cells the
   * probe proved blocked, no flat wall stretched between them. Runs of
   * ADJACENT columns sharing an identical blocked interval are greedily fused
   * (rows along x, then equal strips along z) purely as a draw optimization:
   * the rendered union is identical to per-cell boxes. Falls back to the
   * segment's XZ bounding box for hand-built columnless segments. Returns a
   * flat position array, 108 floats per box — callers recover the box count
   * from `length / 108` to map picks back to owning segments. */
  private segmentBoxes(s: InvisibleWallSegment): number[] {
    const zs = this.zFlip ? -1 : 1;
    const out: number[] = [];
    if (s.columns.length === 0) {
      Viewer.pushBox(
        out,
        Math.min(s.x0, s.x1) - 0.5, Math.max(s.x0, s.x1) + 0.5,
        s.yLow, s.yHigh,
        (Math.min(s.z0, s.z1) - 0.5) * zs, (Math.max(s.z0, s.z1) + 0.5) * zs,
      );
      return out;
    }
    // Row pass: bucket columns by (z, blocked interval), fuse consecutive x.
    const rows = new Map<string, number[]>();
    for (const c of s.columns) {
      const key = `${c.z}|${c.yLow}|${c.yHigh}`;
      const xs = rows.get(key);
      if (xs) xs.push(c.x);
      else rows.set(key, [c.x]);
    }
    // Strip pass: bucket x-runs by (x extent, interval), fuse consecutive z.
    const strips = new Map<string, number[]>();
    for (const [key, xs] of rows) {
      const [z, yLow, yHigh] = key.split("|");
      xs.sort((a, b) => a - b);
      let x0 = xs[0];
      let x1 = xs[0];
      const emit = () => {
        const k = `${x0}|${x1}|${yLow}|${yHigh}`;
        const zList = strips.get(k);
        if (zList) zList.push(Number(z));
        else strips.set(k, [Number(z)]);
      };
      for (let i = 1; i < xs.length; i++) {
        if (xs[i] === x1 + 1) x1 = xs[i];
        else if (xs[i] !== x1) {
          emit();
          x0 = x1 = xs[i];
        }
      }
      emit();
    }
    for (const [key, zList] of strips) {
      const [x0, x1, yLow, yHigh] = key.split("|").map(Number);
      zList.sort((a, b) => a - b);
      let z0 = zList[0];
      let z1 = zList[0];
      const emit = () =>
        Viewer.pushBox(
          out,
          x0 - 0.5, x1 + 0.5,
          yLow, yHigh,
          (z0 - 0.5) * zs, (z1 + 0.5) * zs,
        );
      for (let i = 1; i < zList.length; i++) {
        if (zList[i] === z1 + 1) z1 = zList[i];
        else if (zList[i] !== z1) {
          emit();
          z0 = z1 = zList[i];
        }
      }
      emit();
    }
    return out;
  }

  /** Render probe anomalies as glowing unit columns — one box per blocked
   * cell (adjacent equal-height cells fused, union unchanged), colored by
   * kind. One mesh (one draw call) per kind regardless of how many boxes it
   * holds, so kinds stay independently toggleable/pickable. Pass [] to
   * clear. */
  setAnomalies(segments: InvisibleWallSegment[]): void {
    for (const mesh of this.anomalyMeshes.values()) {
      this.anomalyGroup.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.anomalyMeshes.clear();
    this.anomalySegsByKind.clear();
    this.highlightSegment(null);
    this.needsRender = true;
    if (segments.length === 0) return;

    const byKind = new Map<InvisibleWallKind, InvisibleWallSegment[]>();
    for (const s of segments) {
      const g = byKind.get(s.kind);
      if (g) g.push(s);
      else byKind.set(s.kind, [s]);
    }

    for (const [kind, segs] of byKind) {
      // One owning segment per box (not per segment) so a raycast face can
      // map straight back to it — a segment now contributes many boxes.
      const chunks: number[][] = [];
      const boxSegs: InvisibleWallSegment[] = [];
      let total = 0;
      for (const s of segs) {
        const q = this.segmentBoxes(s);
        chunks.push(q);
        total += q.length;
        for (let i = 0; i < q.length / 108; i++) boxSegs.push(s);
      }
      const positions = new Float32Array(total);
      let p = 0;
      for (const q of chunks) for (let k = 0; k < q.length; k++) positions[p++] = q[k];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.MeshBasicMaterial({
        color: this.anomalyKindColor.get(kind) ?? ANOMALY_KIND_COLOR[kind],
        transparent: true,
        opacity: 0.6,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = this.anomalyKindVisible.get(kind) ?? true;
      this.anomalyMeshes.set(kind, mesh);
      this.anomalySegsByKind.set(kind, boxSegs);
      this.anomalyGroup.add(mesh);
    }
  }

  setAnomaliesVisible(visible: boolean): void {
    this.anomalyGroup.visible = visible;
    this.needsRender = true;
  }

  setAnomalyKindVisible(kind: InvisibleWallKind, visible: boolean): void {
    this.anomalyKindVisible.set(kind, visible);
    const mesh = this.anomalyMeshes.get(kind);
    if (mesh) mesh.visible = visible;
    this.needsRender = true;
  }

  /** Recolor a kind's overlay live (HUD color picker). Persists so the next
   * anomaly rebuild keeps the choice. */
  setAnomalyKindColor(kind: InvisibleWallKind, color: number): void {
    this.anomalyKindColor.set(kind, color);
    const mesh = this.anomalyMeshes.get(kind);
    if (mesh) (mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
    this.needsRender = true;
  }

  /** Raycast a canvas-space click against the visible anomaly meshes and report
   * the hit segment (or null) to onAnomalyPick, highlighting it. */
  private handlePick(clientX: number, clientY: number): void {
    if (!this.onAnomalyPick) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes = [...this.anomalyMeshes.values()].filter((m) => m.visible);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    const faceIndex = hit?.faceIndex;
    if (faceIndex == null) {
      this.highlightSegment(null);
      this.onAnomalyPick(null);
      return;
    }
    // Twelve triangles per box; anomalySegsByKind has one entry per box (in
    // the same emission order), so faceIndex/12 indexes straight into it.
    let kind: InvisibleWallKind | null = null;
    for (const [k, m] of this.anomalyMeshes) if (m === hit.object) kind = k;
    if (!kind) return;
    const seg = this.anomalySegsByKind.get(kind)?.[Math.floor(faceIndex / 12)];
    this.highlightSegment(seg ?? null);
    this.onAnomalyPick(seg ?? null);
  }

  private highlightSegment(seg: InvisibleWallSegment | null): void {
    if (this.anomalyHighlight) {
      this.anomalyGroup.remove(this.anomalyHighlight);
      this.anomalyHighlight.geometry.dispose();
      (this.anomalyHighlight.material as THREE.Material).dispose();
      this.anomalyHighlight = null;
      this.needsRender = true;
    }
    if (!seg) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(this.segmentBoxes(seg)), 3),
    );
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false,
    });
    this.anomalyHighlight = new THREE.Mesh(geo, mat);
    this.anomalyHighlight.renderOrder = 3;
    this.anomalyGroup.add(this.anomalyHighlight);
    this.needsRender = true;
  }

  setMarioPosition(pos: { x: number; y: number; z: number } | null): void {
    if (!pos) {
      if (this.marioMarker) {
        this.marioMarker.visible = false;
        this.needsRender = true;
      }
      return;
    }
    if (!this.marioMarker) {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(60, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
      );
      this.marioMarker = marker;
      this.scene.add(marker);
    }
    const zs = this.zFlip ? -1 : 1;
    this.marioMarker.visible = true;
    this.marioMarker.position.set(pos.x, pos.y, pos.z * zs);
    this.needsRender = true;
  }

  private rebuildHelpers(b: LevelBounds): void {
    this.helpers.clear();
    if (!Number.isFinite(b.minX)) return;
    const zs = this.zFlip ? -1 : 1;
    const cx = (b.minX + b.maxX) / 2;
    const cz = ((b.minZ + b.maxZ) / 2) * zs;
    const size = Math.max(b.maxX - b.minX, b.maxZ - b.minZ, 1000) * 1.5;
    const grid = new THREE.GridHelper(size, 20, 0x2a2e3a, 0x20242e);
    grid.position.set(cx, b.minY, cz);
    this.helpers.add(grid);
    const axes = new THREE.AxesHelper(size * 0.15);
    axes.position.set(cx, b.minY, cz);
    this.helpers.add(axes);
  }

  private frame(b: LevelBounds): void {
    if (!Number.isFinite(b.minX)) return;
    const zs = this.zFlip ? -1 : 1;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const cz = ((b.minZ + b.maxZ) / 2) * zs;
    const size = Math.max(
      b.maxX - b.minX,
      b.maxY - b.minY,
      b.maxZ - b.minZ,
      1000,
    );
    const dist = size * 1.6;
    this.camera.position.set(cx + dist, cy + dist * 0.7, cz + dist);
    this.camera.near = Math.max(1, size / 2000);
    this.camera.far = size * 20;
    this.camera.updateProjectionMatrix();
    // Aim at the level center and scale fly speed to the level.
    const dir = new THREE.Vector3(cx, cy, cz)
      .sub(this.camera.position)
      .normalize();
    this.pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
    this.yaw = Math.atan2(-dir.x, -dir.z);
    this.applyLook();
    // ~size/6 units per second at 1× — deliberately gentle; the HUD slider
    // multiplies up to 8× and Shift adds another ×4 when you want to travel.
    this.flySpeed = size / 6;
  }

  private onResize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.needsRender = true;
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const t = e.target as HTMLElement | null;
    if (
      t &&
      (t.tagName === "TEXTAREA" ||
        t.isContentEditable ||
        (t instanceof HTMLInputElement &&
          (t.type === "text" || e.code === "Space")))
    ) {
      return; // typing in a field, or Space toggling a focused checkbox
    }
    const code = e.code === "ShiftRight" ? "ShiftLeft" : e.code;
    if (!FLY_KEYS.has(code)) return;
    if (down) this.keys.add(code);
    else this.keys.delete(code);
    if (e.code === "Space") e.preventDefault(); // don't scroll the page
  }

  /** User fly-speed multiplier (HUD slider), on top of the level-size base. */
  setFlySpeedScale(scale: number): void {
    this.flySpeedScale = scale;
  }

  private applyLook(): void {
    this.camera.rotation.set(this.pitch, this.yaw, 0);
    this.needsRender = true;
  }

  /** Per-frame fly movement: W/S along the camera's forward (full 3D), A/D
   * strafe, Space/C world up/down, Shift ×4. */
  private updateFly(): void {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    if (this.keys.size === 0) return;
    const speed =
      this.flySpeed *
      this.flySpeedScale *
      (this.keys.has("ShiftLeft") ? 4 : 1) *
      dt;
    const fwd = this.camera.getWorldDirection(new THREE.Vector3());
    const right = new THREE.Vector3()
      .crossVectors(fwd, this.camera.up)
      .normalize();
    const move = new THREE.Vector3();
    if (this.keys.has("KeyW")) move.add(fwd);
    if (this.keys.has("KeyS")) move.sub(fwd);
    if (this.keys.has("KeyD")) move.add(right);
    if (this.keys.has("KeyA")) move.sub(right);
    if (this.keys.has("Space")) move.y += 1;
    if (this.keys.has("KeyC")) move.y -= 1;
    if (move.lengthSq() === 0) return;
    this.camera.position.add(move.normalize().multiplyScalar(speed));
  }

  private animate(): void {
    requestAnimationFrame(this.animate);
    this.updateFly();
    // Fly keys held or a look-drag in progress → the camera moves this frame.
    const moving = this.keys.size > 0 || this.lastPointer !== null;
    if (moving) {
      this.needsRender = true;
      if (!this.lowRes && this.baseRatio > 1) {
        this.lowRes = true;
        this.renderer.setPixelRatio(1);
      }
    } else if (this.lowRes) {
      this.lowRes = false;
      this.renderer.setPixelRatio(this.baseRatio);
      this.needsRender = true;
    }
    if (!this.needsRender) return;
    this.needsRender = false;
    // Keep the sky centered on the eye so it reads as infinitely far away.
    if (this.skyboxGroup) this.skyboxGroup.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
  }
}

const FLY_KEYS = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD", "KeyC", "Space", "ShiftLeft",
]);
