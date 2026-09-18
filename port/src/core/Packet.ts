/**
 * CSendPacket / CReceivedPacket — the packet containers.
 *
 * Wire layout produced by CSendPacketBase::EncodePacket and consumed by
 * CReceivedPacketBase::DecodePacket (identical in every server binary):
 *
 *   [0] header code        (CPacketSocket::MarkCheckCode)
 *   [1..2] total length    big-endian, XOR-masked when cipher degree >= 1
 *   [3..]  payload         first payload byte is the packet type
 *          - cipher 0            : payload copied verbatim (payload = type + body)
 *          - cipher 1            : SimpleStreamEncrypt3(key) + CRC32(key)  [4]
 *          - cipher 2            : SimpleStreamEncrypt3(key) + CRC8(key)   [1]
 *
 * All values are big-endian; strings are length-prefixed (u16 big-endian +
 * raw ANSI bytes). Packet objects keep their bytes in the *encoded* domain,
 * exactly like CMemBlock in the original.
 */
import * as B from "./BufferManipulator.ts";
import { SimpleStreamDecrypt3, SimpleStreamEncrypt3 } from "./StreamCipher.ts";
import { UpdateCRC32, UpdateCRC8 } from "./CRC.ts";
import { DecodeHeader, EncodeHeader } from "./PacketHeaderConverter.ts";
import type { COSmartStream, CISmartStream } from "./SmartStream.ts";

/** enSocket */
export const enSocket = {
  kioOk: 0x0,
  kioNotConnected: 0x1,
  kioNotReady: 0x2,
  kioInvalidPacket: 0x3,
  kioCipherDegreeDoesntMatch: 0x4,
  kioTooLongPacket: 0x5,
  kioSequencingError: 0x6,
  kioDecodingError: 0x7,
  kioEncodingError: 0x8,
  kioPacketReadError: 0x9,
  kioConnectionClosed: 0xa,
  kioNoDatagramReached: 0xb,
  kioSomeDatagramReached: 0xc,
  kioReceiveBufferOverflow: 0xd,
  kioSendBufferOverflow: 0xe,
  kioIgnored: 0xf,
  kioIoInProgress: 0x10,
  kioBufferEmpty: 0x11,
  kioIoPending: 0x12,
  kioNoResource: 0x13,
  kioUnknownError: 0x14,
  kioUninitialized: 0x15,
  kioIOCPPostFail: 0x16,
} as const;
export type enSocket = (typeof enSocket)[keyof typeof enSocket];

/** kPacketRaw / kPacketEncrypted / kPacketEncryptedCRC8 (cipher degree) */
export const kPacketRaw = 0;
export const kPacketEncrypted = 1;
export const kPacketEncryptedCRC8 = 2;
export const kPacketOffset = 3;

/** CMemBlock::GetAmpleBufSize — 64-byte granularity. */
function GetAmpleBufSize(nSize: number): number {
  return nSize > 0x40 ? (nSize & ~0x3f) + 0x40 : 0x40;
}

export class CMemBlock {
  m_pBlock: Uint8Array = new Uint8Array(0);
  m_uSize = 0;

  Alloc(nSize: number): number {
    this.m_pBlock = new Uint8Array(nSize);
    this.m_uSize = nSize;
    return 1;
  }

  ReAlloc(nSize: number): number {
    const nb = new Uint8Array(nSize);
    nb.set(this.m_pBlock.subarray(0, Math.min(this.m_uSize, nSize)));
    this.m_pBlock = nb;
    this.m_uSize = nSize;
    return 1;
  }

  Ensure(uNeed: number): void {
    if (uNeed > this.m_uSize) this.ReAlloc(GetAmpleBufSize(uNeed));
  }
}

export class CSendPacket extends CMemBlock {
  m_nPacketType = 0;
  m_uOffset = 0;
  m_nCipherDegree = 0;

  constructor(nPacketType = 0, nCipherDegree = 0) {
    super();
    this.Alloc(0x40);
    this.m_nCipherDegree = nCipherDegree <= 2 ? nCipherDegree : 0;
    this.m_uOffset = 0;
    this.m_nPacketType = nPacketType;
    this.Encode1(nPacketType);
  }

  /** CSendPacketBase::InitPacket — reuse of a pooled packet. */
  InitPacket(nPacketType: number, nCipherDegree = this.m_nCipherDegree): this {
    if (nCipherDegree <= 2) this.m_nCipherDegree = nCipherDegree;
    this.m_nPacketType = nPacketType;
    this.m_uOffset = 0;
    this.Encode1(nPacketType);
    return this;
  }

  SetCipherDegree(nCipherDegree: number): void {
    if (nCipherDegree <= 2) this.m_nCipherDegree = nCipherDegree;
  }

  GetCipherDegree(): number {
    return this.m_nCipherDegree;
  }

  /** CSendPacketBase::GetOutgoingPacketLength */
  GetOutgoingPacketLength(): number {
    if (this.m_uOffset === 0) return 0;
    switch (this.m_nCipherDegree) {
      case 0:
        return this.m_uOffset + 3;
      case 1:
        return this.m_uOffset + 7;
      case 2:
        return this.m_uOffset + 4;
      default:
        return 0;
    }
  }

  Encode1At(uOffset: number, n: number): number {
    this.Ensure(uOffset + 1);
    if (this.m_nCipherDegree >= 1 && this.m_nCipherDegree <= 2) {
      this.m_pBlock[uOffset] = (n ^ B.ENCRYPT_MASK_1) & 0xff;
    } else {
      this.m_pBlock[uOffset] = n & 0xff;
    }
    return 1;
  }

  Encode2At(uOffset: number, n: number): number {
    this.Ensure(uOffset + 2);
    if (this.m_nCipherDegree >= 1 && this.m_nCipherDegree <= 2) n ^= B.ENCRYPT_MASK_2;
    B.Encode2(this.m_pBlock, uOffset, n);
    return 2;
  }

  Encode4At(uOffset: number, n: number): number {
    this.Ensure(uOffset + 4);
    if (this.m_nCipherDegree >= 1 && this.m_nCipherDegree <= 2) n = (n ^ B.ENCRYPT_MASK_4) >>> 0;
    B.Encode4(this.m_pBlock, uOffset, n >>> 0);
    return 4;
  }

  EncodeStrAt(uOffset: number, str: string): number {
    let len = str.length;
    if (len >= 0x8000) {
      this.Encode2At(uOffset, 0);
      return 2;
    }
    this.Ensure(uOffset + len + 2);
    this.Encode2At(uOffset, len);
    const block = this.m_pBlock;
    for (let i = 0; i < len; i++) block[uOffset + 2 + i] = str.charCodeAt(i) & 0xff;
    return len + 2;
  }

  /** CSendPacketBase::EncodeEncryptedStrAt — string encrypted with SimpleStreamEncrypt3. */
  EncodeEncryptedStrAt(uOffset: number, str: string, key: number): number {
    const len = str.length;
    if (len >= 0x8000) {
      this.Encode2At(uOffset, 0);
      return 2;
    }
    this.Ensure(uOffset + len + 2);
    this.Encode2At(uOffset, len);
    const raw = new Uint8Array(len);
    for (let i = 0; i < len; i++) raw[i] = str.charCodeAt(i) & 0xff;
    SimpleStreamEncrypt3(raw, 0, this.m_pBlock, uOffset + 2, len, key);
    return len + 2;
  }

  EncodeBufferAt(uOffset: number, pBuf: Uint8Array, len = pBuf.length): number {
    this.Ensure(uOffset + len);
    B.EncodeBuffer(this.m_pBlock, uOffset, pBuf, 0, len);
    return len;
  }

  EncodeOSStreamAt(uOffset: number, osstream: COSmartStream): number {
    const nBufferSize = osstream.GetBufferSize();
    if (!(this.m_nCipherDegree >= 1 && this.m_nCipherDegree <= 2)) {
      return this.EncodeBufferAt(uOffset, osstream.GetBuffer(), nBufferSize);
    }
    this.Ensure(uOffset + 4);
    this.Encode4At(uOffset, nBufferSize);
    this.EncodeBufferAt(uOffset + 4, osstream.GetBuffer(), nBufferSize);
    return nBufferSize + 4;
  }

  Encode1(n: number): void {
    this.m_uOffset += this.Encode1At(this.m_uOffset, n);
  }
  Encode2(n: number): void {
    this.m_uOffset += this.Encode2At(this.m_uOffset, n);
  }
  Encode4(n: number): void {
    this.m_uOffset += this.Encode4At(this.m_uOffset, n >>> 0);
  }
  EncodeStr(str: string): void {
    this.m_uOffset += this.EncodeStrAt(this.m_uOffset, str);
  }
  EncodeEncryptedStr(str: string, key: number): void {
    this.m_uOffset += this.EncodeEncryptedStrAt(this.m_uOffset, str, key);
  }
  EncodeBuffer(pBuf: Uint8Array, len = pBuf.length): void {
    this.m_uOffset += this.EncodeBufferAt(this.m_uOffset, pBuf, len);
  }
  EncodeOSStream(osstream: COSmartStream): void {
    this.m_uOffset += this.EncodeOSStreamAt(this.m_uOffset, osstream);
  }

  /** CSendPacketBase::EncodePacket — write this packet into a socket send buffer. */
  EncodePacket(
    pBuf: Uint8Array,
    pBufOff: number,
    len: number,
    fMakeConvert: boolean,
    nHeaderType: number,
    dwCrcKey: number,
  ): number {
    if (this.m_nCipherDegree === 0) {
      B.Encode2(pBuf, pBufOff + 1, len - 3);
      B.EncodeBuffer(pBuf, pBufOff + 3, this.m_pBlock, 0, len - 3);
      if (fMakeConvert) {
        const n = EncodeHeader(nHeaderType, this.m_nPacketType);
        pBuf[pBufOff + 3] = n & 0xff;
      }
      return 1;
    }
    if (this.m_nCipherDegree === 2) {
      B.Encode2(pBuf, pBufOff + 1, (len - 4) ^ B.ENCRYPT_MASK_2);
      SimpleStreamEncrypt3(this.m_pBlock, 0, pBuf, pBufOff + 3, len - 4, dwCrcKey);
      const updated = UpdateCRC8(dwCrcKey & 0xff, this.m_pBlock, 0, len - 4);
      this.Ensure(this.m_uOffset + 1);
      B.Encode1(pBuf, pBufOff + len - 1, updated);
      return 1;
    }
    if (this.m_nCipherDegree === 1) {
      B.Encode2(pBuf, pBufOff + 1, (len - 7) ^ B.ENCRYPT_MASK_2);
      SimpleStreamEncrypt3(this.m_pBlock, 0, pBuf, pBufOff + 3, len - 7, dwCrcKey);
      const n = UpdateCRC32(dwCrcKey >>> 0, this.m_pBlock, 0, len - 7);
      this.Ensure(this.m_uOffset + 4);
      B.Encode4(pBuf, pBufOff + len - 4, n);
      return 1;
    }
    return 0;
  }
}

export class CReceivedPacket extends CMemBlock {
  m_nPacketType = 0;
  m_uLength = 0;
  m_uOffset = 0;
  m_nCipherDegree = 0;

  SetCipherDegree(nCipherDegree: number): void {
    if (nCipherDegree <= 2) this.m_nCipherDegree = nCipherDegree;
  }

  GetCipherDegree(): number {
    return this.m_nCipherDegree;
  }

  /** CReceivedPacketBase::SetRcvPacket — adopt an already-framed payload. */
  SetRcvPacket(pBuf: Uint8Array, len: number): number {
    this.Alloc(len);
    this.m_pBlock.set(pBuf.subarray(0, len));
    this.m_uOffset = 0;
    this.m_uLength = len;
    if (len !== 0) {
      if (this.m_nCipherDegree >= 1 && this.m_nCipherDegree <= 2) {
        this.m_nPacketType = B.Decrypt1(this.m_pBlock, 0);
      } else {
        this.m_nPacketType = B.Decode1(this.m_pBlock, 0);
      }
      return 1;
    }
    this.m_nPacketType = 0;
    return 1;
  }

  /** CReceivedPacketBase::SetJUMPacket — raw JUM-server payload. */
  SetJUMPacket(pBuf: Uint8Array, len: number): number {
    this.Alloc(len);
    this.m_pBlock.set(pBuf.subarray(0, len));
    this.m_uLength = len;
    this.m_uOffset = 0;
    return 1;
  }

  /** CReceivedPacketBase::DecodePacket */
  DecodePacket(
    pBuf: Uint8Array,
    pBufOff: number,
    len: number,
    fMakeConvert: boolean,
    nHeaderType: number,
    dwCrcKey: number,
  ): boolean {
    if (this.m_nCipherDegree === 0) {
      const len3 = len - 3;
      if (len3 > 0 && this.Alloc(len3) !== 0) {
        this.m_pBlock.set(pBuf.subarray(pBufOff + 3, pBufOff + 3 + len3));
        const nPacketType = B.Decode1(this.m_pBlock, 0);
        if (fMakeConvert) {
          const m = DecodeHeader(nHeaderType, nPacketType);
          this.m_nPacketType = m;
          this.m_pBlock[0] = m & 0xff;
          this.m_uLength = len3;
        } else {
          this.m_uLength = len3;
          this.m_nPacketType = nPacketType;
        }
        this.m_uOffset = 0;
        return true;
      }
      return false;
    }
    if (this.m_nCipherDegree === 2) {
      const len4 = len - 4;
      if (len4 > 0 && this.Alloc(len4) !== 0) {
        const v10 = B.Decode1(pBuf, pBufOff + len - 1);
        SimpleStreamDecrypt3(pBuf, pBufOff + 3, this.m_pBlock, 0, len4, dwCrcKey);
        this.m_nPacketType = B.Decrypt1(this.m_pBlock, 0) & 0xff;
        this.m_uLength = len4;
        this.m_uOffset = 0;
        return UpdateCRC8(dwCrcKey & 0xff, this.m_pBlock, 0, len4) === v10;
      }
      return false;
    }
    if (this.m_nCipherDegree === 1) {
      const len7 = len - 7;
      if (len7 <= 0 || this.Alloc(len7) === 0) return false;
      const v13 = B.Decode4(pBuf, pBufOff + len - 4);
      SimpleStreamDecrypt3(pBuf, pBufOff + 3, this.m_pBlock, 0, len7, dwCrcKey);
      this.m_nPacketType = B.Decrypt1(this.m_pBlock, 0) & 0xff;
      this.m_uLength = len7;
      this.m_uOffset = 0;
      return UpdateCRC32(dwCrcKey >>> 0, this.m_pBlock, 0, len7) === v13;
    }
    return false;
  }

  /** CReceivedPacketBase::GetIncomingPacketLength — total on-wire size, -1 = need more bytes. */
  static GetIncomingPacketLength(pBuf: Uint8Array, off: number, len: number, nCipherDegree: number): number {
    if (nCipherDegree === 0) {
      if (len >= 3) return B.Decode2(pBuf, off + 1) + 3;
    } else if (nCipherDegree === 1) {
      if (len >= 7) return B.Decrypt2(pBuf, off + 1) + 7;
    } else if (nCipherDegree === 2) {
      if (len >= 4) return B.Decrypt2(pBuf, off + 1) + 4;
    } else {
      return 0;
    }
    return -1;
  }

  Decode1At(uOffset: number): number {
    if (uOffset + 1 > this.m_uLength) return 0;
    if (this.m_nCipherDegree >= 1 && this.m_nCipherDegree <= 2) return B.Decrypt1(this.m_pBlock, uOffset);
    return B.Decode1(this.m_pBlock, uOffset);
  }

  Decode2At(uOffset: number): number {
    if (uOffset + 2 > this.m_uLength) return 0;
    if (this.m_nCipherDegree >= 1 && this.nCipherEnc()) return B.Decrypt2(this.m_pBlock, uOffset);
    return B.Decode2(this.m_pBlock, uOffset);
  }

  Decode4At(uOffset: number): number {
    if (uOffset + 4 > this.m_uLength) return 0;
    if (this.m_nCipherDegree >= 1 && this.m_nCipherDegree <= 2) return B.Decrypt4(this.m_pBlock, uOffset);
    return B.Decode4(this.m_pBlock, uOffset);
  }

  private nCipherEnc(): boolean {
    return this.m_nCipherDegree <= 2;
  }

  DecodeBufferAt(uOffset: number, pBuf: Uint8Array, len: number): number {
    if (uOffset + len > this.m_uLength) return 0;
    pBuf.set(this.m_pBlock.subarray(uOffset, uOffset + len));
    return len;
  }

  DecodeISStreamAt(uOffset: number, isstream: CISmartStream): number {
    if (!(this.m_nCipherDegree >= 1 && this.m_nCipherDegree <= 2)) {
      const uOffset1 = uOffset;
      const used = isstream.SetBuffer(this.m_pBlock.subarray(uOffset));
      return this.m_uLength >= uOffset1 + used ? used : 0;
    }
    const uOffset2 = uOffset + 4;
    if (uOffset + 4 > this.m_uLength) return 0;
    const count = this.Decode4At(uOffset);
    const pBuf = new Uint8Array(count);
    if (this.DecodeBufferAt(uOffset2, pBuf, count) !== count) return 0;
    const used = isstream.SetBuffer(pBuf, 0);
    if (used !== count) return 0;
    return count + 4;
  }

  Decode1(): number {
    const m_uOffset = this.m_uOffset;
    if (m_uOffset + 1 > this.m_uLength) return 0;
    const result = this.Decode1At(m_uOffset);
    this.m_uOffset++;
    return result;
  }

  Decode2(): number {
    const m_uOffset = this.m_uOffset;
    if (m_uOffset + 2 > this.m_uLength) return 0;
    const result = this.Decode2At(m_uOffset);
    this.m_uOffset += 2;
    return result;
  }

  Decode4(): number {
    const m_uOffset = this.m_uOffset;
    if (m_uOffset + 4 > this.m_uLength) return 0;
    const result = this.Decode4At(m_uOffset);
    this.m_uOffset += 4;
    return result;
  }

  /** CReceivedPacketBase::DecodeStr — u16 length prefix + raw bytes, byte-exact via latin1. */
  DecodeStr(): string {
    const len = this.Decode2();
    let str = "";
    for (let i = 0; i < len; i++) {
      if (this.m_uOffset >= this.m_uLength) break;
      str += String.fromCharCode(this.m_pBlock[this.m_uOffset++]!);
    }
    return str;
  }

  /**
   * CReceivedPacketBase::DecodeEncryptedStrAt (CxLogin.exe.c:40455) —
   * [u16 len][SimpleStreamDecrypt3(bytes, key)]; returns the consumed size.
   */
  DecodeEncryptedStrAt(uOffset: number, key: number): { str: string; size: number } {
    if (uOffset + 2 > this.m_uLength) return { str: "", size: 0 };
    const len = this.Decode2At(uOffset);
    if (len + uOffset + 2 > this.m_uLength) return { str: "", size: 0 };
    const raw = new Uint8Array(len);
    SimpleStreamDecrypt3(this.m_pBlock, uOffset + 2, raw, 0, len, key);
    let str = "";
    for (let i = 0; i < len; i++) str += String.fromCharCode(raw[i]!);
    return { str, size: len + 2 };
  }

  /** CReceivedPacketBase::DecodeEncryptedStr */
  DecodeEncryptedStr(key: number): string {
    const { str, size } = this.DecodeEncryptedStrAt(this.m_uOffset, key);
    this.m_uOffset += size;
    return str;
  }

  /** Raw remaining bytes (DecodeBuffer with the rest of the packet). */
  DecodeRest(): Uint8Array {
    const rest = this.m_pBlock.slice(this.m_uOffset, this.m_uLength);
    this.m_uOffset = this.m_uLength;
    return rest;
  }

  IsEOS(): boolean {
    return this.m_uOffset >= this.m_uLength;
  }

  ResetOffset(): void {
    this.m_uOffset = 0;
  }
}
