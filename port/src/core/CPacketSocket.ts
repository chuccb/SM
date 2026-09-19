/**
 * CPacketSocket — the framed TCP layer shared by every connection in the suite.
 *
 *   CClientSocket : server ↔ game client      (rolling header code + packet-type table + seq key)
 *   CLocalSocket  : server ↔ center/relays    (static header code, no rolling)
 *
 * Framing: [headerCode:1][length:2 BE][payload...] where length is the TOTAL
 * packet size and payload[0] is the (table-converted) packet type.
 */
import {
  CReceivedPacket,
  CSendPacket,
  enSocket,
  kPacketRaw,
  type enSocket as EnSocket,
} from "./Packet.ts";

export interface IPacketSocketHooks {
  onPacket(sock: CPacketSocket, packet: CReceivedPacket): void;
  onClose(sock: CPacketSocket): void;
}

export abstract class CPacketSocket {
  static ms_nHeaderTypeCounter = 0;

  m_nCipherDegree = 0;
  m_nHeaderType = 0;
  m_nHeaderCodeRcvBase = 0;
  m_nHeaderCodeSndBase = 0;
  m_nHeaderCodeModifier = 0;
  m_nPacketRcvSeq = 0;
  m_nPacketSndSeq = 0;
  m_nPacketRcvSeqDelta = 0;
  m_nPacketSndSeqDelta = 0;
  m_nMaxPacketLen = 0;
  m_mbRcvBuffer: Uint8Array;
  m_mbSndBuffer: Uint8Array;
  m_nRcvCnt = 0;
  m_nSndCnt = 0;
  m_fHeaderTypeSet = 0;
  m_nLastRcvHeaderCode = -1;

  m_bConnected = false;
  hooks: IPacketSocketHooks;

  /** Bun socket handle (set by subclasses). */
  bunSocket: Bun.Socket<any> | null = null;

  /** CServerSocket::Startup-time buffer sizes (8 / 24 system pages). */
  static readonly PAGE_SIZE = 4096;
  static readonly dwRcvBufferSize = 8 * CPacketSocket.PAGE_SIZE;
  static readonly dwSndBufferSize = 24 * CPacketSocket.PAGE_SIZE;

  constructor(
    dwRcvBufferSize = CPacketSocket.dwRcvBufferSize,
    dwSndBufferSize = CPacketSocket.dwSndBufferSize,
    hooks?: Partial<IPacketSocketHooks>,
  ) {
    this.m_mbRcvBuffer = new Uint8Array(dwRcvBufferSize);
    this.m_mbSndBuffer = new Uint8Array(dwSndBufferSize);
    this.m_nMaxPacketLen = dwRcvBufferSize;
    this.hooks = {
      onPacket: hooks?.onPacket ?? (() => {}),
      onClose: hooks?.onClose ?? (() => {}),
    };
  }

  /** CPacketSocket::SetHeaderType — also arms m_fHeaderTypeSet (the ctor
   *  bytes `c7 41 64 01` at 0042EAE0: the accept-side socket keeps the
   *  counter-derived header type; only the PEER learns its k from the first
   *  frame it receives). */
  SetHeaderType(nHeaderType: number): void {
    this.m_nHeaderType = nHeaderType;
    this.m_fHeaderTypeSet = 1;
  }

  /** CPacketSocket::SetHeaderCode */
  SetHeaderCode(nHeaderCodeRcvBase: number, nHeaderCodeSndBase: number, nHeaderCodeModifier: number): void {
    this.m_nHeaderCodeRcvBase = nHeaderCodeRcvBase;
    this.m_nHeaderCodeSndBase = nHeaderCodeSndBase;
    this.m_nHeaderCodeModifier = nHeaderCodeModifier;
  }

  /**
   * CPacketSocket::SetSequence(rcvSeqDelta, sndSeqDelta, rcvSeq, sndSeq).
   * The callee stores arg1→+30, arg2→+34, arg3→+38, arg4→+3C, and usage is:
   * +30/+34 are the CRC-key sequences (they roll by +38/+3C per packet and
   * their non-zero-ness enables the packet-type conversion table), +38/+3C
   * are the deltas.  The shipped callers pass pairwise-symmetric constants —
   * client links SetSequence(40, 40, 3, 3), local links SetSequence(40, 40,
   * 0, 0) — so the assembly alone cannot tell which pair lands in the seq
   * slots; the semantics decide: under (delta, delta, seq, seq) the local
   * links run rcvSeq = 0 → no type conversion (both ends pass the type byte
   * straight through; with the roles swapped each end would derive a
   * different conversion row — 1 vs 113 — and gsConvertTableDecode[113] is
   * provably not the inverse of encode row 1, so that reading cannot work),
   * while the client links run seq = 3 rolling by 40, deriving the shared
   * conversion row from the first check code.
   */
  SetSequence(nRcvSeqDelta: number, nSndSeqDelta: number, nRcvSeq: number, nSndSeq: number): void {
    this.m_nPacketRcvSeqDelta = nRcvSeqDelta;
    this.m_nPacketSndSeqDelta = nSndSeqDelta;
    this.m_nPacketRcvSeq = nRcvSeq;
    this.m_nPacketSndSeq = nSndSeq;
  }

  /** CPacketSocket::SetCipherDegree */
  SetCipherDegree(nCipherDegree: number): void {
    if (nCipherDegree <= 2) this.m_nCipherDegree = nCipherDegree;
  }

  /** CPacketSocket::GetRcvHeaderCode */
  GetRcvHeaderCode(): number {
    if (this.m_nPacketRcvSeqDelta !== 0)
      return ((this.m_nHeaderType + this.m_nHeaderCodeModifier) ^ (this.m_nHeaderCodeRcvBase + this.m_nPacketRcvSeq)) & 0xff;
    return this.m_nHeaderCodeRcvBase & 0xff;
  }

  /** CPacketSocket::GetSndHeaderCode */
  GetSndHeaderCode(): number {
    if (this.m_nPacketSndSeqDelta !== 0)
      return ((this.m_nHeaderType + this.m_nHeaderCodeModifier) ^ (this.m_nHeaderCodeSndBase + this.m_nPacketSndSeq)) & 0xff;
    return this.m_nHeaderCodeSndBase & 0xff;
  }

  /** CPacketSocket::CheckCode */
  CheckCode(pBuf: Uint8Array, off = 0): boolean {
    const code = pBuf[off]!;
    if (this.m_fHeaderTypeSet !== 0) {
      let expected: number;
      if (this.m_nPacketRcvSeqDelta !== 0) {
        expected =
          (((this.m_nHeaderType & 0xff) + (this.m_nHeaderCodeModifier & 0xff)) ^
            ((this.m_nHeaderCodeRcvBase & 0xff) + (this.m_nPacketRcvSeq & 0xff))) & 0xff;
      } else {
        expected = this.m_nHeaderCodeRcvBase & 0xff;
      }
      return code === expected;
    }
    // First packet: derive the header type from it.
    const v5 = (code ^ ((this.m_nHeaderCodeRcvBase + this.m_nPacketRcvSeq) & 0xff)) & 0xff;
    this.m_nHeaderType = (code ^ ((this.m_nHeaderCodeRcvBase + this.m_nPacketRcvSeq) & 0xff)) - (this.m_nHeaderCodeModifier & 0xff);
    this.m_nHeaderType = (v5 - (this.m_nHeaderCodeModifier & 0xff)) & 0xff;
    this.m_fHeaderTypeSet = 1;
    return true;
  }

  /** CPacketSocket::MarkCheckCode */
  MarkCheckCode(pBuf: Uint8Array, off = 0): void {
    if (this.m_nPacketSndSeqDelta !== 0) {
      pBuf[off] =
        ((((this.m_nHeaderType & 0xff) + (this.m_nHeaderCodeModifier & 0xff)) &
          0xff) ^
          (((this.m_nHeaderCodeSndBase & 0xff) + (this.m_nPacketSndSeq & 0xff)) & 0xff)) &
        0xff;
    } else {
      pBuf[off] = this.m_nHeaderCodeSndBase & 0xff;
    }
  }

  /** CPacketSocket::GetPacket — pull one framed packet out of the receive buffer. */
  GetPacket(packet: CReceivedPacket): EnSocket {
    if (!this.m_bConnected) return enSocket.kioNotConnected;
    if (this.m_nRcvCnt === 0) return enSocket.kioNotReady;
    packet.SetCipherDegree(this.m_nCipherDegree);
    const buf = this.m_mbRcvBuffer;
    this.m_nLastRcvHeaderCode = buf[0]!;
    if (!this.CheckCode(buf)) return enSocket.kioSequencingError;
    const incoming = CReceivedPacket.GetIncomingPacketLength(buf, 0, this.m_nRcvCnt, this.m_nCipherDegree);
    if (incoming === -1) return enSocket.kioNotReady;
    if (incoming === 0) return enSocket.kioInvalidPacket;
    if (incoming > this.m_nMaxPacketLen) {
      packet.DecodePacket(buf, 0, this.m_nRcvCnt, this.m_nPacketRcvSeq !== 0, this.m_nHeaderType, this.m_nPacketRcvSeq);
      return enSocket.kioTooLongPacket;
    }
    if (incoming > this.m_nRcvCnt) return enSocket.kioNotReady;
    if (
      !packet.DecodePacket(buf, 0, incoming, this.m_nPacketRcvSeq !== 0, this.m_nHeaderType, this.m_nPacketRcvSeq)
    ) {
      return enSocket.kioDecodingError;
    }
    const rest = this.m_nRcvCnt - incoming;
    buf.copyWithin(0, incoming, this.m_nRcvCnt);
    this.m_nRcvCnt = rest;
    this.m_nPacketRcvSeq = (this.m_nPacketRcvSeq + this.m_nPacketRcvSeqDelta) & 0xffffffff;
    return enSocket.kioOk;
  }

  /** CPacketSocket::PutPacket */
  PutPacket(packet: CSendPacket): EnSocket {
    if (!this.m_bConnected) return enSocket.kioNotConnected;
    const outgoing = packet.GetOutgoingPacketLength();
    if (outgoing <= 0) return enSocket.kioInvalidPacket;
    if (outgoing + this.m_nSndCnt > this.m_mbSndBuffer.length) return enSocket.kioSendBufferOverflow;
    if (
      packet.EncodePacket(
        this.m_mbSndBuffer,
        this.m_nSndCnt,
        outgoing,
        this.m_nPacketSndSeq !== 0,
        this.m_nHeaderType,
        this.m_nPacketSndSeq,
      ) === 0
    ) {
      return enSocket.kioEncodingError;
    }
    this.MarkCheckCode(this.m_mbSndBuffer, this.m_nSndCnt);
    this.m_nPacketSndSeq = (this.m_nPacketSndSeq + this.m_nPacketSndSeqDelta) & 0xffffffff;
    this.m_nSndCnt += outgoing;
    return enSocket.kioOk;
  }

  /** CPacketSocket::PutBuffer — raw bytes into the send buffer. */
  PutBuffer(pBuf: Uint8Array, len: number): EnSocket {
    if (!this.m_bConnected) return enSocket.kioNotConnected;
    if (len <= 0) return enSocket.kioInvalidPacket;
    if (this.m_nSndCnt + len > this.m_mbSndBuffer.length) return enSocket.kioSendBufferOverflow;
    this.m_mbSndBuffer.set(pBuf.subarray(0, len), this.m_nSndCnt);
    this.m_nSndCnt += len;
    return enSocket.kioOk;
  }

  /** CPacketSocket::Flush */
  Flush(): void {
    if (this.m_nSndCnt > 0 && this.bunSocket) {
      const out = this.m_mbSndBuffer.subarray(0, this.m_nSndCnt).slice();
      this.m_nSndCnt = 0;
      this.bunSocket.write(out);
    }
  }

  /** CPacketSocket::SendPacket */
  SendPacket(packet: CSendPacket): EnSocket {
    const err = this.PutPacket(packet);
    if (err === enSocket.kioOk) this.Flush();
    return err;
  }

  /** Feed received raw bytes; pumps complete packets to hooks.onPacket. */
  OnReceive(data: Uint8Array): void {
    if (!this.m_bConnected) return;
    if (this.m_nRcvCnt + data.length > this.m_mbRcvBuffer.length) {
      this.PostClosePacket();
      return;
    }
    if (process.env.TC_DEBUG) console.error(`[TCDBG] onReceive deg=${this.m_nCipherDegree} len=${data.length} head=${Array.from(data.slice(0, 10)).map((x) => x.toString(16).padStart(2, "0")).join(" ")}`);
    this.m_mbRcvBuffer.set(data, this.m_nRcvCnt);
    this.m_nRcvCnt += data.length;
    this.OnReceiveCompletionPacket();
  }

  /** CServerSocket::OnReceiveCompletionPacket — drain every complete packet. */
  OnReceiveCompletionPacket(): void {
    const packet = new CReceivedPacket();
    for (;;) {
      const err = this.GetPacket(packet);
      if (err === enSocket.kioOk) {
        this.hooks.onPacket(this, packet);
        continue;
      }
      if (err === enSocket.kioNotReady) {
        if (process.env.TC_DEBUG) console.error(`[TCDBG] notReady deg=${this.m_nCipherDegree} rcvCnt=${this.m_nRcvCnt} head=${Array.from(this.m_mbRcvBuffer.slice(0, Math.min(12, this.m_nRcvCnt))).map((x) => x.toString(16).padStart(2, "0")).join(" ")}`);
        return;
      }
      if (process.env.TC_DEBUG) console.error(`[TCDBG] getPacket err=${err} deg=${this.m_nCipherDegree}`);
      // 3 (invalid), 5 (too long), 6 (sequencing), 7 (decoding) and others all close.
      this.PostClosePacket();
      return;
    }
  }

  /** CServerSocket::PostClosePacket — schedule this socket for disconnection. */
  PostClosePacket(): void {
    if (process.env.TC_DEBUG) console.error(`[TCDBG] postClose deg=${this.m_nCipherDegree}`, new Error("trace").stack?.split("\n").slice(2, 5).join(" | "));
    if (this.bunSocket) {
      try {
        this.bunSocket.end();
      } catch {
        /* already closed */
      }
    }
    this.Close();
  }

  Close(): void {
    if (!this.m_bConnected) return;
    this.m_bConnected = false;
    try {
      this.bunSocket?.end();
    } catch {
      /* ignore */
    }
    this.bunSocket = null;
    this.hooks.onClose(this);
  }

  /** kPacketRaw — every shipped link runs unencrypted. */
  static readonly defaultCipherDegree = kPacketRaw;
}
