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
import { EncodeCP950, DecodeCP950 } from "./Encoding.ts";

declare const Bun: {
  deflateSync(data: Uint8Array | ArrayBufferView, options?: { level?: number }): Uint8Array;
  inflateSync(data: Uint8Array | ArrayBufferView): Uint8Array;
} | undefined;

const ADLER32_MODULUS = 65_521;
const U8_BYTES = Uint8Array.BYTES_PER_ELEMENT;
const U16_BYTES = Uint16Array.BYTES_PER_ELEMENT;
const U32_BYTES = Uint32Array.BYTES_PER_ELEMENT;
const SMART_STREAM_MAGIC = 0x18;
const SMART_STREAM_MAGIC_BYTES = U8_BYTES;
const SMART_STREAM_INNER_FLAG_BYTES = U8_BYTES;
const SMART_STREAM_RAW_SIZE_BYTES = U32_BYTES;
const SMART_STREAM_HEADER_BYTES = SMART_STREAM_MAGIC_BYTES + SMART_STREAM_RAW_SIZE_BYTES;
const SMART_STREAM_STORED = 0;
const SMART_STREAM_COMPRESSED = 1;
const SMART_STREAM_DEFLATE_LEVEL = 9;

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function WriteU32LE(target: Uint8Array, offset: number, value: number): void {
  dataView(target).setUint32(offset, value, true);
}

function ReadU32LE(source: Uint8Array, offset: number): number {
  return dataView(source).getUint32(offset, true);
}

function WrapSmartStream(inner: Uint8Array): Uint8Array {
  const outer = new Uint8Array(SMART_STREAM_HEADER_BYTES + inner.length);
  outer[0] = SMART_STREAM_MAGIC;
  WriteU32LE(outer, SMART_STREAM_MAGIC_BYTES, inner.length);
  outer.set(inner, SMART_STREAM_HEADER_BYTES);
  return outer;
}

export function adler32(buf: Uint8Array, off = 0, len = buf.length - off): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < len; i++) {
    a = (a + buf[off + i]!) % ADLER32_MODULUS;
    b = (b + a) % ADLER32_MODULUS;
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
    this.EncodeBuffer(Uint8Array.of(n));
  }
  Encode2(n: number): void {
    const bytes = new Uint8Array(U16_BYTES);
    dataView(bytes).setUint16(0, n, true);
    this.EncodeBuffer(bytes);
  }
  Encode4(n: number): void {
    const bytes = new Uint8Array(U32_BYTES);
    dataView(bytes).setUint32(0, n, true);
    this.EncodeBuffer(bytes);
  }
  EncodeStr(str: string): void {
    const raw = EncodeCP950(str);
    const len = raw.length;
    this.Encode4(len);
    this.EncodeBuffer(raw);
  }

  /** COSmartStream::CompressBuffernCalcCRC */
  CompressBuffernCalcCRC(): void {
    const raw = this.pRawBuf.subarray(0, this.sizeRawBuf);
    const compressed = this.sizeRawBuf === 0
      ? null
      : typeof Bun !== "undefined" && typeof Bun.deflateSync === "function"
        ? Bun.deflateSync(raw, { level: SMART_STREAM_DEFLATE_LEVEL })
        : deflateSync(raw, { level: SMART_STREAM_DEFLATE_LEVEL });

    let inner: Uint8Array;
    if (
      compressed !== null &&
      compressed.length + SMART_STREAM_RAW_SIZE_BYTES < this.sizeRawBuf
    ) {
      inner = new Uint8Array(
        SMART_STREAM_INNER_FLAG_BYTES + SMART_STREAM_RAW_SIZE_BYTES + compressed.length,
      );
      inner[0] = SMART_STREAM_COMPRESSED;
      WriteU32LE(inner, SMART_STREAM_INNER_FLAG_BYTES, this.sizeRawBuf);
      inner.set(
        compressed,
        SMART_STREAM_INNER_FLAG_BYTES + SMART_STREAM_RAW_SIZE_BYTES,
      );
    } else {
      inner = new Uint8Array(SMART_STREAM_INNER_FLAG_BYTES + this.sizeRawBuf);
      inner[0] = SMART_STREAM_STORED;
      inner.set(raw, SMART_STREAM_INNER_FLAG_BYTES);
    }

    this.pCompBuf = WrapSmartStream(inner);
    this.sizeCompBuf = this.pCompBuf.length;
    this.nCompHash = this.sizeRawBuf === 0
      ? 0
      : adler32(
        this.pCompBuf,
        SMART_STREAM_HEADER_BYTES,
        this.sizeCompBuf - SMART_STREAM_HEADER_BYTES,
      );
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
    if (pBuf[off] === SMART_STREAM_STORED) {
      this.sizeRawBuf = nSize - SMART_STREAM_INNER_FLAG_BYTES;
      this.pRawBuf = pBuf.slice(
        off + SMART_STREAM_INNER_FLAG_BYTES,
        off + SMART_STREAM_INNER_FLAG_BYTES + this.sizeRawBuf,
      );
    } else if (pBuf[off] === SMART_STREAM_COMPRESSED) {
      this.sizeRawBuf = ReadU32LE(pBuf, off + SMART_STREAM_INNER_FLAG_BYTES);
      const compressedSlice = pBuf.subarray(
        off + SMART_STREAM_INNER_FLAG_BYTES + SMART_STREAM_RAW_SIZE_BYTES,
        off + nSize,
      );
      this.pRawBuf = typeof Bun !== "undefined" && typeof Bun.inflateSync === "function"
        ? Bun.inflateSync(compressedSlice)
        : inflateSync(compressedSlice);
    }
    this.posDecode = 0;
  }

  /**
   * CISmartStream::SetBuffer — parse a buffer produced by COSmartStream.
   * Returns the number of bytes consumed (inner length + outer header).
   */
  SetBuffer(pBuf: Uint8Array): number {
    if (pBuf[0] !== SMART_STREAM_MAGIC) {
      throw new Error("[CISmartStream::SetBuffer(LPCBYTE)] wrong magic number");
    }
    const compLen = ReadU32LE(pBuf, SMART_STREAM_MAGIC_BYTES);
    if (compLen !== 0) {
      this.CalcCRCnUncompressBuffer(pBuf, SMART_STREAM_HEADER_BYTES, compLen);
    } else {
      this.pRawBuf = new Uint8Array(0);
      this.sizeRawBuf = 0;
      this.nCompHash = 0;
      this.posDecode = 0;
    }
    return compLen + SMART_STREAM_HEADER_BYTES;
  }

  DecodeBuffer(len: number): Uint8Array {
    if (this.sizeRawBuf - this.posDecode < len)
      throw new Error("[CISmartStream::DecodeBuffer] not enough decode buffer");
    const out = this.pRawBuf.subarray(this.posDecode, this.posDecode + len);
    this.posDecode += len;
    return out;
  }

  Decode1(): number {
    return this.DecodeBuffer(U8_BYTES)[0]!;
  }
  Decode2(): number {
    return dataView(this.DecodeBuffer(U16_BYTES)).getUint16(0, true);
  }
  Decode4(): number {
    return dataView(this.DecodeBuffer(U32_BYTES)).getUint32(0, true);
  }
  DecodeStr(): string {
    const len = this.Decode4();
    if (this.sizeRawBuf - this.posDecode < len)
      throw new Error("[CISmartStream::DecodeStr] not enough decode buffer");
    const raw = this.pRawBuf.subarray(this.posDecode, this.posDecode + len);
    this.posDecode += len;
    return DecodeCP950(raw);
  }
}
