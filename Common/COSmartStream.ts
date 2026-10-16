import { deflateSync } from "node:zlib";
import { SmartStreamFormat } from "./OfficialValues.ts";
import { RuntimePolicy } from "./RuntimePolicy.ts";
import { CProtocolError } from "./CProtocolError.ts";
import { adler32 } from "./CCRC.ts";
import { DefaultTextCodec, type CTextCodec } from "./CTextCodec.ts";

/** LS 0042B860 / 0042BE30..0042BE60. SmartStream uses LE scalars and u32 strings. */
export class COSmartStream {
  private parts: Buffer[] = [];
  private length = 0;
  private cached: Buffer | undefined;
  constructor(readonly text: CTextCodec = DefaultTextCodec) {}
  Clear(): void {
    this.parts = [];
    this.length = 0;
    this.cached = undefined;
  }
  EncodeBuffer(bytes: Uint8Array): this {
    if (this.length + bytes.length > RuntimePolicy.MaxSmartStreamBytes)
      throw new CProtocolError("SmartStream too large");
    this.parts.push(Buffer.from(bytes));
    this.length += bytes.length;
    this.cached = undefined;
    return this;
  }
  Encode1(n: number): this {
    return this.EncodeBuffer(Buffer.from([n & 0xff]));
  }
  Encode2(n: number): this {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n & 0xffff);
    return this.EncodeBuffer(b);
  }
  Encode4(n: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0);
    return this.EncodeBuffer(b);
  }
  EncodeStr(text: string): this {
    const b = this.text.Encode(text);
    return this.Encode4(b.length).EncodeBuffer(b);
  }
  GetRawBuffer(): Buffer {
    return Buffer.concat(this.parts, this.length);
  }
  GetBuffer(): Buffer {
    if (this.cached) return Buffer.from(this.cached);
    const raw = this.GetRawBuffer();
    const compressed = raw.length
      ? deflateSync(raw, { level: SmartStreamFormat.CompressionLevel })
      : Buffer.alloc(0);
    let payload: Buffer;
    if (raw.length && compressed.length + 4 < raw.length) {
      const header = Buffer.alloc(5);
      header[0] = SmartStreamFormat.Deflate;
      header.writeUInt32LE(raw.length, 1);
      payload = Buffer.concat([header, compressed]);
    } else payload = Buffer.concat([Buffer.from([SmartStreamFormat.Raw]), raw]);
    const header = Buffer.alloc(5);
    header[0] = SmartStreamFormat.Magic;
    header.writeUInt32LE(payload.length, 1);
    this.cached = Buffer.concat([header, payload]);
    return Buffer.from(this.cached);
  }
  GetBufferSize(): number {
    return this.GetBuffer().length;
  }
  GetHashValue(): number {
    return this.length === 0 ? 0 : adler32(0, this.GetBuffer().subarray(5));
  }
}
