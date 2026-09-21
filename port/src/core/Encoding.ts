/**
 * CP950 / Big5 / UTF-8 boundary transcoding utilities.
 * Keeps SQLite DB and internal TS strings strictly UTF-8,
 * while transparently transcoding to/from official CP950 wire bytes.
 */
import { UNICODE_TO_CP950 } from "./CP950Table.ts";

const BIG5_DECODER = new TextDecoder("big5");

/**
 * Encode a UTF-8 / JavaScript string to CP950 / Big5 raw bytes.
 * If a character is within ASCII (0x00..0x7F), 1 byte is emitted.
 * If a character is mapped in CP950, 2 bytes are emitted.
 * If a character is a raw Latin-1 carrier byte (0x80..0xFF), 1 byte is preserved.
 * Otherwise, emits '?' (0x3F).
 */
export function EncodeCP950(str: string): Uint8Array {
  const bytes: number[] = [];
  const len = str.length;
  for (let i = 0; i < len; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0x7f) {
      bytes.push(code);
    } else {
      const mapped = UNICODE_TO_CP950[code] ?? 0;
      if (mapped !== 0) {
        bytes.push((mapped >> 8) & 0xff, mapped & 0xff);
      } else if (code <= 0xff) {
        // Fallback for raw byte carrier (e.g. legacy binary tokens or unmapped ANSI)
        bytes.push(code);
      } else {
        bytes.push(0x3f); // '?'
      }
    }
  }
  return new Uint8Array(bytes);
}

/**
 * Decode CP950 / Big5 raw bytes into a standard UTF-8 string.
 */
export function DecodeCP950(bytes: Uint8Array): string {
  return BIG5_DECODER.decode(bytes);
}
