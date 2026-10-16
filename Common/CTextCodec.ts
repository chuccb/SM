import iconv from "iconv-lite";
import { CProtocolError } from "./CProtocolError.ts";

export type LegacyEncoding = "big5" | "cp949" | "gb18030" | "utf8";
/** Original char strings are bytes in the deployment's ANSI codepage, not UTF-8. */
export class CTextCodec {
  constructor(readonly encoding: LegacyEncoding = "big5") {}
  Encode(text: string): Buffer {
    if (text.includes("\0")) throw new CProtocolError("NUL in a legacy string");
    const bytes = iconv.encode(text, this.encoding);
    if (iconv.decode(bytes, this.encoding) !== text)
      throw new CProtocolError(
        `String is not representable in ${this.encoding}`,
      );
    return bytes;
  }
  Decode(bytes: Uint8Array): string {
    if (bytes.includes(0)) throw new CProtocolError("NUL in a legacy string");
    const text = iconv.decode(Buffer.from(bytes), this.encoding);
    if (!iconv.encode(text, this.encoding).equals(Buffer.from(bytes)))
      throw new CProtocolError(`Invalid ${this.encoding} bytes`);
    return text;
  }
  AssertSize(text: string, maxBytes: number, name: string, minimum = 0): void {
    const length = this.Encode(text).length;
    if (length < minimum || length > maxBytes)
      throw new CProtocolError(
        `${name} must be ${minimum}..${maxBytes} encoded bytes`,
      );
  }
}
export const DefaultTextCodec = new CTextCodec();
