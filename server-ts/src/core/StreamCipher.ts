/**
 * SimpleStreamEncrypt3 / SimpleStreamDecrypt3 — the stream cipher applied to
 * cipher-degree >= 1 payloads and to login credential strings
 * (CxLogin.exe.c:39520 / 39580).
 *
 *   seed     = key ^ 0x53351D9C
 *   word i   : out_i = in_i ^ seed_i ^ in_(i-1)      (CBC over PLAINTEXT words,
 *              seed_i = seed_(i-1) - 0x63D50CC3, out_0 = in_0 ^ seed)
 *   tail     : the (len & 3) trailing bytes are XORed with
 *              (lastPlainWord >> 8j) — lastPlainWord being the last full
 *              PLAINTEXT word, or the seed itself when len < 4.
 *
 * All 32-bit accesses are little-endian (x86 `*(_DWORD *)`).
 */

export const STREAM_CIPHER_SEED_XOR = 0x53351d9c;
/** 0x63CAACE3 — read from the actual machine code of every server exe
 *  (`sub edx, 0x63CAACE3` at both SES3 loop sites). The decompile .c files
 *  carry 0x63D50CC3, which belongs to a different build: the exes ship
 *  `81 EA E3 AC CA 63` and none of them contains C3 0C D5 63. Verified
 *  against a live client frame: only this step makes CCRC8(key=40) match. */
export const STREAM_CIPHER_STEP = 0x63caace3; // 0x63CAACE3

function rdWord(buf: Uint8Array, off: number): number {
  return (buf[off]! | (buf[off + 1]! << 8) | (buf[off + 2]! << 16) | (buf[off + 3]! << 24)) >>> 0;
}

function wrWord(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >>> 8) & 0xff;
  buf[off + 2] = (v >>> 16) & 0xff;
  buf[off + 3] = (v >>> 24) & 0xff;
}

export function SimpleStreamEncrypt3(
  src: Uint8Array,
  srcOff: number,
  tar: Uint8Array,
  tarOff: number,
  len: number,
  key: number,
): void {
  const nDwords = len >>> 2;
  const nTail = len & 3;
  let seed = ((key >>> 0) ^ STREAM_CIPHER_SEED_XOR) >>> 0;
  let lastPlain = seed;
  if (nDwords !== 0) {
    let prev = rdWord(src, srcOff);
    wrWord(tar, tarOff, (prev ^ seed) >>> 0);
    for (let i = 1; i < nDwords; i++) {
      seed = (seed - STREAM_CIPHER_STEP) >>> 0;
      const plain = rdWord(src, srcOff + i * 4);
      wrWord(tar, tarOff + i * 4, (plain ^ seed ^ prev) >>> 0);
      prev = plain;
    }
    lastPlain = prev;
  }
  for (let j = 0; j < nTail; j++) {
    tar[tarOff + nDwords * 4 + j] = src[srcOff + nDwords * 4 + j]! ^ ((lastPlain >>> (8 * j)) & 0xff);
  }
}

export function SimpleStreamDecrypt3(
  src: Uint8Array,
  srcOff: number,
  tar: Uint8Array,
  tarOff: number,
  len: number,
  key: number,
): void {
  const nDwords = len >>> 2;
  const nTail = len & 3;
  let seed = ((key >>> 0) ^ STREAM_CIPHER_SEED_XOR) >>> 0;
  let lastPlain = seed;
  if (nDwords !== 0) {
    let prev = rdWord(src, srcOff) ^ seed;
    wrWord(tar, tarOff, prev >>> 0);
    for (let i = 1; i < nDwords; i++) {
      seed = (seed - STREAM_CIPHER_STEP) >>> 0;
      const plain = ((rdWord(src, srcOff + i * 4) ^ seed ^ prev) >>> 0);
      wrWord(tar, tarOff + i * 4, plain);
      prev = plain;
    }
    lastPlain = prev;
  }
  for (let j = 0; j < nTail; j++) {
    tar[tarOff + nDwords * 4 + j] = src[srcOff + nDwords * 4 + j]! ^ ((lastPlain >>> (8 * j)) & 0xff);
  }
}
