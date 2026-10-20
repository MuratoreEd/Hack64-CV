// The capture format: one JSON file describing one labelled spot, carrying the
// exact surface pool the game had at that moment.
//
// This is deliberately ONE schema for two jobs:
//   - R1 ground truth: the user parks Mario somewhere they know the truth about
//     and saves a "wall" or "clear" label; the corpus runner replays it.
//   - R6 community bug reports: a stranger exports a finding they disagree with
//     and attaches it to an issue; it replays locally the same way.
// A report that can't be replayed is an anecdote, which is the habit the whole
// remediation is trying to break.
//
// The pool is stored as RAW BYTES, not parsed surfaces: classification depends
// on the profile (wallThreshold), so parsed surfaces would freeze one engine's
// interpretation into the ground truth. Bytes are what the game had.

import type { FloorSelect, WallModel } from "../collision/profile";

/** Bump when a field changes meaning. Readers refuse versions they don't know. */
export const CORPUS_SCHEMA_VERSION = 1;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** What the user asserts about the labelled position. */
export type LabelVerdict = "wall" | "clear";

/** The collision engine believed to be running, and how sure we were. */
export interface CapturedProfile {
  wallThreshold: number;
  select: FloorSelect;
  /** Wall routine. Absent in captures that predate it — readers then use
   * wallsForThreshold(wallThreshold), which is what the app assumed. */
  walls?: WallModel;
  /** False when neither patch signal had spoken yet — the label is then only
   * as good as the default, and the runner says so. */
  known: boolean;
}

export interface CapturedPool {
  /** Number of surfaces (gSurfacesAllocated at capture time). */
  count: number;
  /** KSEG0 address of the pool base, so surface addresses match the game's. */
  poolBase: number;
  /** "gzip+base64" normally; "base64" if the browser lacked CompressionStream. */
  encoding: "gzip+base64" | "base64";
  /** The encoded `count * 0x30` canonical big-endian surface bytes. */
  data: string;
}

/** Everything about a labelled spot except the pool bytes. */
export interface LabelRecord {
  schemaVersion: number;
  /** App version that produced the capture (bug reports need this). */
  appVersion: string;
  capturedAt: string;
  level: number;
  area: number;
  /** World→collision scale in force when the label was taken. */
  worldScale: number;
  /** Whether that scale had been measured on this level (vs carried over from
   * the previous one). Absent in captures that predate the distinction. */
  worldScaleVerified?: boolean;
  profile: CapturedProfile;
  /** Mario's position in WORLD units, i.e. what the HUD showed the user. */
  marioWorldPos: Vec3;
  label: LabelVerdict;
  /** The user's own words. This is the primary evidence a future session has
   * about what was actually observed, so it is never optional. */
  note: string;
  /** Match radius override in WORLD units; see judge.ts for the defaults. */
  radius?: number;
}

/** A capture file as downloaded from the viewer: label + its pool inline. */
export interface Capture extends LabelRecord {
  pool: CapturedPool;
}

/** A label as stored in the repo, pointing at a deduplicated pool file. */
export interface StoredLabel extends LabelRecord {
  /** Basename inside corpus/pools/, e.g. "L15-A1-3f2a91c7.json". */
  poolFile: string;
}

/** A pool as stored in the repo, shared by every label captured against it.
 * It carries the session's scale and profile so the pool alone is enough to
 * reproduce a probe run — a pool with no labels still gets a cell baseline. */
export interface StoredPool {
  schemaVersion: number;
  level: number;
  area: number;
  capturedAt: string;
  worldScale: number;
  profile: CapturedProfile;
  pool: CapturedPool;
}

// --- base64 (isomorphic: atob/btoa are globals in browsers and in Node 16+) ---

const CHUNK = 0x8000; // fromCharCode blows the stack on a whole 600 kB pool

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function through(bytes: Uint8Array, stream: TransformStream): Promise<Uint8Array> {
  const blob = new Blob([bytes as BlobPart]);
  const buf = await new Response(blob.stream().pipeThrough(stream)).arrayBuffer();
  return new Uint8Array(buf);
}

/** Compress + encode pool bytes for storage. Falls back to plain base64 where
 * CompressionStream is missing, recording which was used. */
export async function encodePool(
  bytes: Uint8Array,
  count: number,
  poolBase: number,
): Promise<CapturedPool> {
  if (typeof CompressionStream === "undefined") {
    return { count, poolBase, encoding: "base64", data: bytesToBase64(bytes) };
  }
  const gz = await through(bytes, new CompressionStream("gzip"));
  return { count, poolBase, encoding: "gzip+base64", data: bytesToBase64(gz) };
}

/** Recover the raw surface-pool bytes from a stored pool. */
export async function decodePool(pool: CapturedPool): Promise<ArrayBuffer> {
  const raw = base64ToBytes(pool.data);
  if (pool.encoding === "base64") return raw.buffer as ArrayBuffer;
  const out = await through(raw, new DecompressionStream("gzip"));
  return out.buffer as ArrayBuffer;
}
