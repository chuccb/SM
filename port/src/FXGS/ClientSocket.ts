/** Native source unit: FX/FxServer/ClientSocket.cpp. */
import { CPacketSocket } from "../core/PacketSocket.ts";
import { PACKET_HEADER_TYPE_COUNT } from "../core/PacketHeaderConverter.ts";
import { CSendPacket, enSocket, type enSocket as EnSocket } from "../core/Packet.ts";
import {
  CLIENTSOCKET_HEADER_CODE_MODIFIER,
  CLIENTSOCKET_HEADER_CODE_RCV,
  CLIENTSOCKET_HEADER_CODE_SND,
  CLIENTSOCKET_SEQ,
  CLIENTSOCKET_SEQ_DELTA,
} from "../core/PacketSocket.ts";
import { timeGetTime } from "../core/timeGetTime.ts";
import { CUser } from "./User.ts";
import { CCenterProcess } from "./CenterProcess.ts";
import { CMainSystem } from "./MainSystem.ts";
import { CLocalUserTable } from "./LocalUserTable.ts";
import { GetClientSocketPool } from "./ClientSocketRuntime.ts";
import { DestroySessionPlayer } from "./SessionTableRuntime.ts";
import { SESSION_IDX_NONE } from "./Defs.ts";

const INITIAL_IDLE_AGE_MS = 5_000;

/** CClientSocket — one connected game client (FxServer.exe.c:9818). */
export class CClientSocket extends CPacketSocket {
  /** CClientSocket::OnReceiveCompletionPacket guards the client links only
   *  (FxServer.exe.c:9673). */
  override m_fReceiveFloodGuard = true;
  protected override ReportReceiveOverflow(): void {
    console.error(`Socket receive buffer overflow(${this.bunSocket?.remoteAddress ?? ""}), disconnected.`);
  }

  protected override ReportSendOverflow(): void {
    console.error(`Socket send buffer overflow, close connection: (${this.bunSocket?.remoteAddress ?? ""})`);
  }

  /** CClientSocket::PutPacket's wrapper switch (FxServer.exe.c:9526). */
  protected override ReportPutError(err: EnSocket): void {
    const addr = this.bunSocket?.remoteAddress ?? "";
    if (err === enSocket.kioNotConnected) {
      console.error(`Not-connected client [${addr}] socket tried to put packet.`);
      this.PostClosePacket(); // the GS build's case 1 falls into the LABEL_7 close (FxServer.exe.c:9534); the other exes' client wrappers just return
    } else if (err === enSocket.kioInvalidPacket) console.error("tried to send invalid( =\tNULL ) packet");
  }

  /** CClientSocket::GetPacket's sequencing line carries the cipher detail
   *  (FxServer.exe.c:9466) — only the GS build spells it out.  The
   *  official's m_nPacketSeq is CClientSocket+52 (this+13), the snd seq of
   *  the +- dump — not the rcv base. */
  protected override ReportSequencingErrorLine(addr: string): void {
    console.error(
      `Error in client packet sequencing(m_nHeaderType, m_nPacketSeq = ${this.m_nHeaderType}, ${this.m_nPacketSndSeq}), close connection: [${addr}]`,
    );
  }
  static override ms_nHeaderTypeCounter = 0;
 // dword_4AF338
  static ms_tblSN2Obj = new Map<number, CClientSocket>();

  m_nLocalSerialNo = 0; // CSerialObject SN
  m_nPoolType = 0; // +468 stage tag (0 connect, 3 channels, 1 lobby, 2 room, 4 playing, 6 practice)
  m_nSessionIdx = SESSION_IDX_NONE; // +500 — a WORD in the original (ctor `mov word -1`,
  // FxServer.exe.c:9831): 0xFFFF = none/lobby, 0xFFFE (-2) = connecting, else slot
  m_nSessionSerialNo = 0; // +504 (CUser::SetSessionSerialNo)
  m_fImpPoint = 0; // +472 (CClientSocket::SetImpPoint — modified client)
  m_dwLastRTT = 0; // the socket's last RTT reply time
  m_apUser: (CUser | null)[] = []; // +460
  m_nUserCount = 0; // +456
  m_anBeforeJoinSession: number[] = []; // +476..+496 (5-deep ring)
  m_dwIdleTime = (timeGetTime() - INITIAL_IDLE_AGE_MS) >>> 0;
  /** The CBaseSession::PutPacket queue (this+56); FlushPacket drains it. */
  m_pendingPackets: CSendPacket[] = [];

  constructor() {
    super(CPacketSocket.dwRcvBufferSize, CPacketSocket.dwSndBufferSize, {
      onPacket: (_sock, packet) => CMainSystem.ms_pInstance?.DispatchClient(packet, this),
    });
    this.m_szLogTag = "GS";
    this.m_fClientLink = true;
    this.m_nLocalSerialNo = CClientSocket.ms_tblSN2Obj.size + 1;
    const nHeaderType = CClientSocket.ms_nHeaderTypeCounter % PACKET_HEADER_TYPE_COUNT;
    CClientSocket.ms_nHeaderTypeCounter++;
    this.SetHeaderType(nHeaderType);
    this.SetHeaderCode(CLIENTSOCKET_HEADER_CODE_RCV, CLIENTSOCKET_HEADER_CODE_SND, CLIENTSOCKET_HEADER_CODE_MODIFIER);
    this.SetSequence(CLIENTSOCKET_SEQ, CLIENTSOCKET_SEQ, CLIENTSOCKET_SEQ_DELTA, CLIENTSOCKET_SEQ_DELTA);
    CClientSocket.ms_tblSN2Obj.set(this.m_nLocalSerialNo, this);
  }

  /** CClientSocket::GetSocketFromLocalSerialNo */
  static GetSocketFromLocalSerialNo(n: number): CClientSocket | null {
    return CClientSocket.ms_tblSN2Obj.get(n) ?? null;
  }

  /** CClientSocket::AddNewUsers */
  AddNewUsers(n: number): void {
    this.m_apUser = [];
    for (let i = 0; i < n; i++) this.m_apUser.push(new CUser(this));
    this.m_nUserCount = n;
  }

  /** CClientSocket::SetUser / GetUser / GetUserCount */
  SetUser(i: number, user: CUser): void {
    this.m_apUser[i] = user;
  }

  GetUser(i: number): CUser | null {
    return this.m_apUser[i] ?? null;
  }

  GetUserCount(): number {
    return this.m_nUserCount;
  }

  /** CClientSocket::GetMaxLevelUser */
  GetMaxLevelUser(): CUser | null {
    let best: CUser | null = null;
    for (const u of this.m_apUser) {
      if (u && (!best || u.m_nLevel > best.m_nLevel)) best = u;
    }
    return best;
  }

  /** CClientSocket::CheckInBeforeJoinSession */
  CheckInBeforeJoinSession(idx: number): boolean {
    return this.m_anBeforeJoinSession.includes(idx);
  }

  /**
   * CClientSocket::AddBeforeJoinSession (FxServer.exe.c:8908) — remember a
   * session idx this socket left, in the fixed 5-entry array at +476 with the
   * count at +496: once full, entry 0 falls off ([119]<=[120]<=[121]<=
   * [122]<=[123]=idx).
   */
  AddBeforeJoinSession(idx: number): void {
    if (this.CheckInBeforeJoinSession(idx)) return;
    if (this.m_anBeforeJoinSession.length >= 5) this.m_anBeforeJoinSession.shift();
    this.m_anBeforeJoinSession.push(idx);
  }

  /** CClientSocket::GetSelfidxFromSerialNo */
  GetSelfidxFromSerialNo(n: number): number {
    return this.m_apUser.findIndex((u) => u && u.m_nGlobalSerialNo === n);
  }

  /** CClientSocket::IsAttatchedUser — does this socket own the user? */
  IsAttatchedUser(user: CUser): boolean {
    return this.m_apUser.includes(user);
  }

  /** CClientSocket::HasAuthority — always 0 without the operator link. */
  /** CClientSocket::HasAuthority (:8558) and CUser::HasAuthority (:26476)
   *  are both bare `retn 0` in the shipped binary — every caller's bit
   *  argument (1 operator-slot, 21/22/23/25 …) is a dead branch there, so
   *  the bit semantics cannot be confirmed from behaviour and stay
   *  unamed at the call sites. */
  HasAuthority(_authority: number): number {
    return 0;
  }

  /** CClientSocket::GetMaxLevelUserIdx (FxServer.exe.c:8871) — the roster
   *  index of the highest-level user (the raw +1984 level field). */
  GetMaxLevelUserIdx(): number {
    let best = 0;
    let max = 0;
    for (let i = 0; i < this.GetUserCount(); i++) {
      const level = this.GetUser(i)!.m_nLevel;
      if (level > max) {
        max = level;
        best = i;
      }
    }
    return best;
  }

  /** CBaseSession::PutPacket target (CClientSocket vtbl+56) — queue a copy
   *  of the session's shared packet.  (CPacketSocket::PutPacket above is the
   *  encode-into-send-buffer primitive the base socket uses.) */
  PutPacketQueued(packet: CSendPacket): void {
    const copy = new CSendPacket(packet.m_nPacketType, packet.m_nCipherDegree);
    copy.EncodeBuffer(packet.m_pBlock.subarray(1, packet.m_uOffset)); // skip the type byte
    this.m_pendingPackets.push(copy);
  }

  /** CClientSocket vtbl+64 — send everything the sessions queued. */
  FlushQueued(): void {
    if (this.m_pendingPackets.length === 0) return;
    const queue = this.m_pendingPackets;
    this.m_pendingPackets = [];
    for (const p of queue) this.SendPacket(p);
  }

  /** CClientSocket vtbl+76 — one last packet, then destroy the connection. */
  ForceSendAndClose(packet: CSendPacket): void {
    this.SendPacket(packet);
    this.Close();
  }

  /** CClientSocket::SafeFree — session teardown, pool removal, user frees. */
  protected override OnClose(): void {
    const db = CCenterProcess.ms_pInstance?.db ?? null;
    // CGameSessionTable::DestroyPlayer when seated
    DestroySessionPlayer(this, 0);
    // pool removal (connect pool before entry, channel pool afterwards)
    const pool = GetClientSocketPool(this.m_nPoolType);
    pool?.DeleteSocket(this);
    // per-user cleanup: table removal, dyn/inventory flush, center p1
    for (const user of this.m_apUser) {
      if (!user) continue;
      CLocalUserTable.ms_pInstance?.Remove(user);
      user.DeferFlushModifiedInfo(db!, 1);
      if ((CMainSystem.ms_pInstance!.m_fInventoryDB & 1) !== 0) {
        for (const inv of user.m_vtInventory) {
          if (inv.fModified === 0) continue;
          inv.fModified = 0;
          db!.prUpdateInventoryAmount(user.dyn.strID, inv.ItemSN, inv.Amount);
        }
      }
      if (user.m_nGlobalSerialNo !== 0) CCenterProcess.ms_pInstance?.UnregisterConnection(user.m_nGlobalSerialNo);
      user.m_pSocket = null;
    }
    this.m_apUser = [];
    this.m_nUserCount = 0;
    this.m_pendingPackets = [];
    CClientSocket.ms_tblSN2Obj.delete(this.m_nLocalSerialNo);
    super.OnClose();
  }

  /** CClientSocket::GetInfoStr — native report tag. */
  GetInfoStr(): string {
    const count = this.GetUserCount();
    let text = `${this.bunSocket?.remoteAddress ?? ""}:${count}P`;
    for (let i = 0; i < count; i++) {
      text += (i === 0 ? ":" : ",") + (this.GetUser(i)?.GetName() ?? "NULL");
    }
    return text;
  }

}
