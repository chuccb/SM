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
import { EncodeCP950, DecodeCP950 } from "./Encoding.ts";

/**
 * CSendPacketBase::m_nCipherDegree — the wire framing of a packet
 * (CSendPacketBase::GetOutgoingPacketLength / CReceivedPacketBase::
 * GetIncomingPacketLength switch on it).
 */
export const CipherDegree = {
  /** [code][E2 BE len-3][body] — the accept packet, monitor and billing frames. */
  kPacketRaw: 0,
  /** [code][E2 BE (len-7) ^ 0xA569][SES3(seq)][E4 crc32] — the billing link. */
  kPacketEncrypted: 1,
  /** [code][E2 BE (len-4) ^ 0xA569][SES3(seq)][E1 crc8] — every client link. */
  kPacketEncryptedCRC8: 2,
} as const;
export type CipherDegree = (typeof CipherDegree)[keyof typeof CipherDegree];

/** The native setters accept only the three integral enum members (0..2). */
export function IsValidCipherDegree(value: number): value is CipherDegree {
  return Number.isInteger(value)
    && value >= CipherDegree.kPacketRaw
    && value <= CipherDegree.kPacketEncryptedCRC8;
}

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

/** A reusable send container is constructed with type 0, then InitPacket sets
 * its actual wire opcode before it can be sent. */
export const PACKET_TYPE_PLACEHOLDER = 0;

/** Standard packet frame widths: [E1 check code][E2 length][payload][CRC?]. */
export const PACKET_CHECK_CODE_BYTES = Uint8Array.BYTES_PER_ELEMENT;
export const PACKET_LENGTH_BYTES = Uint16Array.BYTES_PER_ELEMENT;
export const PACKET_HEADER_BYTES = PACKET_CHECK_CODE_BYTES + PACKET_LENGTH_BYTES;
export const PACKET_CRC32_BYTES = Uint32Array.BYTES_PER_ELEMENT;
export const PACKET_CRC8_BYTES = Uint8Array.BYTES_PER_ELEMENT;
export const PACKET_RAW_OVERHEAD = PACKET_HEADER_BYTES;
export const PACKET_ENCRYPTED_OVERHEAD = PACKET_HEADER_BYTES + PACKET_CRC32_BYTES;
export const PACKET_ENCRYPTED_CRC8_OVERHEAD = PACKET_HEADER_BYTES + PACKET_CRC8_BYTES;

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
  // Keep the mutable native field wide; TS next otherwise narrows the const member to literal 0.
  m_nCipherDegree: number = CipherDegree.kPacketRaw;

  constructor(nPacketType?: number, nCipherDegree: number = CipherDegree.kPacketRaw) {
    super();
    this.Alloc(0x40);
    this.m_nCipherDegree = IsValidCipherDegree(nCipherDegree) ? nCipherDegree : CipherDegree.kPacketRaw;
    if (nPacketType !== undefined) {
      this.m_nPacketType = nPacketType;
      this.Encode1(nPacketType);
    }
  }

  /** CSendPacketBase::InitPacket — reuse of a pooled packet. */
  InitPacket(nPacketType: number, nCipherDegree = this.m_nCipherDegree): this {
    if (IsValidCipherDegree(nCipherDegree)) this.m_nCipherDegree = nCipherDegree;
    this.m_nPacketType = nPacketType;
    this.m_uOffset = 0;
    this.Encode1(nPacketType);
    return this;
  }

  SetCipherDegree(nCipherDegree: number): void {
    if (IsValidCipherDegree(nCipherDegree)) this.m_nCipherDegree = nCipherDegree;
  }

  GetCipherDegree(): number {
    return this.m_nCipherDegree;
  }

  /** CSendPacketBase::GetOutgoingPacketLength */
  GetOutgoingPacketLength(): number {
    if (this.m_uOffset === 0) return 0;
    switch (this.m_nCipherDegree) {
      case CipherDegree.kPacketRaw:
        return this.m_uOffset + PACKET_RAW_OVERHEAD;
      case CipherDegree.kPacketEncrypted:
        return this.m_uOffset + PACKET_ENCRYPTED_OVERHEAD;
      case CipherDegree.kPacketEncryptedCRC8:
        return this.m_uOffset + PACKET_ENCRYPTED_CRC8_OVERHEAD;
      default:
        return 0;
    }
  }

  Encode1At(uOffset: number, n: number): number {
    this.Ensure(uOffset + 1);
    if (this.m_nCipherDegree >= CipherDegree.kPacketEncrypted && this.m_nCipherDegree <= CipherDegree.kPacketEncryptedCRC8) {
      this.m_pBlock[uOffset] = (n ^ B.ENCRYPT_MASK_1) & 0xff;
    } else {
      this.m_pBlock[uOffset] = n & 0xff;
    }
    return 1;
  }

  Encode2At(uOffset: number, n: number): number {
    this.Ensure(uOffset + 2);
    if (this.m_nCipherDegree >= CipherDegree.kPacketEncrypted && this.m_nCipherDegree <= CipherDegree.kPacketEncryptedCRC8) n ^= B.ENCRYPT_MASK_2;
    B.Encode2(this.m_pBlock, uOffset, n);
    return 2;
  }

  Encode4At(uOffset: number, n: number): number {
    this.Ensure(uOffset + 4);
    if (this.m_nCipherDegree >= CipherDegree.kPacketEncrypted && this.m_nCipherDegree <= CipherDegree.kPacketEncryptedCRC8) n = (n ^ B.ENCRYPT_MASK_4) >>> 0;
    B.Encode4(this.m_pBlock, uOffset, n >>> 0);
    return 4;
  }

  EncodeStrAt(uOffset: number, str: string): number {
    const raw = EncodeCP950(str);
    const len = raw.length;
    if (len >= 0x8000) {
      this.Encode2At(uOffset, 0);
      return 2;
    }
    this.Ensure(uOffset + len + 2);
    this.Encode2At(uOffset, len);
    const block = this.m_pBlock;
    for (let i = 0; i < len; i++) block[uOffset + 2 + i] = raw[i]!;
    return len + 2;
  }

  /** CSendPacketBase::EncodeEncryptedStrAt — string encrypted with SimpleStreamEncrypt3. */
  EncodeEncryptedStrAt(uOffset: number, str: string, key: number): number {
    const raw = EncodeCP950(str);
    const len = raw.length;
    if (len >= 0x8000) {
      this.Encode2At(uOffset, 0);
      return 2;
    }
    this.Ensure(uOffset + len + 2);
    this.Encode2At(uOffset, len);
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
    if (!(this.m_nCipherDegree >= CipherDegree.kPacketEncrypted && this.m_nCipherDegree <= CipherDegree.kPacketEncryptedCRC8)) {
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
    if (this.m_nCipherDegree === CipherDegree.kPacketRaw) {
      B.Encode2(pBuf, pBufOff + PACKET_CHECK_CODE_BYTES, len - PACKET_RAW_OVERHEAD);
      B.EncodeBuffer(pBuf, pBufOff + PACKET_HEADER_BYTES, this.m_pBlock, 0, len - PACKET_RAW_OVERHEAD);
      if (fMakeConvert) {
        const n = EncodeHeader(nHeaderType, this.m_nPacketType);
        pBuf[pBufOff + PACKET_HEADER_BYTES] = n & 0xff;
      }
      return 1;
    }
    if (this.m_nCipherDegree === CipherDegree.kPacketEncryptedCRC8) {
      const payloadLength = len - PACKET_ENCRYPTED_CRC8_OVERHEAD;
      B.Encode2(pBuf, pBufOff + PACKET_CHECK_CODE_BYTES, payloadLength ^ B.ENCRYPT_MASK_2);
      SimpleStreamEncrypt3(this.m_pBlock, 0, pBuf, pBufOff + PACKET_HEADER_BYTES, payloadLength, dwCrcKey);
      const updated = UpdateCRC8(dwCrcKey & 0xff, this.m_pBlock, 0, payloadLength);
      this.Ensure(this.m_uOffset + PACKET_CRC8_BYTES);
      B.Encode1(pBuf, pBufOff + len - PACKET_CRC8_BYTES, updated);
      return 1;
    }
    if (this.m_nCipherDegree === CipherDegree.kPacketEncrypted) {
      const payloadLength = len - PACKET_ENCRYPTED_OVERHEAD;
      B.Encode2(pBuf, pBufOff + PACKET_CHECK_CODE_BYTES, payloadLength ^ B.ENCRYPT_MASK_2);
      SimpleStreamEncrypt3(this.m_pBlock, 0, pBuf, pBufOff + PACKET_HEADER_BYTES, payloadLength, dwCrcKey);
      const n = UpdateCRC32(dwCrcKey >>> 0, this.m_pBlock, 0, payloadLength);
      this.Ensure(this.m_uOffset + PACKET_CRC32_BYTES);
      B.Encode4(pBuf, pBufOff + len - PACKET_CRC32_BYTES, n);
      return 1;
    }
    return 0;
  }
}

export class CReceivedPacket extends CMemBlock {
  m_nPacketType = 0;
  m_uLength = 0;
  m_uOffset = 0;
  m_nCipherDegree: number = CipherDegree.kPacketRaw; // wide for validated setter input

  SetCipherDegree(nCipherDegree: number): void {
    if (IsValidCipherDegree(nCipherDegree)) this.m_nCipherDegree = nCipherDegree;
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
      if (this.m_nCipherDegree >= CipherDegree.kPacketEncrypted && this.m_nCipherDegree <= CipherDegree.kPacketEncryptedCRC8) {
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
    /** compatibility probe (CA_CIPHER_LIBERAL=1): deliver the packet even when
     *  the checksum fails, reporting both sides — NEVER part of the original. */
    fLiberal = false,
  ): boolean {
    if (this.m_nCipherDegree === CipherDegree.kPacketRaw) {
      const len3 = len - PACKET_RAW_OVERHEAD;
      if (len3 > 0 && this.Alloc(len3) !== 0) {
        this.m_pBlock.set(pBuf.subarray(pBufOff + PACKET_HEADER_BYTES, pBufOff + PACKET_HEADER_BYTES + len3));
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
    if (this.m_nCipherDegree === CipherDegree.kPacketEncryptedCRC8) {
      const len4 = len - PACKET_ENCRYPTED_CRC8_OVERHEAD;
      if (len4 > 0 && this.Alloc(len4) !== 0) {
        const wireCrc = B.Decode1(pBuf, pBufOff + len - PACKET_CRC8_BYTES);
        SimpleStreamDecrypt3(pBuf, pBufOff + PACKET_HEADER_BYTES, this.m_pBlock, 0, len4, dwCrcKey);
        this.m_nPacketType = B.Decrypt1(this.m_pBlock, 0) & 0xff;
        this.m_uLength = len4;
        this.m_uOffset = 0;
        const crc = UpdateCRC8(dwCrcKey & 0xff, this.m_pBlock, 0, len4);
        if (crc !== wireCrc) {
          if (!fLiberal) return false;
          console.error(
            `[CIPHER-COMPAT] checksum mismatch — computed 0x${crc.toString(16)} vs wire 0x${wireCrc.toString(16)} (key=${dwCrcKey}); delivering anyway`,
          );
        }
        return true;
      }
      return false;
    }
    if (this.m_nCipherDegree === CipherDegree.kPacketEncrypted) {
      const len7 = len - PACKET_ENCRYPTED_OVERHEAD;
      if (len7 <= 0 || this.Alloc(len7) === 0) return false;
      const wireCrc = B.Decode4(pBuf, pBufOff + len - PACKET_CRC32_BYTES);
      SimpleStreamDecrypt3(pBuf, pBufOff + PACKET_HEADER_BYTES, this.m_pBlock, 0, len7, dwCrcKey);
      this.m_nPacketType = B.Decrypt1(this.m_pBlock, 0) & 0xff;
      this.m_uLength = len7;
      this.m_uOffset = 0;
      return UpdateCRC32(dwCrcKey >>> 0, this.m_pBlock, 0, len7) === wireCrc;
    }
    return false;
  }

  /** CReceivedPacketBase::GetIncomingPacketLength — total on-wire size, -1 = need more bytes. */
  static GetIncomingPacketLength(pBuf: Uint8Array, off: number, len: number, nCipherDegree: number): number {
    if (nCipherDegree === CipherDegree.kPacketRaw) {
      if (len >= PACKET_RAW_OVERHEAD)
        return B.Decode2(pBuf, off + PACKET_CHECK_CODE_BYTES) + PACKET_RAW_OVERHEAD;
    } else if (nCipherDegree === CipherDegree.kPacketEncrypted) {
      if (len >= PACKET_ENCRYPTED_OVERHEAD)
        return B.Decrypt2(pBuf, off + PACKET_CHECK_CODE_BYTES) + PACKET_ENCRYPTED_OVERHEAD;
    } else if (nCipherDegree === CipherDegree.kPacketEncryptedCRC8) {
      if (len >= PACKET_ENCRYPTED_CRC8_OVERHEAD)
        return B.Decrypt2(pBuf, off + PACKET_CHECK_CODE_BYTES) + PACKET_ENCRYPTED_CRC8_OVERHEAD;
    } else {
      return 0;
    }
    return -1;
  }

  Decode1At(uOffset: number): number {
    if (uOffset + 1 > this.m_uLength) return 0;
    if (this.IsEncryptedDegree()) return B.Decrypt1(this.m_pBlock, uOffset);
    return B.Decode1(this.m_pBlock, uOffset);
  }

  Decode2At(uOffset: number): number {
    if (uOffset + 2 > this.m_uLength) return 0;
    if (this.IsEncryptedDegree()) return B.Decrypt2(this.m_pBlock, uOffset);
    return B.Decode2(this.m_pBlock, uOffset);
  }

  Decode4At(uOffset: number): number {
    if (uOffset + 4 > this.m_uLength) return 0;
    if (this.IsEncryptedDegree()) return B.Decrypt4(this.m_pBlock, uOffset);
    return B.Decode4(this.m_pBlock, uOffset);
  }

  private IsEncryptedDegree(): boolean {
    return this.m_nCipherDegree >= CipherDegree.kPacketEncrypted
      && this.m_nCipherDegree <= CipherDegree.kPacketEncryptedCRC8;
  }

  DecodeBufferAt(uOffset: number, pBuf: Uint8Array, len: number): number {
    if (uOffset + len > this.m_uLength) return 0;
    pBuf.set(this.m_pBlock.subarray(uOffset, uOffset + len));
    return len;
  }

  DecodeISStreamAt(uOffset: number, isstream: CISmartStream): number {
    if (!(this.m_nCipherDegree >= CipherDegree.kPacketEncrypted && this.m_nCipherDegree <= CipherDegree.kPacketEncryptedCRC8)) {
      const uOffset1 = uOffset;
      const used = isstream.SetBuffer(this.m_pBlock.subarray(uOffset));
      return this.m_uLength >= uOffset1 + used ? used : 0;
    }
    const uOffset2 = uOffset + 4;
    if (uOffset + 4 > this.m_uLength) return 0;
    const count = this.Decode4At(uOffset);
    const pBuf = new Uint8Array(count);
    if (this.DecodeBufferAt(uOffset2, pBuf, count) !== count) return 0;
    const used = isstream.SetBuffer(pBuf);
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

  /** CReceivedPacketBase::DecodeStr — u16 length prefix + raw bytes, transcoded from CP950 to UTF-8. */
  DecodeStr(): string {
    const len = this.Decode2();
    if (len === 0) return "";
    const start = this.m_uOffset;
    const end = Math.min(this.m_uLength, start + len);
    this.m_uOffset = end;
    const bytes = this.m_pBlock.subarray(start, end);
    return DecodeCP950(bytes);
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
    const str = DecodeCP950(raw);
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
