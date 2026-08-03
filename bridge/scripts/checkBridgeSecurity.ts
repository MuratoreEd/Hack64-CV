// Verifies the bridge's two network defences against a RUNNING bridge (dev
// bridge, or the packaged exe — same checks apply to both):
//
//   1. it listens on loopback only, so nobody on the LAN can reach it;
//   2. it refuses WebSocket handshakes from origins that aren't this machine,
//      so a random web page open in the user's browser can't ask for
//      {type:"rdram"} and receive the emulator's whole address space.
//
//   npx tsx scripts/checkBridgeSecurity.ts [--port=8081]
//
// Exits non-zero if any check fails.

import { execSync } from "node:child_process";
import { WebSocket } from "ws";

const portArg = process.argv.slice(2).find((a) => a.startsWith("--port="));
const PORT = portArg ? Number.parseInt(portArg.slice(7), 10) : 8081;

interface OriginCase {
  origin: string | null;
  what: string;
  expect: "accept" | "reject";
}

const CASES: OriginCase[] = [
  { origin: null, what: "no Origin header (our own tooling)", expect: "accept" },
  { origin: "http://localhost:5173", what: "vite dev server", expect: "accept" },
  { origin: "http://127.0.0.1:8081", what: "the exe's own page", expect: "accept" },
  { origin: "https://evil.example", what: "a hostile web page", expect: "reject" },
  { origin: "null", what: "file:// page or sandboxed iframe", expect: "reject" },
  { origin: "http://localhost.evil.example", what: "lookalike host", expect: "reject" },
  { origin: "http://192.168.1.50:5173", what: "a machine on the LAN", expect: "reject" },
];

/** Resolves "accept" if the handshake completes, "reject" if it doesn't. */
function attempt(origin: string | null): Promise<"accept" | "reject"> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, {
      headers: origin === null ? {} : { Origin: origin },
    });
    const done = (r: "accept" | "reject") => {
      clearTimeout(timer);
      ws.removeAllListeners();
      // Tearing down a half-open socket re-emits 'error'; swallow it.
      ws.on("error", () => {});
      ws.terminate();
      resolve(r);
    };
    const timer = setTimeout(() => done("reject"), 4000);
    ws.on("open", () => done("accept"));
    ws.on("unexpected-response", () => done("reject"));
    ws.on("error", () => done("reject"));
  });
}

/** Listening addresses for PORT, per netstat. */
function listeners(): string[] {
  const out = execSync("netstat -ano -p TCP", { encoding: "utf8" });
  return out
    .split(/\r?\n/)
    .filter((l) => /LISTENING/.test(l) && l.includes(`:${PORT} `))
    .map((l) => l.trim().split(/\s+/)[1] ?? "")
    .filter(Boolean);
}

const isLoopbackBind = (addr: string): boolean =>
  /^127\.\d+\.\d+\.\d+:/.test(addr) || addr.startsWith("[::1]:");

async function main(): Promise<void> {
  console.log(`Checking the bridge on port ${PORT}\n`);
  let failed = 0;

  console.log("Bind address:");
  const addrs = listeners();
  if (addrs.length === 0) {
    console.log(`  ! nothing is listening on ${PORT} - start the bridge first`);
    process.exit(1);
  }
  for (const a of addrs) {
    const ok = isLoopbackBind(a);
    if (!ok) failed++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${a}${ok ? "" : "  <- reachable from the network"}`);
  }

  console.log("\nWebSocket handshake origins:");
  for (const c of CASES) {
    const got = await attempt(c.origin);
    const ok = got === c.expect;
    if (!ok) failed++;
    const shown = c.origin === null ? "(none)" : c.origin;
    console.log(
      `  ${ok ? "PASS" : "FAIL"}  ${shown} - ${c.what}: ${got} (expected ${c.expect})`,
    );
  }

  console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
