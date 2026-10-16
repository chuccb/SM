import { CRCPolynomial } from "./OfficialValues.ts";

// Non-reflected CRCs. zlib/crc32 and the Ethernet CRC final XOR are not compatible.
const crc8_table = Uint8Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit++)
    crc = ((crc << 1) ^ (crc & 0x80 ? CRCPolynomial.CRC8 : 0)) & 0xff;
  return crc;
});
const crc_table = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = (byte << 24) >>> 0;
  for (let bit = 0; bit < 8; bit++)
    crc = ((crc << 1) ^ (crc & 0x80000000 ? CRCPolynomial.CRC32 : 0)) >>> 0;
  return crc;
});
export class CCRC8 {
  static UpdateCRC(dwCrcKey: number, p: Uint8Array): number {
    let crc = dwCrcKey & 0xff;
    for (const byte of p) crc = crc8_table[crc ^ byte]!;
    return crc;
  }
}
export class CCRC32 {
  static UpdateCRC(dwCrcAccum: number, p: Uint8Array): number {
    let crc = dwCrcAccum >>> 0;
    for (const byte of p)
      crc = (crc_table[(crc >>> 24) ^ byte]! ^ (crc << 8)) >>> 0;
    return crc;
  }
}
/** zlib adler32(0, buffer, size), NOT the usual initial value 1. */
export function adler32(initial: number, p: Uint8Array): number {
  let a = initial & 0xffff;
  let b = initial >>> 16;
  for (const byte of p) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}
