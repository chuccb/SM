import { CBufferManipulator as BM } from "./CBufferManipulator.ts";
import { CCRC8, CCRC32 } from "./CCRC.ts";
import { CipherDegree, ClientSocketCode } from "./OfficialValues.ts";
import { RuntimePolicy } from "./RuntimePolicy.ts";
import { CPacketHeaderConverter } from "./CPacketHeaderConverter.ts";
import { CProtocolError } from "./CProtocolError.ts";
import { CReceivedPacketBase } from "./CReceivedPacketBase.ts";
import type { CSendPacketBase } from "./CSendPacketBase.ts";
import { DefaultTextCodec, type CTextCodec } from "./CTextCodec.ts";
import { SimpleStreamDecrypt3, SimpleStreamEncrypt3 } from "./SimpleStream.ts";

export interface PacketSocketOptions {
  receiveBase?: number;
  sendBase?: number;
  modifier?: number;
  receiveSequence?: number;
  sendSequence?: number;
  receiveDelta?: number;
  sendDelta?: number;
  headerType?: number;
  cipherDegree?: CipherDegree;
  maxPacketLength?: number;
}
/** Streaming TCP framing/sequencing, LS 0042B220..0042B5D0.
 * One instance per connection/direction, never shared across sockets. */
export class CPacketSocket {
  m_nHeaderType: number | undefined;
  m_nPacketRcvSeq: number;
  m_nPacketSndSeq: number;
  m_nCipherDegree: CipherDegree;
  readonly m_nHeaderCodeRcvBase: number;
  readonly m_nHeaderCodeSndBase: number;
  readonly m_nHeaderCodeModifier: number;
  readonly m_nPacketRcvSeqDelta: number;
  readonly m_nPacketSndSeqDelta: number;
  readonly m_nMaxPacketLen: number;
  private pending: Buffer = Buffer.alloc(0);

  constructor(
    options: PacketSocketOptions = {},
    readonly text: CTextCodec = DefaultTextCodec,
  ) {
    this.m_nHeaderType = options.headerType;
    this.m_nPacketRcvSeq =
      options.receiveSequence ?? ClientSocketCode.InitialSequence;
    this.m_nPacketSndSeq =
      options.sendSequence ?? ClientSocketCode.InitialSequence;
    this.m_nCipherDegree = options.cipherDegree ?? CipherDegree.CRC8;
    this.m_nHeaderCodeRcvBase =
      options.receiveBase ?? ClientSocketCode.ReceiveBase;
    this.m_nHeaderCodeSndBase = options.sendBase ?? ClientSocketCode.SendBase;
    this.m_nHeaderCodeModifier = options.modifier ?? ClientSocketCode.Modifier;
    this.m_nPacketRcvSeqDelta =
      options.receiveDelta ?? ClientSocketCode.SequenceDelta;
    this.m_nPacketSndSeqDelta =
      options.sendDelta ?? ClientSocketCode.SequenceDelta;
    this.m_nMaxPacketLen =
      options.maxPacketLength ?? ClientSocketCode.MaxPacketLength;
    if (
      this.m_nHeaderType !== undefined &&
      (this.m_nHeaderType < 0 ||
        this.m_nHeaderType >= ClientSocketCode.HeaderTypeCount)
    )
      throw new CProtocolError("Invalid header type");
  }
  get bufferedBytes(): number {
    return this.pending.length;
  }
  private header(base: number, seq: number, delta: number): number {
    if (delta === 0) return base & 0xff;
    if (this.m_nHeaderType === undefined)
      throw new CProtocolError("Header type not established");
    return (
      ((this.m_nHeaderType + this.m_nHeaderCodeModifier) ^ (base + seq)) & 0xff
    );
  }
  GetRcvHeaderCode(): number {
    return this.header(
      this.m_nHeaderCodeRcvBase,
      this.m_nPacketRcvSeq,
      this.m_nPacketRcvSeqDelta,
    );
  }
  GetSndHeaderCode(): number {
    return this.header(
      this.m_nHeaderCodeSndBase,
      this.m_nPacketSndSeq,
      this.m_nPacketSndSeqDelta,
    );
  }
  PutPacket(packet: CSendPacketBase): Buffer {
    const cipher = packet.GetCipherDegree();
    const body = packet.GetBuffer();
    if (!body.length) throw new CProtocolError("Cannot send empty packet");
    const frame = Buffer.alloc(packet.GetOutgoingPacketLength());
    frame[0] = this.GetSndHeaderCode();
    if (cipher === CipherDegree.None) {
      BM.Encode2(frame, body.length, 1);
      body.copy(frame, 3);
      if (this.m_nPacketSndSeq !== 0)
        frame[3] = CPacketHeaderConverter.EncodeHeader(
          this.m_nHeaderType ?? 0,
          packet.m_nPacketType,
        );
    } else {
      BM.Encrypt2(frame, body.length, 1);
      SimpleStreamEncrypt3(body, this.m_nPacketSndSeq).copy(frame, 3);
      if (cipher === CipherDegree.CRC8)
        frame[frame.length - 1] = CCRC8.UpdateCRC(this.m_nPacketSndSeq, body);
      else
        BM.Encode4(
          frame,
          CCRC32.UpdateCRC(this.m_nPacketSndSeq, body),
          frame.length - 4,
        );
    }
    this.m_nPacketSndSeq =
      (this.m_nPacketSndSeq + this.m_nPacketSndSeqDelta) >>> 0;
    return frame;
  }
  /** Returns each complete packet in order, retaining a bounded partial frame. */
  GetPackets(chunk: Uint8Array): CReceivedPacketBase[] {
    if (
      chunk.length + this.pending.length >
      RuntimePolicy.MaxBufferedReceiveBytes
    )
      throw new CProtocolError("Receive buffer limit");
    this.pending = Buffer.concat([this.pending, chunk]);
    const packets: CReceivedPacketBase[] = [];
    while (this.pending.length >= 3) {
      const cipher = this.m_nCipherDegree;
      const bodyLength =
        cipher === CipherDegree.None
          ? BM.Decode2(this.pending, 1)
          : BM.Decrypt2(this.pending, 1);
      const overhead =
        cipher === CipherDegree.None
          ? 3
          : cipher === CipherDegree.CRC32
            ? 7
            : 4;
      const length = bodyLength + overhead;
      if (bodyLength === 0 || length > this.m_nMaxPacketLen)
        throw new CProtocolError("Invalid frame length");
      if (length > this.pending.length) break;
      // Do not change sequence or negotiated type until a full, valid frame is available.
      const code = this.pending[0]!;
      const type =
        this.m_nHeaderType ??
        ((code ^ ((this.m_nHeaderCodeRcvBase + this.m_nPacketRcvSeq) & 0xff)) -
          this.m_nHeaderCodeModifier) &
          0xff;
      if (
        this.m_nPacketRcvSeqDelta !== 0 &&
        type >= ClientSocketCode.HeaderTypeCount
      )
        throw new CProtocolError("Invalid negotiated header type");
      const expected =
        this.m_nPacketRcvSeqDelta === 0
          ? this.m_nHeaderCodeRcvBase & 0xff
          : ((type + this.m_nHeaderCodeModifier) ^
              (this.m_nHeaderCodeRcvBase + this.m_nPacketRcvSeq)) &
            0xff;
      if (code !== expected)
        throw new CProtocolError("Packet sequencing error", "sequencing-error");
      const encoded = this.pending.subarray(3, 3 + bodyLength);
      let body: Buffer;
      if (cipher === CipherDegree.None) {
        body = Buffer.from(encoded);
        if (this.m_nPacketRcvSeq !== 0)
          body[0] = CPacketHeaderConverter.DecodeHeader(type, body[0]!);
      } else {
        body = SimpleStreamDecrypt3(encoded, this.m_nPacketRcvSeq);
        const received =
          cipher === CipherDegree.CRC8
            ? this.pending[length - 1]!
            : BM.Decode4(this.pending, length - 4);
        const calculated =
          cipher === CipherDegree.CRC8
            ? CCRC8.UpdateCRC(this.m_nPacketRcvSeq, body)
            : CCRC32.UpdateCRC(this.m_nPacketRcvSeq, body);
        if (received !== calculated)
          throw new CProtocolError("Packet CRC mismatch", "crc-mismatch");
      }
      packets.push(new CReceivedPacketBase(body, cipher, this.text));
      this.m_nHeaderType = type;
      this.m_nPacketRcvSeq =
        (this.m_nPacketRcvSeq + this.m_nPacketRcvSeqDelta) >>> 0;
      this.pending = Buffer.from(this.pending.subarray(length));
    }
    return packets;
  }
}
