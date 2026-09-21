/** Native source unit: CX/CxCenter/LocalSocket.cpp. */
import { CPacketSocket } from "../core/PacketSocket.ts";
import { enSocket, type enSocket as EnSocket, type CReceivedPacket } from "../core/Packet.ts";
import {
  CENTER_VERSION,
  CENTER_GREETING_SIZE,
  LOCAL_SERVER_IDENTIFICATION_SIZE,
  LOCALSOCKET_HEADER_CODE_RCV,
  LOCALSOCKET_HEADER_CODE_SND,
  LOCALSOCKET_HEADER_CODE_MODIFIER,
  LOCALSOCKET_SEQ,
  LOCALSOCKET_SEQ_DELTA,
  SVRIDX_IDENTIFY_XOR,
  MC_DISPATCH_NAMES_BY_SERVER_CLASS,
} from "../protocol/CenterProtocol.ts";
import type { CLocalServer, LocalServerHost } from "./LocalServer.ts";

/** Port-side host callbacks for the native center local socket. */
export interface LocalSocketHost extends LocalServerHost {
  OnDisconnect(sock: CLocalSocket): void;
  RegisterLocalServer(
    sock: CLocalSocket,
    nServerClass: number,
    nSvrIdx: number,
    nGameVersion: number,
    nClientVersion: number,
  ): void;
}

/**
 * CxCenter.exe.c:14833 — accepted local sockets take a global counter as
 * their header type (dword_481090 & 0x8000000F).  Until the first framed
 * packet from the server derives the real shared type, sends convert through
 * whatever row the counter gives — exactly like the original.
 */
let ms_nLocalSocketHeaderTypeCounter = 0;

/** Center-side socket for one attached local server. */
export class CLocalSocket extends CPacketSocket {
  owner: CLocalServer | null = null;

  /** "Socket receive buffer overflow(name:addr), PostClosePacket called" —
   *  the name comes from the identified CLocalServer (CxCenter.exe.c:15116). */
  protected override ReportReceiveOverflow(): void {
    const addr = this.bunSocket?.remoteAddress ?? "";
    console.error(`Socket receive buffer overflow(${this.owner?.m_strName ?? ""}:${addr}), PostClosePacket called`);
  }

  /** "Socket send buffer overflow, close connection: (name:addr)"
   *  (CxCenter.exe.c:15015). */
  protected override ReportSendOverflow(): void {
    const addr = this.bunSocket?.remoteAddress ?? "";
    console.error(`Socket send buffer overflow, close connection: (${this.owner?.m_strName ?? ""}:${addr})`);
  }

  /** the center side of the local link (CxCenter.exe.c:14997). */
  protected override ReportPutError(err: EnSocket): void {
    if (err === enSocket.kioNotConnected) console.error("Not-connected local socket tried to put packet.");
    else if (err === enSocket.kioInvalidPacket) console.error("tried to send invalid( =\tNULL ) packet to local socket");
  }

  /** CLocalSocket::GetPacket's local-link family, center side (CxCenter.exe.c:14936). */
  protected override ReportInvalidPacketLine(addr: string): void {
    console.error(`Invalid( = NULL ) packet received from local socket, close connection: [${addr}]`);
  }
  protected override ReportTooLongPacketLine(addr: string, id: number): void {
    console.error(`Too long packet length read from local socket, close connection: [${addr}], packet id[${id}]`);
  }
  protected override ReportSequencingErrorLine(addr: string): void {
    console.error(`Error in local packet sequencing, close connection: [${addr}]`);
  }
  protected override ReportDecodingErrorLine(addr: string): void {
    console.error(`Error in local packet decoding(Maybe CRC Mismatch), close connection: [${addr}]`);
  }
  private pending = new Uint8Array(0);
  private fGreeted = false;
  private fIdentified = false;

  constructor(private center: LocalSocketHost) {
    super(CPacketSocket.dwRcvBufferSize, CPacketSocket.dwSndBufferSize, {
      onPacket: (sock, packet) => (sock as CLocalSocket).DispatchPacket(packet),
      onClose: (sock) => center.OnDisconnect(sock as CLocalSocket),
    });
    this.m_szLogTag = "Center";
    // Center-side bases are the reverse of the connector's.  Both sides use
    // the original SetSequence(40, 40, 0, 0).
    this.SetHeaderType(ms_nLocalSocketHeaderTypeCounter++ & 0x8000000f);
    this.SetHeaderCode(
      LOCALSOCKET_HEADER_CODE_SND,
      LOCALSOCKET_HEADER_CODE_RCV,
      LOCALSOCKET_HEADER_CODE_MODIFIER,
    );
    this.SetSequence(LOCALSOCKET_SEQ, LOCALSOCKET_SEQ, LOCALSOCKET_SEQ_DELTA, LOCALSOCKET_SEQ_DELTA);
  }

  /** Route a completed local-link packet through the attached server vtable. */
  private DispatchPacket(packet: CReceivedPacket): void {
    const owner = this.owner;
    if (!owner) return;
    const id = packet.Decode1();
    if (MC_DISPATCH_NAMES_BY_SERVER_CLASS[owner.nServerClass]?.names[id] === undefined) return;
    owner.OnPacket(id, packet, this.center);
  }

  /** CLocalServerMan::OnConnEstablished — the greeting goes out on accept. */
  SendGreeting(): void {
    if (this.fGreeted) return;
    // CxCenter.exe.lst:40D7E0 reads CPacketSocket +0x20: m_nHeaderType,
    // despite the decompiler's misleading `m_sd` field label.
    const greeting = new Uint8Array(CENTER_GREETING_SIZE);
    greeting[0] = (CENTER_VERSION >>> 8) & 0xff;
    greeting[1] = CENTER_VERSION & 0xff;
    const headerType = this.m_nHeaderType & 0xffff;
    greeting[2] = (headerType >>> 8) & 0xff;
    greeting[3] = headerType & 0xff;
    this.fGreeted = this.SendBuffer(greeting) === enSocket.kioOk;
  }

  OnData(data: Uint8Array): void {
    this.SendGreeting();
    if (!this.m_bConnected) return;
    if (this.fIdentified) {
      this.OnReceive(data);
      return;
    }
    const all = new Uint8Array(this.pending.length + data.length);
    all.set(this.pending);
    all.set(data, this.pending.length);
    if (all.length < LOCAL_SERVER_IDENTIFICATION_SIZE) {
      this.pending = all;
      return;
    }
    this.pending = new Uint8Array(0);
    this.fIdentified = true;
    const nServerClass = all[0]!;
    this.m_szLogTable = `Center:${nServerClass}`;
    const idxX = (all[1]! | (all[2]! << 8) | (all[3]! << 16) | (all[4]! << 24)) >>> 0;
    const nSvrIdx = (idxX ^ SVRIDX_IDENTIFY_XOR) >>> 0;
    const nGameVersion = all[5]! | (all[6]! << 8);
    const nClientVersion = all[7]! | (all[8]! << 8);
    this.center.RegisterLocalServer(this, nServerClass, nSvrIdx, nGameVersion, nClientVersion);
    if (all.length > LOCAL_SERVER_IDENTIFICATION_SIZE) this.OnReceive(all.subarray(LOCAL_SERVER_IDENTIFICATION_SIZE));
  }
}
