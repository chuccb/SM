/**
 * decode_probe — brute-force a captured client frame's cipher convention.
 *
 *   bun tools/decode_probe.ts 0FA560....            (hex, one frame)
 *
 * Tries every cipher degree, every SES3/CRC key 0..255 (plus base+seq
 * compounds), and reports every combination whose CRC verifies and whose
 * first decrypted byte looks like a plausible packet type.
 */
import { SimpleStreamDecrypt3 } from "../src/core/StreamCipher.ts";
import { UpdateCRC8, UpdateCRC32 } from "../src/core/CRC.ts";

const bytes = Uint8Array.from(
  (process.argv[2] ?? "").replace(/[^0-9a-fA-F]/g, "").match(/../g)!.map((h) => parseInt(h, 16)),
);
console.log(`frame (${bytes.length}B):`, Array.from(bytes).map((x) => x.toString(16).padStart(2, "0")).join(" "));
const code = bytes[0]!;
for (const deg of [0, 1, 2] as const) {
  const hdr = deg === 0 ? 3 : deg === 1 ? 7 : 4;
  if (bytes.length < hdr) continue;
  const field = ((bytes[1]! << 8) | bytes[2]!) ^ 0xa569;
  const fieldRaw = (bytes[1]! << 8) | bytes[2]!;
  const expect = deg === 0 ? fieldRaw + 3 : field + hdr;
  console.log(
    `deg${deg}: len field = ${deg === 0 ? fieldRaw : field} (+${hdr} = ${expect}) — ${expect === bytes.length ? "MATCHES frame size" : "does NOT match frame size " + bytes.length}`,
  );
}
for (const deg of [2, 1] as const) {
  const bodyLen = deg === 2 ? bytes.length - 4 : bytes.length - 7;
  if (bodyLen <= 0) continue;
  const trailerRaw = bytes[bytes.length - 1]!;
  const trailer = trailerRaw ^ 0x5a;
  const hits: string[] = [];
  for (let key = 0; key < 256; key++) {
    const body = new Uint8Array(bodyLen);
    if (deg === 2) {
      SimpleStreamDecrypt3(bytes, 3, body, 0, bodyLen, key);
      const type = body[0]! ^ 0x5a;
      const hex = Array.from(body).map((x) => x.toString(16).padStart(2, "0")).join(" ");
      if (UpdateCRC8(key, body, 0, bodyLen) === trailer)
        hits.push(`deg2 SES3(k=${key}) CRC8(seed=k) OK  type=${type} body=${hex}`);
      if (UpdateCRC8(0, body, 0, bodyLen) === trailer)
        hits.push(`deg2 SES3(k=${key}) CRC8(seed=0) OK  type=${type} body=${hex}`);
      if (UpdateCRC8(key, bytes, 3, bodyLen) === trailer)
        hits.push(`deg2 SES3(k=${key}) CRC8-over-CIPHERTEXT(seed=k) OK  type=${type}`);
      if (UpdateCRC8(key, body, 0, bodyLen) === trailerRaw)
        hits.push(`deg2 SES3(k=${key}) CRC8(seed=k) OK [trailer not ^5A]  type=${type} body=${hex}`);
      if (UpdateCRC8(key, bytes, 3, bodyLen) === trailerRaw)
        hits.push(`deg2 SES3(k=${key}) CRC8-ciphertext(seed=k) OK [trailer not ^5A]`);
    } else {
      SimpleStreamDecrypt3(bytes, 3, body, 0, bodyLen, key);
      const crc32 = (bytes[bytes.length - 4]! << 24) | (bytes[bytes.length - 3]! << 16) | (bytes[bytes.length - 2]! << 8) | bytes[bytes.length - 1]!;
      if (UpdateCRC32(key, body, 0, bodyLen) === (crc32 >>> 0)) {
        hits.push(`deg1 key=${key} (0x${key.toString(16)}) type=${body[0]! ^ 0x5a}`);
      }
    }
  }
  // no-SES3 fallback: plain body + CRC8
  for (let key = 0; key < 256; key++) {
    if (UpdateCRC8(key, bytes, 3, bodyLen) === trailer) {
      hits.push(`deg2 NO-SES3 CRC8(seed=${key}) OK  type=${bytes[3]! ^ 0x5a} body=${Array.from(bytes.subarray(3, 3 + bodyLen)).map((x) => x.toString(16).padStart(2, "0")).join(" ")}`);
      break;
    }
  }
  console.log(hits.length ? hits.join("\n") : `deg${deg}: no key in 0..255 verifies under any variant${deg === 2 ? ` (trailer byte raw=${trailerRaw}, ^5A=${trailer})` : ""}`);
  if (deg === 1) break;
}
console.log(`(frame code byte = ${code} = 0x${code.toString(16)}; server expected (ht+231)^(192+rcvSeq))`);
