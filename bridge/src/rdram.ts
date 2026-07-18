// Locate SM64 (US) RDRAM inside the Project64 process and read game state,
// canonicalizing PJ64's byte order to big-endian (N64 native).

import { ProcessMemory } from "./win32.js";

// SM64 US symbol addresses (KSEG0), from sm64.us.map.
const US = {
  gCurrLevelNum: 0x8032ddf8, // s16
  gCurrAreaIndex: 0x8033baca, // s16
  gMarioStates: 0x8033b170, // struct MarioState
  gSurfacesAllocated: 0x80361170, // s32
  sSurfacePool: 0x8038ee9c, // struct Surface* (pointer)
  sSurfacePoolSize: 0x8038eea0, // s32
} as const;

// struct MarioState field offsets (US), from include/types.h.
const MARIO = {
  pos: 0x3c, // Vec3f
  wall: 0x60, // struct Surface*
  ceil: 0x64, // struct Surface*
  floor: 0x68, // struct Surface*
  ceilHeight: 0x6c, // f32
  floorHeight: 0x70, // f32
} as const;

const SURFACE_STRUCT_SIZE = 0x30;
const RDRAM_MASK = 0x1fffffff; // KSEG0/KSEG1 virtual -> physical RDRAM offset
const RDRAM_MIN_SIZE = 0x400000n; // 4 MB minimum

/** How the emulator stores RDRAM relative to N64-native big-endian. */
export type ByteOrder = "dword" | "big";

/**
 * Reads emulator RDRAM as canonical big-endian. PJ64 stores memory with each
 * 32-bit word byte-reversed ("dword"); some setups are already big-endian.
 * The reader reverses each aligned dword when needed so downstream parsing is
 * always plain big-endian.
 */
export class Rdram {
  constructor(
    private proc: ProcessMemory,
    readonly base: bigint,
    readonly order: ByteOrder,
  ) {}

  /** Read `len` canonical big-endian bytes at N64 address `n64addr`. */
  readBytes(n64addr: number, len: number): Buffer {
    const phys = (n64addr & RDRAM_MASK) >>> 0;
    if (this.order === "big") {
      return this.proc.read(this.base + BigInt(phys), len);
    }
    // "dword": read an aligned span and reverse each 4-byte group.
    const start = phys & ~3;
    const end = (phys + len + 3) & ~3;
    const raw = this.proc.read(this.base + BigInt(start), end - start);
    const canon = Buffer.allocUnsafe(raw.length);
    for (let i = 0; i < raw.length; i += 4) {
      canon[i] = raw[i + 3];
      canon[i + 1] = raw[i + 2];
      canon[i + 2] = raw[i + 1];
      canon[i + 3] = raw[i];
    }
    const offset = phys - start;
    return canon.subarray(offset, offset + len);
  }

  u32(addr: number): number {
    return this.readBytes(addr, 4).readUInt32BE(0) >>> 0;
  }
  s32(addr: number): number {
    return this.readBytes(addr, 4).readInt32BE(0);
  }
  s16(addr: number): number {
    return this.readBytes(addr, 2).readInt16BE(0);
  }
  f32(addr: number): number {
    return this.readBytes(addr, 4).readFloatBE(0);
  }
}

const RDRAM_KSEG0_END = 0x80800000; // top of 8 MB RDRAM in KSEG0

/** A real surface has a unit-length normal and lowerY <= upperY. */
function surfaceLooksReal(rd: Rdram, surfAddr: number): boolean {
  const nx = rd.f32(surfAddr + 0x1c);
  const ny = rd.f32(surfAddr + 0x20);
  const nz = rd.f32(surfAddr + 0x24);
  const mag = Math.hypot(nx, ny, nz);
  if (!(mag > 0.99 && mag < 1.01)) return false;
  return rd.s16(surfAddr + 0x06) <= rd.s16(surfAddr + 0x08); // lowerY <= upperY
}

/** SM64-US invariants that hold once a level is loaded — used to confirm we've
 * found the right RDRAM base and byte order (and reject false positives). */
function looksLikeSm64Us(rd: Rdram): boolean {
  try {
    // A loaded level has a sane number of surfaces allocated.
    const count = rd.s32(US.gSurfacesAllocated);
    if (count < 1 || count > 100000) return false;

    const poolBase = rd.u32(US.sSurfacePool);
    if (poolBase < 0x80000000) return false;
    if (poolBase + count * SURFACE_STRUCT_SIZE > RDRAM_KSEG0_END) return false;

    // Decisive: sampled surfaces must look like real collision triangles.
    for (const i of [0, count >> 1, count - 1]) {
      if (!surfaceLooksReal(rd, poolBase + i * SURFACE_STRUCT_SIZE)) return false;
    }

    // Mario position sane.
    const x = rd.f32(US.gMarioStates + MARIO.pos);
    const y = rd.f32(US.gMarioStates + MARIO.pos + 4);
    const z = rd.f32(US.gMarioStates + MARIO.pos + 8);
    for (const v of [x, y, z]) {
      if (!Number.isFinite(v) || Math.abs(v) > 1e6) return false;
    }
    return true;
  } catch {
    return false;
  }
}

const PAGE_SIZE = 0x1000n; // 4 KB
const MEM_IMAGE = 0x1000000; // skip mapped DLLs/executables
const PAGE_NOACCESS = 0x01;
const PAGE_GUARD = 0x100;

function isScannable(type: number, protect: number): boolean {
  if (type === MEM_IMAGE) return false; // RDRAM is private/mapped, never an image
  if (protect === PAGE_NOACCESS || (protect & PAGE_GUARD) !== 0) return false;
  return true;
}

/**
 * Scan the process for the SM64-US RDRAM base, auto-detecting byte order.
 * RDRAM can sit at a page-aligned offset inside a larger allocation, so within
 * every big-enough private/mapped region we test each 4 KB-aligned candidate.
 */
export function discoverRdram(proc: ProcessMemory): Rdram | null {
  for (const region of proc.committedRegions(RDRAM_MIN_SIZE)) {
    if (!isScannable(region.type, region.protect)) continue;
    const lastBase = region.base + region.size - RDRAM_MIN_SIZE;
    for (
      let candidate = region.base;
      candidate <= lastBase;
      candidate += PAGE_SIZE
    ) {
      for (const order of ["dword", "big"] as ByteOrder[]) {
        const rd = new Rdram(proc, candidate, order);
        if (looksLikeSm64Us(rd)) return rd;
      }
    }
  }
  return null;
}

/** Diagnostic: for each scannable >=4MB region, show what the SM64 anchors read
 * as under both byte orders (helps spot the right base + order). */
export function dumpDiagnostics(proc: ProcessMemory): void {
  console.log("Anchor reads at scannable >=4MB region bases:");
  for (const region of proc.committedRegions(RDRAM_MIN_SIZE)) {
    if (!isScannable(region.type, region.protect)) continue;
    for (const order of ["dword", "big"] as ByteOrder[]) {
      const rd = new Rdram(proc, region.base, order);
      try {
        const memSize = rd.u32(0x80000318);
        const tvType = rd.u32(0x80000300);
        const poolSize = rd.s32(US.sSurfacePoolSize);
        const count = rd.s32(US.gSurfacesAllocated);
        const poolBase = rd.u32(US.sSurfacePool);
        const mx = rd.f32(US.gMarioStates + MARIO.pos);
        console.log(
          `  0x${region.base.toString(16)} [${order}] memSize=0x${memSize.toString(16)} tv=${tvType} ` +
            `poolSize=${poolSize} count=${count} poolBase=0x${poolBase.toString(16)} marioX=${mx.toFixed(1)}`,
        );
      } catch {
        console.log(`  0x${region.base.toString(16)} [${order}] read failed`);
      }
    }
  }
}

/** Diagnostic: print the largest committed regions to help locate RDRAM. */
export function dumpRegions(proc: ProcessMemory): void {
  const regions = [...proc.committedRegions(0x100000n)].sort((a, b) =>
    Number(b.size - a.size),
  );
  console.log("Largest committed regions (>= 1 MB):");
  for (const r of regions.slice(0, 12)) {
    console.log(
      `  base 0x${r.base.toString(16).padStart(12, "0")}  ` +
        `size 0x${r.size.toString(16)}  type 0x${r.type.toString(16)}  protect 0x${r.protect.toString(16)}`,
    );
  }
}

export interface GameState {
  level: number;
  area: number;
  pos: { x: number; y: number; z: number };
  floorAddr: number;
  ceilAddr: number;
  wallAddr: number;
  floorHeight: number;
  ceilHeight: number;
  surfaceCount: number;
}

export function readState(rd: Rdram): GameState {
  const m = US.gMarioStates;
  return {
    level: rd.s16(US.gCurrLevelNum),
    area: rd.s16(US.gCurrAreaIndex),
    pos: {
      x: rd.f32(m + MARIO.pos),
      y: rd.f32(m + MARIO.pos + 4),
      z: rd.f32(m + MARIO.pos + 8),
    },
    floorAddr: rd.u32(m + MARIO.floor),
    ceilAddr: rd.u32(m + MARIO.ceil),
    wallAddr: rd.u32(m + MARIO.wall),
    floorHeight: rd.f32(m + MARIO.floorHeight),
    ceilHeight: rd.f32(m + MARIO.ceilHeight),
    surfaceCount: rd.s32(US.gSurfacesAllocated),
  };
}

export interface SurfacePool {
  count: number;
  poolBase: number;
  /** Canonical big-endian bytes: count * 0x30. */
  bytes: Buffer;
}

/** Full RDRAM snapshot as canonical big-endian bytes. Tries expanded 8 MB
 * first (this hack uses the expansion pak), falling back to 4 MB. */
export function readRdramSnapshot(rd: Rdram): Buffer {
  for (const size of [0x800000, 0x400000]) {
    try {
      return rd.readBytes(0x80000000, size);
    } catch {
      // region smaller than expected — try the next size down
    }
  }
  throw new Error("RDRAM snapshot read failed");
}

export function readSurfacePool(rd: Rdram): SurfacePool {
  const count = rd.s32(US.gSurfacesAllocated);
  const poolBase = rd.u32(US.sSurfacePool);
  const bytes =
    count > 0 ? rd.readBytes(poolBase, count * SURFACE_STRUCT_SIZE) : Buffer.alloc(0);
  return { count, poolBase, bytes };
}
