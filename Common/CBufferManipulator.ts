import { ScalarCipher } from "./OfficialValues.ts";

/** LS 00422FC0..00423260. Packet integers are BIG endian; raw buffers are unchanged. */
export class CBufferManipulator {
  static Encode1(pDes: Buffer, n: number, at = 0): void {
    pDes.writeUInt8(n & 0xff, at);
  }
  static Encode2(pDes: Buffer, n: number, at = 0): void {
    pDes.writeUInt16BE(n & 0xffff, at);
  }
  static Encode4(pDes: Buffer, n: number, at = 0): void {
    pDes.writeUInt32BE(n >>> 0, at);
  }
  static Decode1(pSrc: Buffer, at = 0): number {
    return pSrc.readUInt8(at);
  }
  static Decode2(pSrc: Buffer, at = 0): number {
    return pSrc.readUInt16BE(at);
  }
  static Decode4(pSrc: Buffer, at = 0): number {
    return pSrc.readUInt32BE(at);
  }
  static Encrypt1(pDes: Buffer, n: number, at = 0): void {
    this.Encode1(pDes, n ^ ScalarCipher.ByteXor, at);
  }
  static Encrypt2(pDes: Buffer, n: number, at = 0): void {
    this.Encode2(pDes, n ^ ScalarCipher.WordXor, at);
  }
  static Encrypt4(pDes: Buffer, n: number, at = 0): void {
    this.Encode4(pDes, n ^ ScalarCipher.DwordXor, at);
  }
  static Decrypt1(pSrc: Buffer, at = 0): number {
    return this.Decode1(pSrc, at) ^ ScalarCipher.ByteXor;
  }
  static Decrypt2(pSrc: Buffer, at = 0): number {
    return this.Decode2(pSrc, at) ^ ScalarCipher.WordXor;
  }
  static Decrypt4(pSrc: Buffer, at = 0): number {
    return (this.Decode4(pSrc, at) ^ ScalarCipher.DwordXor) >>> 0;
  }
}
