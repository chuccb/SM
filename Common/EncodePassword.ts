import { CProtocolError } from "./CProtocolError.ts";

/** LS EncodePassword @ 00423A70: UU-style 6-bit, not MD5/Base64 or encryption.
 * Original stops at NUL and makes out-of-bounds lookaheads. Here input is bounded,
 * NUL is rejected and missing tail bytes are zero, matching ordinary C strings.
 * This is for legacy migration ONLY; new accounts use Argon2id. */
export function EncodePassword(input: Uint8Array): Buffer {
  if (input.includes(0) || input.length > 63)
    throw new CProtocolError(
      "Legacy password input cannot contain NUL or exceed 63 bytes",
    );
  const enc = (n: number) => (n === 0 ? 96 : (n & 63) + 32);
  const result: number[] = [enc(input.length)];
  for (let i = 0; i < input.length; i += 3) {
    const a = input[i]!;
    const b = input[i + 1] ?? 0;
    const c = input[i + 2] ?? 0;
    // signed char >> 2 in the original still produces the same low six bits.
    result.push(enc(a >> 2), enc(((a & 3) << 4) | (b >> 4)));
    if (!b) break;
    result.push(enc(((b & 15) << 2) | (c >> 6)));
    if (!c) break;
    result.push(enc(c & 63));
  }
  return Buffer.from(result);
}
