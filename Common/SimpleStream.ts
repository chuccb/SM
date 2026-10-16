import { StreamCipher } from "./OfficialValues.ts";

/** Literal x86 DWORD translation of LS 00429EB0 and 00429F50.
 * No AES/RC4 substitution: the final 1..3 bytes use the LAST PLAINTEXT DWORD,
 * or the initial key when there are no full DWORDs. */
export function SimpleStreamEncrypt3(src: Uint8Array, key: number): Buffer {
  return transform(Buffer.from(src), key, false);
}
export function SimpleStreamDecrypt3(src: Uint8Array, key: number): Buffer {
  return transform(Buffer.from(src), key, true);
}
function transform(src: Buffer, key: number, decrypt: boolean): Buffer {
  const tar = Buffer.alloc(src.length);
  let rolling = (key ^ StreamCipher.InitialKeyXor) >>> 0;
  let previous = rolling;
  const words = Math.floor(src.length / 4);
  for (let i = 0; i < words; i++) {
    const input = src.readUInt32LE(i * 4);
    const output = (input ^ rolling ^ (i === 0 ? 0 : previous)) >>> 0;
    tar.writeUInt32LE(output, i * 4);
    previous = decrypt ? output : input;
    rolling = (rolling - StreamCipher.KeyDecrement) >>> 0;
  }
  for (let i = words * 4; i < src.length; i++)
    tar[i] = src[i]! ^ ((previous >>> ((i % 4) * 8)) & 0xff);
  return tar;
}
