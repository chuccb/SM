import { CBufferManipulator as BM } from "./CBufferManipulator.ts";
import { CipherDegree } from "./OfficialValues.ts";
import { CProtocolError } from "./CProtocolError.ts";
import { DefaultTextCodec, type CTextCodec } from "./CTextCodec.ts";
import { SimpleStreamEncrypt3 } from "./SimpleStream.ts";
import type { COSmartStream } from "./COSmartStream.ts";

/** LS 00429CD0..0042AC40. m_pBlock is scalar-obfuscated, before stream encryption. */
export class CSendPacketBase {
  m_nPacketType = 0;
  m_uOffset = 0;
  m_pBlock: Buffer = Buffer.alloc(64);
  m_nCipherDegree: CipherDegree;
  constructor(
    nPacketType?: number,
    nCipherDegree: CipherDegree = CipherDegree.None,
    readonly text: CTextCodec = DefaultTextCodec,
  ) {
    this.m_nCipherDegree = nCipherDegree;
    if (nPacketType !== undefined) this.InitPacket(nPacketType, nCipherDegree);
  }
  InitPacket(nPacketType: number, nCipherDegree = this.m_nCipherDegree): this {
    this.m_nPacketType = nPacketType;
    this.m_nCipherDegree = nCipherDegree;
    this.m_uOffset = 0;
    return this.Encode1(nPacketType);
  }
  private reserve(end: number): void {
    if (!Number.isSafeInteger(end) || end < 0 || end > 0xffff)
      throw new CProtocolError("Outgoing packet too long");
    if (end > this.m_pBlock.length) {
      const next = Buffer.alloc(Math.ceil((end + 1) / 64) * 64);
      this.m_pBlock.copy(next);
      this.m_pBlock = next;
    }
  }
  GetBuffer(): Buffer {
    return Buffer.from(this.m_pBlock.subarray(0, this.m_uOffset));
  }
  GetCipherDegree(): CipherDegree {
    return this.m_nCipherDegree;
  }
  SetCipherDegree(n: CipherDegree): void {
    if (this.m_uOffset !== 0 && n !== this.m_nCipherDegree)
      throw new CProtocolError("Changing cipher on an already encoded packet");
    this.m_nCipherDegree = n;
  }
  Encode1(n: number): this {
    this.Encode1At(this.m_uOffset, n);
    this.m_uOffset++;
    return this;
  }
  Encode2(n: number): this {
    this.Encode2At(this.m_uOffset, n);
    this.m_uOffset += 2;
    return this;
  }
  Encode4(n: number): this {
    this.Encode4At(this.m_uOffset, n);
    this.m_uOffset += 4;
    return this;
  }
  Encode1At(at: number, n: number): number {
    this.reserve(at + 1);
    if (this.m_nCipherDegree) BM.Encrypt1(this.m_pBlock, n, at);
    else BM.Encode1(this.m_pBlock, n, at);
    return 1;
  }
  Encode2At(at: number, n: number): number {
    this.reserve(at + 2);
    if (this.m_nCipherDegree) BM.Encrypt2(this.m_pBlock, n, at);
    else BM.Encode2(this.m_pBlock, n, at);
    return 2;
  }
  Encode4At(at: number, n: number): number {
    this.reserve(at + 4);
    if (this.m_nCipherDegree) BM.Encrypt4(this.m_pBlock, n, at);
    else BM.Encode4(this.m_pBlock, n, at);
    return 4;
  }
  EncodeBuffer(buf: Uint8Array): this {
    this.reserve(this.m_uOffset + buf.length);
    this.m_pBlock.set(buf, this.m_uOffset);
    this.m_uOffset += buf.length;
    return this;
  }
  EncodeStr(str: string | Uint8Array): this {
    const buf =
      typeof str === "string" ? this.text.Encode(str) : Buffer.from(str);
    // Original replaces >=0x8000 strings with empty. Reject instead of corrupting semantics.
    if (buf.length >= 0x8000)
      throw new CProtocolError("String exceeds original 0x7fff-byte limit");
    return this.Encode2(buf.length).EncodeBuffer(buf);
  }
  EncodeEncryptedStr(str: string | Uint8Array, key: number): this {
    const buf =
      typeof str === "string" ? this.text.Encode(str) : Buffer.from(str);
    if (buf.length >= 0x8000)
      throw new CProtocolError("Encrypted string too long");
    return this.Encode2(buf.length).EncodeBuffer(
      SimpleStreamEncrypt3(buf, key),
    );
  }
  EncodeOSStream(stream: COSmartStream): this {
    const buf = stream.GetBuffer();
    if (this.m_nCipherDegree) this.Encode4(buf.length);
    return this.EncodeBuffer(buf);
  }
  GetOutgoingPacketLength(): number {
    if (!this.m_uOffset) return 0;
    return (
      this.m_uOffset +
      (this.m_nCipherDegree === CipherDegree.None
        ? 3
        : this.m_nCipherDegree === CipherDegree.CRC32
          ? 7
          : 4)
    );
  }
}
