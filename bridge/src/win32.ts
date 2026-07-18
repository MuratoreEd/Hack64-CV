// Minimal Win32 process-memory access via koffi FFI (no native build step).
// Exposes: find the Project64 PID, open it, read memory, and enumerate regions.

import koffi from "koffi";
import { execFileSync } from "node:child_process";

const kernel32 = koffi.load("kernel32.dll");

const OpenProcess = kernel32.func(
  "uint64 OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)",
);
const CloseHandle = kernel32.func("bool CloseHandle(uint64 hObject)");
const ReadProcessMemory = kernel32.func(
  "bool ReadProcessMemory(uint64 hProcess, uint64 lpBaseAddress, void *lpBuffer, size_t nSize, void *lpNumberOfBytesRead)",
);
const VirtualQueryEx = kernel32.func(
  "size_t VirtualQueryEx(uint64 hProcess, uint64 lpAddress, void *lpBuffer, size_t dwLength)",
);

const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_VM_READ = 0x0010;
const MEM_COMMIT = 0x1000;

export interface MemoryRegion {
  base: bigint;
  size: bigint;
  state: number;
  protect: number;
  type: number;
}

export class ProcessMemory {
  private handle: bigint;

  constructor(readonly pid: number) {
    const h = OpenProcess(
      PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
      false,
      pid,
    );
    if (!h) {
      throw new Error(
        `OpenProcess failed for pid ${pid} (process gone, or try running as admin)`,
      );
    }
    this.handle = typeof h === "bigint" ? h : BigInt(h);
  }

  /** Read `len` bytes at absolute process address `addr`. Throws on failure. */
  read(addr: bigint, len: number): Buffer {
    const buf = Buffer.alloc(len);
    const ok = ReadProcessMemory(this.handle, addr, buf, len, null);
    if (!ok) {
      throw new Error(
        `ReadProcessMemory failed at 0x${addr.toString(16)} (${len} bytes)`,
      );
    }
    return buf;
  }

  /** Iterate committed memory regions of the process. */
  *regions(): Generator<MemoryRegion> {
    let addr = 0n;
    const maxAddr = 0x7fffffffffffn;
    const info = Buffer.alloc(48); // sizeof(MEMORY_BASIC_INFORMATION) on x64
    while (addr < maxAddr) {
      const written = VirtualQueryEx(this.handle, addr, info, 48);
      if (!written) break;
      const base = info.readBigUInt64LE(0);
      const size = info.readBigUInt64LE(24);
      const state = info.readUInt32LE(32);
      const protect = info.readUInt32LE(36);
      const type = info.readUInt32LE(40);
      if (size === 0n) break;
      yield { base, size, state, protect, type };
      addr = base + size;
    }
  }

  /** Committed regions of at least `minSize` bytes. */
  *committedRegions(minSize: bigint): Generator<MemoryRegion> {
    for (const r of this.regions()) {
      if (r.state === MEM_COMMIT && r.size >= minSize) yield r;
    }
  }

  close(): void {
    CloseHandle(this.handle);
  }
}

/** Find the PID of a running Project64 (incl. Luna's fork), or null. */
export function findProject64Pid(): number | null {
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-Process | Where-Object { $_.ProcessName -like 'Project64*' } | Select-Object -First 1 -ExpandProperty Id",
      ],
      { encoding: "utf8" },
    );
    const pid = Number.parseInt(out.trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}
