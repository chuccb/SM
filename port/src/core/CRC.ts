/**
 * CCRC32 / CCRC8 — checksums appended to cipher-degree >= 1 packets.
 *
 * CCRC32: MSB-first CRC-32, polynomial 0x4C11DB7, no reflection, no final XOR
 *         (same family as zlib's crc32() but the raw table form; the incoming
 *         accumulator is the rolling packet sequence key).
 * CCRC8 : CRC-8, polynomial 0x07.
 */

const crc32_table = new Uint32Array(256);
const crc8_table = new Uint8Array(256);

(function GenCRCTable() {
  for (let i = 0; i < 256; i++) {
    let v = i;
    for (let bit = 0; bit < 8; bit++) v = v & 0x80000000 ? (((v << 1) >>> 0) ^ 0x4c11db7) >>> 0 : (v << 1) >>> 0;
    // The original starts from (i << 25) — a byte already in the top position.
    crc32_table[i] = v >>> 0;
  }
  for (let i = 0; i < 256; i++) {
    let v = i;
    for (let bit = 0; bit < 8; bit++) v = v & 0x80 ? ((v << 1) ^ 7) & 0xff : (v << 1) & 0xff;
    crc8_table[i] = v;
  }
})();

/** CCRC32::UpdateCRC */
export function UpdateCRC32(dwCrcAccum: number, p: Uint8Array, off = 0, nSize = p.length - off): number {
  let crc = dwCrcAccum >>> 0;
  for (let i = 0; i < nSize; i++) {
    crc = (crc32_table[(p[off + i] ^ (crc >>> 24)) & 0xff]! ^ ((crc << 8) >>> 0)) >>> 0;
  }
  return crc >>> 0;
}

/** CCRC8::UpdateCRC */
export function UpdateCRC8(dwCrcKey: number, p: Uint8Array, off = 0, nSize = p.length - off): number {
  let crc = dwCrcKey & 0xff;
  for (let i = 0; i < nSize; i++) crc = crc8_table[crc ^ p[off + i]!]!;
  return crc;
}
