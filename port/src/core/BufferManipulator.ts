/**
 * CBufferManipulator — the raw big-endian byte-order helpers used by every
 * packet in the original binaries.
 *
 *  - Encode*  : plain big-endian stores.
 *  - Encrypt* : same, but the value is XOR-masked first (used when a packet's
 *               cipher degree is >= 1; the suite ships with cipher degree 0 for
 *               all client/server links, the encrypted paths are kept for
 *               completeness).
 */

export const ENCRYPT_MASK_1 = 0x5a;
export const ENCRYPT_MASK_2 = 0xa569;
export const ENCRYPT_MASK_4 = 0x96ca5395;

export function Encode1(pDes: Uint8Array, off: number, n: number): void {
  pDes[off] = n & 0xff;
}

export function Encode2(pDes: Uint8Array, off: number, n: number): void {
  pDes[off] = (n >>> 8) & 0xff;
  pDes[off + 1] = n & 0xff;
}

export function Encode4(pDes: Uint8Array, off: number, n: number): void {
  pDes[off] = (n >>> 24) & 0xff;
  pDes[off + 1] = (n >>> 16) & 0xff;
  pDes[off + 2] = (n >>> 8) & 0xff;
  pDes[off + 3] = n & 0xff;
}

export function Decode1(pSrc: Uint8Array, off: number): number {
  return pSrc[off];
}

export function Decode2(pSrc: Uint8Array, off: number): number {
  return ((pSrc[off] << 8) | pSrc[off + 1]) & 0xffff;
}

export function Decode4(pSrc: Uint8Array, off: number): number {
  return ((pSrc[off] << 24) | (pSrc[off + 1] << 16) | (pSrc[off + 2] << 8) | pSrc[off + 3]) >>> 0;
}

export function EncodeBuffer(pDes: Uint8Array, off: number, pSrc: Uint8Array, srcOff: number, len: number): void {
  pDes.set(pSrc.subarray(srcOff, srcOff + len), off);
}

export function Decrypt1(pSrc: Uint8Array, off: number): number {
  return (pSrc[off] ^ ENCRYPT_MASK_1) & 0xff;
}

export function Decrypt2(pSrc: Uint8Array, off: number): number {
  return (Decode2(pSrc, off) ^ ENCRYPT_MASK_2) & 0xffff;
}

export function Decrypt4(pSrc: Uint8Array, off: number): number {
  return (Decode4(pSrc, off) ^ ENCRYPT_MASK_4) >>> 0;
}

export function DecryptBuffer(pDes: Uint8Array, pSrc: Uint8Array, len: number): void {
  pDes.set(pSrc.subarray(0, len));
}
