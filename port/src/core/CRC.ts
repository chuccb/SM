/**
 * CCRC32 / CCRC8 — checksums appended to cipher-degree >= 1 packets.
 *
 * CCRC32: MSB-first CRC-32, polynomial 0x4C11DB7, no reflection, no final XOR
 *         (same family as zlib's crc32() but the raw table form; the incoming
 *         accumulator is the rolling packet sequence key).
 *         Also feeds CGameMapTmpl +88 (LoadMap :13710 calls
 *         UpdateCRC(0, file, size)) — the value packet 109 validates.
 * CCRC8 : CRC-8, polynomial 0x07.
 */

const BITS_PER_BYTE = 8;
const BYTE_VALUE_COUNT = 2 ** BITS_PER_BYTE;
const BYTE_MASK = BYTE_VALUE_COUNT - 1;
const CRC32_WIDTH_BITS = Uint32Array.BYTES_PER_ELEMENT * BITS_PER_BYTE;
const CRC32_BYTE_SHIFT = CRC32_WIDTH_BITS - BITS_PER_BYTE;
const CRC32_TOP_BIT = 2 ** (CRC32_WIDTH_BITS - 1);
const CRC32_POLYNOMIAL = 0x04c11db7;
const CRC8_TOP_BIT = 1 << (BITS_PER_BYTE - 1);
const CRC8_POLYNOMIAL = 0x07;

function GenerateCRC32Table(): Uint32Array {
  const table = new Uint32Array(BYTE_VALUE_COUNT);
  for (let i = 0; i < table.length; i++) {
    // FxServer.exe.c CCRC32::GenCRCTable: the byte starts in the TOP bits.
    // Starting from an unshifted byte creates a self-consistent port-only CRC
    // that does not match the original client.
    let crc = (i << CRC32_BYTE_SHIFT) >>> 0;
    for (let bit = 0; bit < BITS_PER_BYTE; bit++) {
      crc = crc & CRC32_TOP_BIT
        ? (((crc << 1) >>> 0) ^ CRC32_POLYNOMIAL) >>> 0
        : (crc << 1) >>> 0;
    }
    table[i] = crc;
  }
  return table;
}

function GenerateCRC8Table(): Uint8Array {
  const table = new Uint8Array(BYTE_VALUE_COUNT);
  for (let i = 0; i < table.length; i++) {
    let crc = i;
    for (let bit = 0; bit < BITS_PER_BYTE; bit++) {
      crc = crc & CRC8_TOP_BIT
        ? ((crc << 1) ^ CRC8_POLYNOMIAL) & BYTE_MASK
        : (crc << 1) & BYTE_MASK;
    }
    table[i] = crc;
  }
  return table;
}

const crc32Table = GenerateCRC32Table();
const crc8Table = GenerateCRC8Table();

/** CCRC32::UpdateCRC */
export function UpdateCRC32(dwCrcAccum: number, p: Uint8Array, off = 0, nSize = p.length - off): number {
  let crc = dwCrcAccum >>> 0;
  for (let i = 0; i < nSize; i++) {
    const tableIndex = (p[off + i]! ^ (crc >>> CRC32_BYTE_SHIFT)) & BYTE_MASK;
    crc = (crc32Table[tableIndex]! ^ ((crc << BITS_PER_BYTE) >>> 0)) >>> 0;
  }
  return crc >>> 0;
}

/** CCRC8::UpdateCRC */
export function UpdateCRC8(dwCrcKey: number, p: Uint8Array, off = 0, nSize = p.length - off): number {
  let crc = dwCrcKey & BYTE_MASK;
  for (let i = 0; i < nSize; i++) crc = crc8Table[crc ^ p[off + i]!]!;
  return crc;
}
