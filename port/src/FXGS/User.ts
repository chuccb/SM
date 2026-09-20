/** CUser — one player (the dynamic-info unit, the inventory, the guild
 *  serial) — and CClientSocket, its packet socket. */

import { Encode1, Encode2, Encode4, EncodeBuffer } from "../core/BufferManipulator.ts";
import { CPacketSocket } from "../core/CPacketSocket.ts";
import { CSendPacket, enSocket, type enSocket as EnSocket } from "../core/Packet.ts";
import { CDBMan, type _USERDYNINFO } from "../db/DBMan.ts";
import { CLIENTSOCKET_HEADER_CODE_MODIFIER, CLIENTSOCKET_HEADER_CODE_RCV, CLIENTSOCKET_HEADER_CODE_SND, CLIENTSOCKET_SEQ, CLIENTSOCKET_SEQ_DELTA } from "../lib/PacketIDs.ts";
import { CDynInfoCalculator_GetLevel, kLevelTableSize } from "../lib/LevelTable.ts";
import { timeGetTime } from "../core/timeGetTime.ts";
import { CChannelPool } from "./Chat";
import { CHANNEL_TYPE_GUILD, DYN_FLUSH_BURST, SESSION_IDX_NONE, USER_MONEY_MAX } from "./Defs";
import { CConnectPool } from "./Pools";
import { CUserItemMan, GetVariantTime, PreInventory, UserInventory, _USERACCOUNT } from "./CUserItemMan";
import { CGameSessionTable } from "./SessionTable";
import { CCenterProcess, CMainSystem } from "./System";
import { CGuildTable, CLocalUserTable } from "./Tables";

// ============================ CUser ============================

/** CUser — one logged-in player (0x7DC bytes in the original). */
export class CUser {
  m_strName: string;
  account: _USERACCOUNT;
  dyn: _USERDYNINFO; // +196; numeric members start at byte +208
  m_pSocket: CClientSocket | null;
  m_nFree = 0; // +20 (CSafeObject::m_nFree — 0 while the user object is live)
  m_nSlotIdx = -1; // byte +1960
  m_nGlobalSerialNo = 0; // byte +1964 (CUser::SetGlobalSerialNo)
  m_nGuildSN = 0; // byte +1972 (CUser::SetGuildSerialNo; filled from the p7 tail)
  // Descriptive TS dirty-flag names; offsets here are bytes, not DWORD indices.
  m_fDynInfoModified = 0; // +1976: money/exp/win/draw/lose, not just money
  m_fLevelModified = 0; // +1980: level changed, not every exp change
  m_nLevel = 0; // byte +1984
  m_nBonusLevel = 0; // byte +1988
  m_nPremiumSvrId = 0; // byte +1992
  m_nPremiumSvrIdx = 0; // byte +1996
  private m_nGame = 0; // +2000: unsigned IncGame/GetGame counter
  m_fPremiumTicket = 0; // +2004 byte
  private m_fClientInitialized = 0; // +2008: IsClientInitialized, independent of games
  m_vtInventory: UserInventory[] = [];
  m_apPreInventory: (PreInventory | null)[] = new Array(30).fill(null);
  m_nPreInventoryCount = 0; // +1920

  constructor(socket: CClientSocket) {
    this.m_strName = "";
    this.m_pSocket = socket;
    this.account = {
      SN: 0,
      strID: "",
      strName: "",
      Password: "",
      Email: "",
      EmailRcv: 0,
      Gender: 0,
      Address: "",
      Tel: "",
      Reveal: 0,
      Profile: "",
      TotalConn: 0,
      LastConn: "",
      Permission: 0,
      ShopCardNo: 0,
      CommunitySvr: 0,
      Birthday: "",
      GuildSn: 0,
    };
    this.dyn = { strID: "", money: 0, exp: 0, win: 0, draw: 0, lose: 0 };
  }

  GetName(): string {
    return this.m_strName;
  }

  SetName(strName: string): void {
    this.m_strName = strName;
  }

  /** CUser::SetGlobalSerialNo */
  SetGlobalSerialNo(serial: number): void {
    this.m_nGlobalSerialNo = serial >>> 0;
  }

  GetGlobalSerialNo(): number {
    return this.m_nGlobalSerialNo;
  }

  /** CUser::SetGuildSerialNo */
  SetGuildSerialNo(serial: number): void {
    this.m_nGuildSN = serial;
  }

  GetGuildSerialNo(): number {
    return this.m_nGuildSN;
  }

  /** CUser::SetSessionIdx — through the owning socket (+500). */
  SetSessionIdx(idx: number): void {
    if (this.m_pSocket) this.m_pSocket.m_nSessionIdx = idx;
  }

  /** CUser::GetSessionIdx — unsigned __int16 (FxServer.exe.c:26925; the
   *  `return -1` there is a u16 0xFFFF). */
  GetSessionIdx(): number {
    return this.m_pSocket ? this.m_pSocket.m_nSessionIdx & 0xffff : SESSION_IDX_NONE;
  }

  /** CUser::SetSessionSerialNo — through the owning socket (+504). */
  SetSessionSerialNo(serial: number): void {
    if (this.m_pSocket) this.m_pSocket.m_nSessionSerialNo = serial >>> 0;
  }

  GetSessionSerialNo(): number {
    return this.m_pSocket ? this.m_pSocket.m_nSessionSerialNo : 0;
  }

  /** CUser::SetPoolType / GetPoolType — the owning socket's stage tag (+468). */
  SetPoolType(type: number): void {
    if (this.m_pSocket) this.m_pSocket.m_nPoolType = type;
  }

  GetPoolType(): number {
    return this.m_pSocket ? this.m_pSocket.m_nPoolType : -1;
  }

  /** CUser::SetLevel — CDynInfoCalculator::GetLevel(exp). */
  SetLevel(): void {
    this.m_nLevel = CDynInfoCalculator_GetLevel(this.dyn.exp);
  }

  /** CUser::GetLookLevel — level + bonus clamped to 1..kLevelTableSize.
   *  The official compares directly against the same 450 the level table
   *  is sized by (FxServer.exe.c:26980, `if (n450 > 450) return 450;`). */
  GetLookLevel(): number {
    const n = (this.m_nLevel + this.m_nBonusLevel) | 0;
    if (n < 1) return 1;
    if (n > kLevelTableSize) return kLevelTableSize;
    return n;
  }

  /** IncWin/Draw/Lose (0041D1C1..0041D219) mutate the SAME _USERDYNINFO
   *  read by detail packets and WriteUserDynInfo; no parallel counters. */
  IncWin(): void {
    this.dyn.win = (this.dyn.win + 1) | 0;
    this.m_fDynInfoModified = 1;
  }
  IncDraw(): void {
    this.dyn.draw = (this.dyn.draw + 1) | 0;
    this.m_fDynInfoModified = 1;
  }
  IncLose(): void {
    this.dyn.lose = (this.dyn.lose + 1) | 0;
    this.m_fDynInfoModified = 1;
  }

  /** CUser::IncGame (41D245) — bumps the dyn burst counter (+2000). */
  IncGame(): void {
    this.m_nGame = (this.m_nGame + 1) >>> 0;
  }

  /** CUser::GetGame (0041691C) — unsigned games since the last flush. */
  GetGame(): number {
    return this.m_nGame;
  }

  /** CUser::IsClientInitialized / SetClientInitialized (00408155/0040815C). */
  IsClientInitialized(): number {
    return this.m_fClientInitialized;
  }
  SetClientInitialized(initialized: number): void {
    this.m_fClientInitialized = initialized | 0;
  }

  /** CUser::GetSelfidx (FxServer.exe.c:26610) — this user's index inside its socket. */
  GetSelfidx(): number {
    const socket = this.m_pSocket;
    if (!socket) return -1;
    for (let i = 0; i < socket.GetUserCount(); i++) if (socket.GetUser(i) === this) return i;
    return -1;
  }

  /** CUser::IncDecMoney — native signed add first, then clamp. */
  IncDecMoney(value: number): void {
    const money = (this.dyn.money + value) | 0;
    this.dyn.money = Math.max(0, Math.min(USER_MONEY_MAX, money));
    this.m_fDynInfoModified = 1;
  }

  /** CUser::IncDecExp — returns +1 levelup / -1 leveldown / 0. */
  IncDecExp(value: number): number {
    const old = this.m_nLevel;
    this.dyn.exp = Math.max(0, (this.dyn.exp + value) | 0);
    this.m_fDynInfoModified = 1;
    this.SetLevel();
    if (this.m_nLevel !== old) {
      this.m_fLevelModified = 1;
      return this.m_nLevel > old ? 1 : -1;
    }
    return 0;
  }

  /** CUser::DeferFlushModifiedInfo (00417603) — snapshot/reset under the
   *  native lock, then write outside it. JS execution here is synchronous.
   *  The original clears dirty state even when WriteUserDynInfo fails. */
  DeferFlushModifiedInfo(db: CDBMan, fForce: number): void {
    if (fForce === 0 && this.GetGame() < DYN_FLUSH_BURST) return;
    const info = this.m_fDynInfoModified !== 0 ? { ...this.dyn } : null;
    this.m_nGame = 0;
    this.m_fDynInfoModified = 0;
    this.m_fLevelModified = 0;
    if (info) db.WriteUserDynInfo(info);
  }

  /** CUser::AddInventory */
  AddInventory(inv: UserInventory): void {
    this.m_vtInventory.push(inv);
  }

  /** CUser::GetUserInventory */
  GetUserInventory(ItemSN: number): UserInventory | null {
    return this.m_vtInventory.find((i) => i.ItemSN === ItemSN) ?? null;
  }

  /** CUser::GetUserInventoryFromAll — by item id string. */
  GetUserInventoryFromAll(name: string): UserInventory | null {
    return this.m_vtInventory.find((i) => i.strName === name) ?? null;
  }

  /** CUser::HasFunctionalItem (category 2). */
  HasFunctionalItem(name: string): boolean {
    return this.m_vtInventory.some((i) => i.Type === 2 && i.strName === name);
  }

  /** CUser::GetInventoryLoaded — equipped (SlotByte != 0xFF) of a category. */
  GetInventoryLoaded(n: number): UserInventory | null {
    return this.m_vtInventory.find((i) => i.Type === n && i.SlotByte !== 0xff) ?? null;
  }

  /** CUser::GetSlotDecorationLoaded (category 10). */
  GetSlotDecorationLoaded(i: number): UserInventory | null {
    return this.m_vtInventory.find((x) => x.Type === 10 && x.Slot === i && x.SlotByte !== 0xff) ?? null;
  }

  /** CUser::GetCharDecoLoaded (category 12). */
  GetCharDecoLoaded(i: number): UserInventory | null {
    return this.m_vtInventory.find((x) => x.Type === 12 && x.Slot === i && x.SlotByte !== 0xff) ?? null;
  }

  /** CUser::AppendSimpleInfoPacket — the shared rank/guild/list entry. */
  AppendSimpleInfoPacket(packet: CSendPacket): void {
    packet.EncodeStr(this.m_strName);
    packet.Encode1(this.account.Gender);
    // CUser::AppendSimpleInfoPacket (FxServer.exe.c:27122) — the look level
    // rides through vtbl+24 = Encode2 (CSendPacketBase vtable 0x492198:
    // +20 E1 / +24 E2 / +28 E4 / +32 EStr), NOT Encode4.
    packet.Encode2(this.GetLookLevel());
    if (this.m_nPremiumSvrId !== 0) packet.Encode4(this.m_nPremiumSvrIdx);
    else packet.Encode4(0);
    packet.Encode4(this.m_nGuildSN);
    if (CMainSystem.ms_pInstance!.m_nChannelType === CHANNEL_TYPE_GUILD) {
      const guild = CGuildTable.ms_pInstance?.FindGuildFromSerialNo(this.m_nGuildSN);
      if (guild) {
        packet.Encode2(guild.m_nMarkRevision);
        return;
      }
    }
    packet.Encode2(0);
  }

  /** CUser::MakeUserInventoryPacket — packet 201 per-user body. */
  MakeUserInventoryPacket(packet: CSendPacket): void {
    packet.Encode2(this.m_vtInventory.length);
    for (const inv of this.m_vtInventory) {
      packet.Encode4(inv.ItemSN);
      packet.Encode1(inv.SlotByte);
      packet.Encode4(inv.Amount);
      packet.EncodeStr(inv.Verbose);
      // CTime::GetVariantTime — an 8-byte OLE date
      packet.EncodeBuffer(new Uint8Array(new Float64Array([GetVariantTime(inv.DateCreated)]).buffer));
    }
  }

  /** CUser::MakePreInventoryPacket — packet 207 per-user body. */
  MakePreInventoryPacket(packet: CSendPacket): void {
    packet.Encode1(this.m_nPreInventoryCount);
    for (const pre of this.m_apPreInventory) {
      if (!pre) continue;
      const item = CUserItemMan.ms_pInstance?.GetUserItem(pre.ItemSn);
      if (!item) continue;
      packet.Encode1(item.Type);
      packet.Encode4(pre.ItemSn);
      packet.Encode2(Math.min(pre.Amount, 0xffff));
      packet.Encode2(item.Type === 101 ? this.m_nLevel & 0xffff : 0);
      packet.Encode2(Math.min(pre.ValidityPeriod, 100000) & 0xffff);
      packet.EncodeStr(pre.Description);
      packet.EncodeStr(pre.strAttr);
    }
  }

  /** CUser::MakeInventoryPacket — the E2 ItemSNs of a category. */
  MakeInventoryPacket(packet: CSendPacket, n: number): void {
    const list = this.m_vtInventory.filter((i) => i.Type === n);
    packet.Encode2(list.length);
    for (const inv of list) packet.Encode2(inv.ItemSN);
  }
}

// ============================ CClientSocket ============================

/** CClientSocket — one connected game client (FxServer.exe.c:9818). */
export class CClientSocket extends CPacketSocket {
  /** CClientSocket::OnReceiveCompletionPacket guards the client links only
   *  (FxServer.exe.c:9673). */
  m_fReceiveFloodGuard = true;

  protected ReportReceiveOverflow(): void {
    console.error(`Socket receive buffer overflow(${this.bunSocket?.remoteAddress ?? ""}), disconnected.`);
  }

  protected ReportSendOverflow(): void {
    console.error(`Socket send buffer overflow, close connection: (${this.bunSocket?.remoteAddress ?? ""})`);
  }

  /** CClientSocket::PutPacket's wrapper switch (FxServer.exe.c:9526). */
  protected ReportPutError(err: EnSocket): void {
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
  protected ReportSequencingErrorLine(addr: string): void {
    console.error(
      `Error in client packet sequencing(m_nHeaderType, m_nPacketSeq = ${this.m_nHeaderType}, ${this.m_nPacketSndSeq}), close connection: [${addr}]`,
    );
  }
  static ms_nHeaderTypeCounter = 0; // dword_4AF338
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
  m_dwIdleTime = timeGetTime() - 5000;
  /** The CBaseSession::PutPacket queue (this+56); FlushPacket drains it. */
  m_pendingPackets: CSendPacket[] = [];

  constructor() {
    super(CPacketSocket.dwRcvBufferSize, CPacketSocket.dwSndBufferSize, {
      onPacket: (_sock, packet) => CMainSystem.ms_pInstance?.DispatchClient(packet, this),
    });
    this.m_szLogTag = "GS";
    this.m_fClientLink = true;
    this.m_nLocalSerialNo = CClientSocket.ms_tblSN2Obj.size + 1;
    const nHeaderType = CClientSocket.ms_nHeaderTypeCounter % 16;
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
  static HasAuthority(_a1: number): number {
    return 0;
  }

  /** CClientSocket::GetMaxLevelUserIdx (FxServer.exe.c:8871) — the roster
   *  index of the highest-level user (the raw +1984 level field). */
  static GetMaxLevelUserIdx(socket: CClientSocket): number {
    let best = 0;
    let max = 0;
    for (let i = 0; i < socket.GetUserCount(); i++) {
      const level = socket.GetUser(i)!.m_nLevel;
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
  protected OnClose(): void {
    const db = CCenterProcess.ms_pInstance?.db ?? null;
    // CGameSessionTable::DestroyPlayer when seated
    CGameSessionTable.ms_pInstance?.DestroyPlayer(this, 0);
    // pool removal (connect pool before entry, channel pool afterwards)
    const pool = this.m_nPoolType === 0 ? CConnectPool.ms_pInstance : CChannelPool.ms_pInstance;
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
}

/** CClientSocket::GetInfoStr (FxServer.exe.c:10083) — the report tag of the
 *  original: "addr:%dP" with the seated user count, then each seat's name —
 *  ":" before the first and "," between, "NULL" for an empty seat. */
export function GetInfoStr(socket: CClientSocket): string {
  const count = socket.GetUserCount();
  let str = `${socket.bunSocket?.remoteAddress ?? ""}:${count}P`;
  for (let i = 0; i < count; i++) {
    str += (i === 0 ? ":" : ",") + (socket.GetUser(i)?.GetName() ?? "NULL");
  }
  return str;
}
