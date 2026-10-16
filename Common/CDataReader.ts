import { CProtocolError } from "./CProtocolError.ts";
import { DefaultTextCodec, type CTextCodec } from "./CTextCodec.ts";

/** Bounds-checked substitute for the original pointer-walking LE resource readers. */
export class CDataReader {
  readonly buffer: Buffer;
  offset = 0;
  constructor(
    bytes: Uint8Array,
    readonly text: CTextCodec = DefaultTextCodec,
  ) {
    this.buffer = Buffer.from(bytes);
  }
  get remaining(): number {
    return this.buffer.length - this.offset;
  }
  bytes(length: number): Buffer {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining)
      throw new CProtocolError(`Truncated resource at ${this.offset}`);
    const out = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }
  u8(): number {
    return this.bytes(1).readUInt8();
  }
  u16(): number {
    return this.bytes(2).readUInt16LE();
  }
  i32(): number {
    return this.bytes(4).readInt32LE();
  }
  u32(): number {
    return this.bytes(4).readUInt32LE();
  }
  string(maxLength = 127): string {
    const n = this.u32();
    if (n > maxLength) throw new CProtocolError("Resource string too long");
    return this.text.Decode(this.bytes(n));
  }
  end(): void {
    if (this.remaining)
      throw new CProtocolError(`Resource has ${this.remaining} trailing bytes`);
  }
}
