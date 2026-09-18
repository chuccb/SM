/**
 * COSmartStream / CISmartStream — compressed sub-streams embedded in packets
 * (guild lists, item databases, ...).
 *
 * Buffer format (CompressBuffernCalcCRC):
 *   [0]      magic 24 (0x18)
 *   [1..4]   inner length, little-endian
 *   [5..]    inner:
 *              [0]=1 : [1..4] raw size (LE) + zlib-compressed (level 9) data
 *              [0]=0 : raw data stored verbatim
 *            (the compressed form is used only when it is actually smaller)
 *
 * NOTE: unlike packets, the fields *inside* a smart stream are little-endian
 * (they are plain memory stores in the original code) — Encode2/Encode4/
 * EncodeStr + Decode1/Decode2/Decode4/DecodeStr below mirror that.
 */
import { deflateSync, inflateSync } from "node:zlib";

export function adler32(buf: Uint8Array, off = 0, len = buf.length - off): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < len; i++) {
    a = (a + buf[off + i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

export class COSmartStream {
  pRawBuf: Uint8Array = new Uint8Array(0);
  sizeRawBuf = 0;
  private pCompBuf: Uint8Array | null = null;
  private nCompHash = 0;
  private bValidCompBuf = 0;

  Clear(): void {
    this.pRawBuf = new Uint8Array(0);
    this.sizeRawBuf = 0;
    this.pCompBuf = null;
    this.sizeCompBuf = 0;
    this.bValidCompBuf = 0;
  }

  EncodeBuffer(pBuf: Uint8Array, len = pBuf.length): void {
    const nb = new Uint8Array(this.sizeRawBuf + len);
    nb.set(this.pRawBuf.subarray(0, this.sizeRawBuf));
    nb.set(pBuf.subarray(0, len), this.sizeRawBuf);
    this.pRawBuf = nb;
    this.sizeRawBuf += len;
    this.bValidCompBuf = 0;
  }

  Encode1(n: number): void {
    this.EncodeBuffer(Uint8Array.of(n & 0xff), 1);
  }
  Encode2(n: number): void {
    this.EncodeBuffer(Uint8Array.of(n & 0xff, (n >>> 8) & 0xff), 2);
  }
  Encode4(n: number): void {
    this.EncodeBuffer(Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff), 4);
  }
  EncodeStr(str: string): void {
    const len = str.length;
    this.Encode4(len);
    const buf = new Uint8Array(len);
    for (let i = 0; i < len; i++) buf[i] = str.charCodeAt(i) & 0xff;
    this.EncodeBuffer(buf, len);
  }

  /** COSmartStream::CompressBuffernCalcCRC */
  CompressBuffernCalcCRC(): void {
    let comp: Uint8Array | null = null;
    if (this.sizeRawBuf !== 0) comp = deflateSync(this.pRawBuf.subarray(0, this.sizeRawBuf), { level: 9 });
    if (comp !== null && comp.length + 4 < this.sizeRawBuf && this.sizeRawBuf !== 0) {
      // compressed form
      const inner = new Uint8Array(5 + comp.length);
      inner[0] = 1;
      const rawSize = this.sizeRawBuf;
      inner[1] = rawSize & 0xff;
      inner[2] = (rawSize >>> 8) & 0xff;
      inner[3] = (rawSize >>> 16) & 0xff;
      inner[4] = (rawSize >>> 24) & 0xff;
      inner.set(comp, 5);
      this.sizeCompBuf = inner.length + 5;
      const outer = new Uint8Array(this.sizeCompBuf);
      outer[0] = 24;
      const innerLen = inner.length;
      outer[1] = innerLen & 0xff;
      outer[2] = (innerLen >>> 8) & 0xff;
      outer[3] = (innerLen >>> 16) & 0xff;
      outer[4] = (innerLen >>> 24) & 0xff;
      outer.set(inner, 5);
      this.pCompBuf = outer;
    } else {
      // stored form
      const inner = new Uint8Array(1 + this.sizeRawBuf);
      inner[0] = 0;
      inner.set(this.pRawBuf.subarray(0, this.sizeRawBuf), 1);
      this.sizeCompBuf = inner.length + 5;
      const outer = new Uint8Array(this.sizeCompBuf);
      outer[0] = 24;
      const innerLen = inner.length;
      outer[1] = innerLen & 0xff;
      outer[2] = (innerLen >>> 8) & 0xff;
      outer[3] = (innerLen >>> 16) & 0xff;
      outer[4] = (innerLen >>> 24) & 0xff;
      outer.set(inner, 5);
      this.pCompBuf = outer;
    }
    this.nCompHash = this.sizeRawBuf !== 0 ? adler32(this.pCompBuf!, 5, this.sizeCompBuf - 5) : 0;
    this.bValidCompBuf = 1;
  }

  GetHashValue(): number {
    if (this.bValidCompBuf === 0) this.CompressBuffernCalcCRC();
    return this.nCompHash;
  }

  sizeCompBuf = 0;

  GetBufferSize(): number {
    if (this.bValidCompBuf === 0) this.CompressBuffernCalcCRC();
    return this.sizeCompBuf;
  }

  GetBuffer(): Uint8Array {
    if (this.bValidCompBuf === 0) this.CompressBuffernCalcCRC();
    return this.pCompBuf!;
  }
}

export class CISmartStream {
  pRawBuf: Uint8Array = new Uint8Array(0);
  sizeRawBuf = 0;
  posDecode = 0;
  nCompHash = 0;

  IsEOS(): boolean {
    return this.sizeRawBuf === this.posDecode;
  }

  GetHashValue(): number {
    return this.nCompHash;
  }

  /** CISmartStream::CalcCRCnUncompressBuffer */
  CalcCRCnUncompressBuffer(pBuf: Uint8Array, off: number, nSize: number): void {
    this.nCompHash = adler32(pBuf, off, nSize);
    if (pBuf[off] === 0) {
      this.sizeRawBuf = nSize - 1;
      this.pRawBuf = pBuf.slice(off + 1, off + 1 + this.sizeRawBuf);
    } else if (pBuf[off] === 1) {
      const rawSize =
        (pBuf[off + 1]! | (pBuf[off + 2]! << 8) | (pBuf[off + 3]! << 16) | (pBuf[off + 4]! << 24)) >>> 0;
      this.sizeRawBuf = rawSize;
      this.pRawBuf = inflateSync(pBuf.subarray(off + 5, off + nSize));
    }
    this.posDecode = 0;
  }

  /**
   * CISmartStream::SetBuffer — parse a buffer produced by COSmartStream.
   * Returns the number of bytes consumed (inner length + 5-byte header).
   */
  SetBuffer(pBuf: Uint8Array, _off = 0): number {
    if (pBuf[0] !== 24) throw new Error("[CISmartStream::SetBuffer(LPCBYTE)] wrong magic number");
    const v4 =
      (pBuf[1]! | (pBuf[2]! << 8) | (pBuf[3]! << 16) | (pBuf[4]! << 24)) >>> 0;
    if (v4 !== 0) {
      this.CalcCRCnUncompressBuffer(pBuf, 5, v4);
    } else {
      this.pRawBuf = new Uint8Array(0);
      this.sizeRawBuf = 0;
      this.nCompHash = 0;
      this.posDecode = 0;
    }
    return v4 + 5;
  }

  DecodeBuffer(len: number): Uint8Array {
    if (this.sizeRawBuf - this.posDecode < len)
      throw new Error("[CISmartStream::DecodeBuffer] not enough decode buffer");
    const out = this.pRawBuf.subarray(this.posDecode, this.posDecode + len);
    this.posDecode += len;
    return out;
  }

  Decode1(): number {
    return this.DecodeBuffer(1)[0]!;
  }
  Decode2(): number {
    const b = this.DecodeBuffer(2);
    return (b[0]! | (b[1]! << 8)) & 0xffff;
  }
  Decode4(): number {
    const b = this.DecodeBuffer(4);
    return ((b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0);
  }
  DecodeStr(): string {
    const len = this.Decode4();
    if (this.sizeRawBuf - this.posDecode < len)
      throw new Error("[CISmartStream::DecodeStr] not enough decode buffer");
    let str = "";
    for (let i = 0; i < len; i++) str += String.fromCharCode(this.pRawBuf[this.posDecode++]!);
    return str;
  }
}
