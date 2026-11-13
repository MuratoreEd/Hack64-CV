// The cartridge ROM, as Project64 holds it in memory.
//
// Project64 keeps the whole ROM image in one allocation and serves the game's
// cartridge reads from it. Some of a level only ever exists there: a hack's
// level script can name its object list by ROM offset, run it once at load
// and leave nothing of it in RDRAM (seen live, 2026-11-13: the placements of
// a ROM Manager-style level were nowhere in RAM, and intact in the ROM image
// at the offset the level script's own LOAD_RAW command gives). Reading the
// image out of the emulator means nobody has to be asked for a ROM file.
//
// Found by its header: every N64 ROM starts 80 37 12 40. Like RDRAM,
// Project64 stores it with each 32-bit word byte-reversed.

import { ProcessMemory } from "./win32.js";

const ROM_MIN_SIZE = 0x800000n; // an unmodified SM64 ROM is exactly 8 MB
const HEADER_MAGIC = 0x80371240;
/** The image sat at its region's base when observed; a little slack costs
 * nothing (16 four-byte reads per large region). */
const SEARCH_STEP = 0x1000n;
const SEARCH_SPAN = 0x10000n;

export class RomImage {
  constructor(
    private proc: ProcessMemory,
    readonly base: bigint,
    /** Bytes from `base` to the end of the allocation. */
    readonly size: number,
    private swapped: boolean,
  ) {}

  /** `length` big-endian bytes at ROM offset `offset`, or null if that is
   * outside the image. */
  read(offset: number, length: number): Buffer | null {
    if (!Number.isInteger(offset) || !Number.isInteger(length)) return null;
    if (offset < 0 || length <= 0 || offset + length > this.size) return null;
    const start = offset & ~3;
    const end = (offset + length + 3) & ~3;
    if (end > this.size) return null;
    const raw = this.proc.read(this.base + BigInt(start), end - start);
    if (this.swapped) raw.swap32();
    return raw.subarray(offset - start, offset - start + length);
  }
}

/** Find the ROM image in the emulator's memory, or null. */
export function discoverRom(proc: ProcessMemory): RomImage | null {
  for (const region of proc.committedRegions(ROM_MIN_SIZE)) {
    for (let off = 0n; off < SEARCH_SPAN && off + ROM_MIN_SIZE <= region.size; off += SEARCH_STEP) {
      let head: Buffer;
      try {
        head = proc.read(region.base + off, 4);
      } catch {
        break; // not readable: try the next region
      }
      const swapped = head.readUInt32LE(0) === HEADER_MAGIC;
      if (!swapped && head.readUInt32BE(0) !== HEADER_MAGIC) continue;
      return new RomImage(proc, region.base + off, Number(region.size - off), swapped);
    }
  }
  return null;
}
