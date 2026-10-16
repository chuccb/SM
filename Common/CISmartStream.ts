import { inflateSync } from "node:zlib";
import { SmartStreamFormat } from "./OfficialValues.ts";
import { RuntimePolicy } from "./RuntimePolicy.ts";
import { CProtocolError } from "./CProtocolError.ts";
import { adler32 } from "./CCRC.ts";
import { DefaultTextCodec, type CTextCodec } from "./CTextCodec.ts";

/** LS 0042B750 / 0042BF00 / 0042C330. Size validation intentionally hardened. */
export class CISmartStream {
  readonly pRawBuf: Buffer;
  readonly bytesRead: number;
  readonly nCompHash: number;
  posDecode = 0;
  constructor(
    bytes: Uint8Array,
    readonly text: CTextCodec = DefaultTextCodec,
  ) {
    const buf = Buffer.from(bytes);
    if (buf.length < 6 || buf[0] !== SmartStreamFormat.Magic)
      throw new CProtocolError("Wrong SmartStream magic or truncated header");
    const size = buf.readUInt32LE(1);
    if (
      size < 1 ||
      size > RuntimePolicy.MaxSmartStreamBytes ||
      size + 5 > buf.length
    )
      throw new CProtocolError("Invalid SmartStream size");
    const payload = buf.subarray(5, size + 5);
    this.bytesRead = size + 5;
    if (payload[0] === SmartStreamFormat.Raw)
      this.pRawBuf = Buffer.from(payload.subarray(1));
    else if (payload[0] === SmartStreamFormat.Deflate && size >= 5) {
      const rawSize = payload.readUInt32LE(1);
      if (rawSize > RuntimePolicy.MaxSmartStreamBytes)
        throw new CProtocolError("SmartStream inflate limit");
      try {
        this.pRawBuf = inflateSync(payload.subarray(5), {
          maxOutputLength: Math.max(rawSize, 1),
        });
      } catch {
        throw new CProtocolError("Invalid compressed SmartStream");
      }
      if (this.pRawBuf.length !== rawSize)
        throw new CProtocolError("SmartStream raw length mismatch");
    } else throw new CProtocolError("Unknown SmartStream compression type");
    this.nCompHash = this.pRawBuf.length ? adler32(0, payload) : 0;
  }
  get remaining(): number {
    return this.pRawBuf.length - this.posDecode;
  }
  GetHashValue(): number {
    return this.nCompHash;
  }
  IsEOS(): boolean {
    return this.remaining === 0;
  }
  DecodeBuffer(size: number): Buffer {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.remaining)
      throw new CProtocolError("Not enough SmartStream decode buffer");
    const out = Buffer.from(
      this.pRawBuf.subarray(this.posDecode, this.posDecode + size),
    );
    this.posDecode += size;
    return out;
  }
  Decode1(): number {
    return this.DecodeBuffer(1).readUInt8();
  }
  Decode2(): number {
    return this.DecodeBuffer(2).readUInt16LE();
  }
  Decode4(): number {
    return this.DecodeBuffer(4).readUInt32LE();
  }
  DecodeStr(): string {
    return this.text.Decode(this.DecodeBuffer(this.Decode4()));
  }
}
