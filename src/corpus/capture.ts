// Browser side of the ground-truth capture: turn "Mario is standing at a spot
// I know the truth about" into a file that can be replayed offline forever.
//
// The pool bytes are kept exactly as the bridge delivered them, so a replay
// parses the identical surfaces under whatever profile is being tested.

import { APP_VERSION } from "../version";
import {
  CORPUS_SCHEMA_VERSION,
  encodePool,
  type Capture,
  type CapturedProfile,
  type LabelVerdict,
  type Vec3,
} from "./schema";

export interface CaptureSession {
  /** Raw surface-pool bytes as streamed by the bridge (canonical big-endian). */
  poolBytes: Uint8Array;
  poolCount: number;
  poolBase: number;
  level: number;
  area: number;
  worldScale: number;
  worldScaleVerified: boolean;
  profile: CapturedProfile;
  marioWorldPos: Vec3;
}

export async function buildCapture(
  session: CaptureSession,
  label: LabelVerdict,
  note: string,
): Promise<Capture> {
  return {
    schemaVersion: CORPUS_SCHEMA_VERSION,
    appVersion: APP_VERSION,
    capturedAt: new Date().toISOString(),
    level: session.level,
    area: session.area,
    worldScale: session.worldScale,
    worldScaleVerified: session.worldScaleVerified,
    profile: session.profile,
    marioWorldPos: session.marioWorldPos,
    label,
    note,
    pool: await encodePool(
      session.poolBytes,
      session.poolCount,
      session.poolBase,
    ),
  };
}

/** `L15-A1-wall-20260802T210433Z.json` — sorts by level, then by capture time. */
export function captureFilename(c: Capture): string {
  const stamp = c.capturedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `L${c.level}-A${c.area}-${c.label}-${stamp}.json`;
}

/** Hand the capture to the browser as a download. */
export function downloadCapture(c: Capture): void {
  const blob = new Blob([JSON.stringify(c)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = captureFilename(c);
  a.click();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
