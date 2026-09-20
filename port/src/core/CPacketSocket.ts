/**
 * CPacketSocket — the framed TCP layer shared by every connection in the suite.
 *
 *   CClientSocket : server ↔ game client      (rolling header code + packet-type table + seq key)
 *   CLocalSocket  : server ↔ center/relays    (static header code, no rolling)
 *
 * Framing: [headerCode:1][length:2 BE][payload...] where length is the TOTAL
 * packet size and payload[0] is the (table-converted) packet type.
 */
import { CipherDegree,
  CReceivedPacket,
  CSendPacket,
  enSocket,
  kPacketRaw,
  type enSocket as EnSocket,
} from "./Packet.ts";
import { PacketLog } from "./PacketLog.ts";

/** CA_CIPHER_LIBERAL=1 — deliver checksum-failing packets with a loud log.
 *  Diagnostic probe only; the original always rejects, and with the correct
 *  STREAM_CIPHER_STEP the live client's frames verify byte-exactly, so this
 *  must stay OFF (the "template-stamped CRC" quirk it once worked around was
 *  an artifact of the stale 0x63D50CC3 step constant). */
export const CipherCompat = { liberal: process.env.CA_CIPHER_LIBERAL === "1" };

/** CClientSocket::OnReceiveCompletionPacket's receive-flood ring — the stamp
 *  table holds 50 entries, the guard arms on sequence 0x31 (the 49th receipt
 *  reads the ring's oldest slot), and the window is 0x3E8 ms (a wrap-safe
 *  unsigned delta).  Exceeding it reports and closes
 *  (FxServer.exe.c:9673; identical in CxLogin/FxShop/CxUtil). */
const RCV_STAMP_RING = 50;
const RCV_FLOOD_ARM_SEQ = 0x31;
const RCV_FLOOD_WINDOW_MS = 0x3e8;

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

  /** The receive-flood guard switch — the official CClientSocket of GS / LS /
   *  Shop / FXUS counts receipts (FxServer.exe.c:9673); the S2S, monitor and
   *  billing sockets never do. */
  m_fReceiveFloodGuard = false;
  /** +248 — the per-socket receipt counter (InterlockedIncrement). */
  m_nRcvStampSeq = 0;
  /** +252 — the 50-entry ring of timeGetTime stamps. */
  m_adwRcvStamp = new Uint32Array(RCV_STAMP_RING);

  /** PacketLog name-table key override (e.g. "MON", "BILL", "S2S"); null =
   *  this socket's server tag (m_szLogTag). */
  m_szLogTable: string | null = null;

  /** PacketLog scope marker: true on the client-facing sockets (the game
   *  clients and the shop web clients), false on the infra links (S2S
   *  CLocalSocket / CenterClientSocket, MonitorSocket, CBillingSocketTw).
   *  CA_PACKET_LOG_SCOPE picks which of the two groups traces (default:
   *  client only). */
  m_fClientLink = false;

  /** PacketLog server tag — snapshotted at construction (single-process mode
   *  runs every server's main() sequentially, so the global tag alone would
   *  mislabel everyone after the first boot). Client-socket classes pin their
   *  own tag in their constructors, since accept-time construction happens
   *  long after the owning main() returned. */
  m_szLogTag = PacketLog.tag;

  /** PacketLog peer label — the official class name (CClientSocket,
   *  CLocalSocket, MonitorSocket, …) distinguishes client links from S2S. */
  get LogPeer(): string {
    return this.constructor.name;
  }

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
   * CPacketSocket::SetSequence(nRcvSeq, nSndSeq, nRcvSeqDelta, nSndSeqDelta) —
   * the original argument order. The lst push labels are decisive (the last
   * push is nRcvSeq): client links SetSequence(40, 40, 3, 3) — the sequence
   * starts at 40 and rolls by 3 (CxLogin.exe.lst:4098C9, FxServer.exe.lst:
   * 407D19) — and local links SetSequence(40, 40, 0, 0) — a constant check
   * code, no rolling (CxLogin.exe.lst:40C22A). With a zero delta the code
   * byte is the bare base and deg-0 frames carry no rolling at all; a
   * non-zero seq enables the deg-1/2 type conversion table.
   */
  SetSequence(nRcvSeq: number, nSndSeq: number, nRcvSeqDelta: number, nSndSeqDelta: number): void {
    this.m_nPacketRcvSeq = nRcvSeq;
    this.m_nPacketSndSeq = nSndSeq;
    this.m_nPacketRcvSeqDelta = nRcvSeqDelta;
    this.m_nPacketSndSeqDelta = nSndSeqDelta;
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
    // First packet: derive the header type from it (mask BEFORE subtracting
    // the modifier — the decompile's unmasked intermediate never lands).
    const rawType = (code ^ ((this.m_nHeaderCodeRcvBase + this.m_nPacketRcvSeq) & 0xff)) & 0xff;
    this.m_nHeaderType = (rawType - (this.m_nHeaderCodeModifier & 0xff)) & 0xff;
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
      !packet.DecodePacket(
        buf,
        0,
        incoming,
        this.m_nPacketRcvSeq !== 0,
        this.m_nHeaderType,
        this.m_nPacketRcvSeq,
        CipherCompat.liberal,
      )
    ) {
      return enSocket.kioDecodingError;
    }
    const rest = this.m_nRcvCnt - incoming;
    buf.copyWithin(0, incoming, this.m_nRcvCnt);
    this.m_nRcvCnt = rest;
    this.m_nPacketRcvSeq = (this.m_nPacketRcvSeq + this.m_nPacketRcvSeqDelta) & 0xffffffff;
    if (this.m_fClientLink ? PacketLog.ShowsClient() : PacketLog.ShowsInfra()) {
      PacketLog.Packet(this.LogPeer, this.m_szLogTag, "recv", packet.m_nPacketType, packet.m_nCipherDegree, packet.m_pBlock.subarray(0, packet.m_uLength), this.m_szLogTable);
    }
    return enSocket.kioOk;
  }

  /** The send-buffer-overflow report — every official class names its own
   *  link here and closes (the S2S local/billing links add "terminate
   *  process": the deployment is broken once a peer stops draining). */
  protected ReportSendOverflow(): void {}

  /** CPacketSocket::PutPacket */
  PutPacket(packet: CSendPacket): EnSocket {
    if (!this.m_bConnected) return enSocket.kioNotConnected;
    const outgoing = packet.GetOutgoingPacketLength();
    if (outgoing <= 0) return enSocket.kioInvalidPacket;
    if (outgoing + this.m_nSndCnt > this.m_mbSndBuffer.length) {
      this.ReportSendOverflow();
      this.PostClosePacket();
      return enSocket.kioSendBufferOverflow;
    }
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
    if (this.m_fClientLink ? PacketLog.ShowsClient() : PacketLog.ShowsInfra()) {
      PacketLog.Packet(this.LogPeer, this.m_szLogTag, "send", packet.m_nPacketType, packet.m_nCipherDegree, packet.m_pBlock.subarray(0, packet.m_uOffset), this.m_szLogTable);
    }
    return enSocket.kioOk;
  }

  /** CPacketSocket::PutBuffer — raw bytes into the send buffer. */
  PutBuffer(pBuf: Uint8Array, len: number): EnSocket {
    if (!this.m_bConnected) return enSocket.kioNotConnected;
    if (len <= 0) return enSocket.kioInvalidPacket;
    if (this.m_nSndCnt + len > this.m_mbSndBuffer.length) {
      this.ReportSendOverflow();
      this.PostClosePacket();
      return enSocket.kioSendBufferOverflow;
    }
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
    if (this.m_fReceiveFloodGuard) this.CheckReceiveFlood();
    if (this.m_nRcvCnt + data.length > this.m_mbRcvBuffer.length) {
      this.ReportReceiveOverflow();
      this.PostClosePacket();
      return;
    }
    this.m_mbRcvBuffer.set(data, this.m_nRcvCnt);
    this.m_nRcvCnt += data.length;
    this.OnReceiveCompletionPacket();
  }

  /** CClientSocket::OnReceiveCompletionPacket's flood check — one stamp per
   *  receive event; once 49 receipts have gone by, a full ring within one
   *  second reports and closes (the unsigned delta survives tick wrap). */
  protected CheckReceiveFlood(): void {
    const n = ++this.m_nRcvStampSeq;
    const now = Date.now() & 0x7fffffff;
    this.m_adwRcvStamp[n % RCV_STAMP_RING] = now;
    if (n >= RCV_FLOOD_ARM_SEQ && ((now - this.m_adwRcvStamp[(n + 1) % RCV_STAMP_RING]!) >>> 0) <= RCV_FLOOD_WINDOW_MS) {
      console.error(`Time stamp for received packet overflow from (${this.bunSocket?.remoteAddress ?? ""})`);
      this.PostClosePacket();
    }
  }

  /** The receive-buffer-overflow report — every official socket class names
   *  its own link here ("(%s), disconnected." on the client sockets, "on
   *  LocalSocket" / "on Billing Socket" / "(%s), PostClosePacket called" on
   *  the infra links); FXUS's CClientSocket stays silent. */
  protected ReportReceiveOverflow(): void {}

  /** CClientSocket::GetPacket's error reports (CxLogin.exe.c:9484) — the
   *  original logs the exact failure and the full cipher state before
   *  closing; the port reproduces those lines verbatim. */
  protected ReportGetPacketError(err: EnSocket, packet: CReceivedPacket): void {
    const addr = this.bunSocket?.remoteAddress ?? "";
    if (err === enSocket.kioInvalidPacket) {
      console.error(`Invalid( = NULL ) packet received, close connection: [${addr}]`);
    } else if (err === enSocket.kioTooLongPacket) {
      console.error(`Too long packet length read, close connection: [${addr}], packet id[${packet.Decode1()}]`);
    } else if (err === enSocket.kioSequencingError) {
      console.error(`Error in client packet sequencing, close connection: [${addr}]`);
    } else if (err === enSocket.kioDecodingError) {
      console.error(`Error in client packet decoding(Maybe CRC Mismatch), close connection: [${addr}]`);
    }
    // other codes (kioNotConnected after a close, …) hit the original's
    // `default: break` — FxServer.exe.c:9504 returns silently, so the port
    // must not invent an extra "Error N in packet pump" line here.
    console.error(
      "    +- header type=%d, base=%d(r)/%d(s), modif=%d, seq=%d(r)/%d(s), deltaseq=%d(r), %d(s), header code=%d(r)/%d(s)",
      this.m_nHeaderType,
      this.m_nHeaderCodeRcvBase,
      this.m_nHeaderCodeSndBase,
      this.m_nHeaderCodeModifier,
      this.m_nPacketRcvSeq,
      this.m_nPacketSndSeq,
      this.m_nPacketRcvSeqDelta,
      this.m_nPacketSndSeqDelta,
      this.GetRcvHeaderCode(),
      this.GetSndHeaderCode(),
    );
    // the frame bytes on any error path — the one datum that pins down a
    // foreign peer's cipher convention.
    console.error(
      `    +- rcv buffer (${this.m_nRcvCnt}B): ${Array.from(this.m_mbRcvBuffer.subarray(0, Math.min(this.m_nRcvCnt, 64))).map((x) => x.toString(16).padStart(2, "0")).join(" ")}`,
    );
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
        if (process.env.LS_DEBUG && this.m_nRcvCnt > 0) {
          console.error(
            `[LS_DEBUG] partial frame pending (${this.m_nRcvCnt}B): ${Array.from(this.m_mbRcvBuffer.subarray(0, Math.min(this.m_nRcvCnt, 64))).map((x) => x.toString(16).padStart(2, "0")).join(" ")}`,
          );
        }
        return;
      }
      // 3 (invalid), 5 (too long), 6 (sequencing), 7 (decoding) and others all close.
      this.ReportGetPacketError(err, packet);
      this.PostClosePacket();
      return;
    }
  }

  /** CServerSocket::PostClosePacket — schedule this socket for disconnection. */
  PostClosePacket(): void {
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
