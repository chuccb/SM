import { CBufferManipulator as BM } from "./CBufferManipulator.ts";
import { CipherDegree } from "./OfficialValues.ts";
import { CProtocolError } from "./CProtocolError.ts";
import { DefaultTextCodec, type CTextCodec } from "./CTextCodec.ts";
import { SimpleStreamDecrypt3 } from "./SimpleStream.ts";
import { CISmartStream } from "./CISmartStream.ts";

/** LS 0042A670..0042B0A0. Bounds violations throw instead of original zero+no advance. */
export class CReceivedPacketBase {
  m_uOffset = 0;
  readonly m_uLength: number;
  readonly m_nPacketType: number;
  readonly m_pBlock: Buffer;
  constructor(
    bytes: Uint8Array,
    readonly m_nCipherDegree: CipherDegree = CipherDegree.None,
    readonly text: CTextCodec = DefaultTextCodec,
  ) {
    this.m_pBlock = Buffer.from(bytes);
    this.m_uLength = bytes.length;
    if (!bytes.length) throw new CProtocolError("Empty packet");
    this.m_nPacketType = this.Decode1At(0);
  }
  get remaining(): number {
    return this.m_uLength - this.m_uOffset;
  }
  private require(at: number, size: number): void {
    if (
      !Number.isSafeInteger(at) ||
      !Number.isSafeInteger(size) ||
      at < 0 ||
      size < 0 ||
      at + size > this.m_uLength
    ) {
      throw new CProtocolError(
        `Truncated packet 0x${this.m_nPacketType?.toString(16)} at ${at}: need ${size} bytes`,
      );
    }
  }
  Decode1At(at: number): number {
    this.require(at, 1);
    return this.m_nCipherDegree
      ? BM.Decrypt1(this.m_pBlock, at)
      : BM.Decode1(this.m_pBlock, at);
  }
  Decode2At(at: number): number {
    this.require(at, 2);
    return this.m_nCipherDegree
      ? BM.Decrypt2(this.m_pBlock, at)
      : BM.Decode2(this.m_pBlock, at);
  }
  Decode4At(at: number): number {
    this.require(at, 4);
    return this.m_nCipherDegree
      ? BM.Decrypt4(this.m_pBlock, at)
      : BM.Decode4(this.m_pBlock, at);
  }
  Decode1(): number {
    const n = this.Decode1At(this.m_uOffset);
    this.m_uOffset++;
    return n;
  }
  Decode2(): number {
    const n = this.Decode2At(this.m_uOffset);
    this.m_uOffset += 2;
    return n;
  }
  Decode4(): number {
    const n = this.Decode4At(this.m_uOffset);
    this.m_uOffset += 4;
    return n;
  }
  DecodeBuffer(size: number): Buffer {
    this.require(this.m_uOffset, size);
    const buf = Buffer.from(
      this.m_pBlock.subarray(this.m_uOffset, this.m_uOffset + size),
    );
    this.m_uOffset += size;
    return buf;
  }
  DecodeStrBytes(maxBytes = 0x7fff): Buffer {
    const size = this.Decode2();
    if (size > maxBytes)
      throw new CProtocolError(`String exceeds ${maxBytes} bytes`);
    return this.DecodeBuffer(size);
  }
  DecodeStr(maxBytes = 0x7fff): string {
    return this.text.Decode(this.DecodeStrBytes(maxBytes));
  }
  DecodeEncryptedStr(key: number, maxBytes = 0x7fff): string {
    return this.text.Decode(
      SimpleStreamDecrypt3(this.DecodeStrBytes(maxBytes), key),
    );
  }
  DecodeISStream(): CISmartStream {
    if (this.m_nCipherDegree) {
      const size = this.Decode4();
      const stream = new CISmartStream(this.DecodeBuffer(size), this.text);
      if (stream.bytesRead !== size)
        throw new CProtocolError("SmartStream envelope size mismatch");
      return stream;
    }
    const stream = new CISmartStream(
      this.m_pBlock.subarray(this.m_uOffset),
      this.text,
    );
    this.m_uOffset += stream.bytesRead;
    return stream;
  }
  AssertEnd(): void {
    if (this.remaining !== 0)
      throw new CProtocolError(
        `Unexpected ${this.remaining} trailing bytes for packet ${this.m_nPacketType}`,
      );
  }
  Rewind(): void {
    this.m_uOffset = 0;
  }
}
