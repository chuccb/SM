/** Native source unit: FX/FxServer/GameSessionTable.cpp.
 * CGameSessionTable — the two 255-slot table halves (rooms and practice)
 *  and the create/join/UDP dispatch. */

import { CReceivedPacket, CSendPacket, CipherDegree, PACKET_TYPE_PLACEHOLDER } from "../core/Packet.ts";
import type { HOSTHANDLE } from "../shared/MTUDP.ts";
import { S2C_GamePacket, C2S_GameSessionPacket } from "../protocol/PacketIDs.ts";
import { timeGetTime } from "../core/timeGetTime.ts";
import { CUserPool } from "./UserPool.ts";
import { CreateChannelSocketList, SendChannelPacket } from "./ClientSocketRuntime.ts";
import {
  SESSION_IDX_CONNECTING,
  SESSION_IDX_MAX,
  SESSION_IDX_NONE,
  SESSION_SERIAL_NONE,
} from "./Defs.ts";
import { CBomberAttr } from "./BomberAttr.ts";
import { CPracticeSession } from "./PracticeSession.ts";
import { CGameSession } from "./GameSession.ts";
import { CBaseSession } from "./BaseSession.ts";
import { CBaseSessionTable } from "./BaseSessionTable.ts";
import { RegisterSessionRuntimeTable } from "./SessionTableRuntime.ts";
import type { CClientSocket } from "./ClientSocket.ts";
import type { CUser } from "./User.ts";

// ============================ CGameSessionTable ============================

/** CGameSessionTable — the 255 game-room slots (8 lock groups in the original). */
export class CGameSessionTable extends CBaseSessionTable {
  private static m_pInstance: CGameSessionTable | null = null;

  static get ms_pInstance(): CGameSessionTable | null {
    return CGameSessionTable.m_pInstance;
  }

  static set ms_pInstance(table: CGameSessionTable | null) {
    CGameSessionTable.m_pInstance = table;
    RegisterSessionRuntimeTable(table);
  }

  m_apGameSession: CGameSession[] = []; // +8 (255 preallocated rooms)
  /** +1320 — the 255 preallocated practice rooms (the second table half). */
  m_apPracticeSession: CPracticeSession[] = [];
  /** +1024 — the per-room flush flags (1 = created, 4 = destroyed).  The
   *  practice rooms never touch these: they never appear in the lobby
   *  lists, so there is nothing to announce. */
  m_acTableFlags = new Uint8Array(SESSION_IDX_MAX);
  /** CGameSessionTable's timer-refreshed free-room cache. The shipped binary
   * builds it but has no reader; keeping it private preserves that boundary. */
  private m_vtCachedGameServer: {
    index: number;
    session: CGameSession;
    emptySlotCount: number;
    chiefLevel: number;
    priority: number;
  }[] = [];

  constructor() {
    super();
    for (let i = 0; i < SESSION_IDX_MAX; i++) this.m_apGameSession.push(new CGameSession());
    for (let i = 0; i < SESSION_IDX_MAX; i++) this.m_apPracticeSession.push(new CPracticeSession());
    CGameSessionTable.ms_pInstance = this;
  }

  /** CGameSessionTable::PutAllSessionInfo — packet 83 per valid room. */
  PutAllSessionInfo(socket: CClientSocket): void {
    const packet = new CSendPacket(S2C_GamePacket.OnSessionSimpleInfo, CipherDegree.kPacketEncryptedCRC8);
    for (const session of this.m_apGameSession) {
      if (!session || session.fValid === 0) continue;
      session.MakeSimpleInfoPacket(packet);
      socket.SendPacket(packet);
      packet.InitPacket(S2C_GamePacket.OnSessionSimpleInfo);
    }
  }

  /**
   * CGameSessionTable::SendPacket (FxServer.exe.c:37954) — the CBaseSessionTable
   * vtbl+4 primitive: lock the slot's lock group, then send to the room's
   * members when the room is live and the serial matches the room's.
   */
  SendPacket(idx: number, serial: number, packet: CSendPacket): void {
    const session = this.m_apGameSession[idx];
    if (!session || session.fValid === 0 || session.m_nSerialNo !== serial) return;
    for (const user of session.m_rgPlayer) {
      if (user && user.GetSessionSerialNo() === serial) user.m_pSocket?.SendPacket(packet);
    }
  }

  /**
   * CGameSessionTable::SendPacketIntoPracticeSession (FxServer.exe.c:38207) —
   * the same primitive over the second table half (+1320, the practice rooms)
   * behind CPracticeSession::LockPracticeSessions.
   */
  SendPacketIntoPracticeSession(idx: number, serial: number, packet: CSendPacket): void {
    const session = this.m_apPracticeSession[idx];
    if (!session || session.fValid === 0 || session.m_nSerialNo !== serial) return;
    for (const user of session.m_rgPlayer) {
      if (user && user.GetSessionSerialNo() === serial) user.m_pSocket?.SendPacket(packet);
    }
  }

  /**
   * CGameSessionTable::SendPacketIntoSession (FxServer.exe.c:38441) over
   * CBaseSessionTable::SendPacketIntoSession (FxServer.exe.c:31355) — resolve
   * the socket's room slot and send to that room's members.  A practice-stage
   * socket (+468 == 6) routes into the practice table half; both the
   * null-socket and the (WORD)-1-slot shapes report the original errors.
   */
  override SendPacketIntoSession(socket: CClientSocket | null, packet: CSendPacket): void {
    if (socket === null) {
      console.error("[GS] !pSocket, CBaseSessionTable::SendPacketIntoSession");
      return;
    }
    const idx = socket.GetUser(0)!.GetSessionIdx();
    if (socket.m_nPoolType === 6) {
      if (idx === SESSION_IDX_NONE) {
        console.error("[GS] wSessionIdx == (WORD)-1, CGameSessionTable::SendPacketIntoSession");
        return;
      }
      this.SendPacketIntoPracticeSession(idx, socket.GetUser(0)!.GetSessionSerialNo(), packet);
    } else {
      if (idx === SESSION_IDX_NONE) {
        console.error("[GS] wSessionIdx == (WORD)-1, CBaseSessionTable::SendPacketIntoSession");
        return;
      }
      this.SendPacket(idx, socket.GetUser(0)!.GetSessionSerialNo(), packet);
    }
  }

  /**
   * CGameSessionTable::OnRequestSessionInfoDetail (vtbl+88, FxServer.exe.c
   * :421DA2) — the room-detail gate: the 84 [E1 0] failure unless idx and
   * serial hit a live room, whose OnRequestSessionInfoDetail answers.
   */
  OnRequestSessionInfoDetail(idx: number, serial: number, socket: CClientSocket): void {
    if (idx >= SESSION_IDX_MAX) {
      console.error("[GS] Invalid game session slot index (OnRequestSessionInfoDetail)");
      socket.PostClosePacket();
      return;
    }
    CBaseSession.LockBaseSessions(idx);
    const session = this.m_apGameSession[idx];
    if (session && session.fValid !== 0 && session.m_nSerialNo === serial) {
      session.OnRequestSessionInfoDetail(socket);
    } else {
      const packet = new CSendPacket(S2C_GamePacket.OnSessionInfoDetailRes, CipherDegree.kPacketEncryptedCRC8);
      packet.Encode1(0);
      socket.SendPacket(packet);
    }
    CBaseSession.UnlockBaseSessions(idx);
  }

  /** CGameSessionTable::OnPacket — lock, validate, then the room dispatch. */
  OnPacket(n: CReceivedPacket, socket: CClientSocket): void {
    const idx = socket.m_nSessionIdx;
    if (idx >= SESSION_IDX_MAX) {
      if (socket.m_nPoolType !== 4 && n.m_pBlock[n.m_uOffset] !== C2S_GameSessionPacket.OnHostAskBanPlayer) {
        if (idx === SESSION_IDX_NONE) console.log("[GS] Lobby player sent session packet (OnPacket). Don't Disconnect.");
        else if (idx === SESSION_IDX_CONNECTING) console.error("[GS] Connecting player sent session packet (OnPacket). Don't Disconnect.");
        else console.error("[GS] Invalid game session slot index (OnPacket). Don't Disconnect.");
        console.log(`[GS]     Time:${timeGetTime()}`); // Report("    Time:%d", timeGetTime())
      }
      return;
    }
    if (socket.m_nPoolType === 6) {
      const practice = this.m_apPracticeSession[idx]!;
      if (practice.fValid !== 0 && practice.m_nSerialNo === socket.m_nSessionSerialNo) {
        n.m_uOffset = 0;
        practice.OnPacket(n, socket);
      } else {
        console.error(`[GS] Illegal Practice session (${idx}). Disconnect [${socket.GetInfoStr()}].`);
        socket.PostClosePacket();
      }
      return;
    }
    CBaseSession.LockBaseSessions(idx);
    const session = this.m_apGameSession[idx];
    if (session && session.fValid !== 0 && session.m_nSerialNo === socket.m_nSessionSerialNo) {
      n.m_uOffset = 0;
      session.OnPacket(n, socket);
    } else if (socket.m_nPoolType !== 4) {
      console.error(`[GS] Illegal game session (${idx}). Disconnect [${socket.GetInfoStr()}].`);
      socket.PostClosePacket();
    }
    CBaseSession.UnlockBaseSessions(idx);
  }

  /** CGameSessionTable::DestroyPlayer — vtbl+48, on socket close/leave. */
  DestroyPlayer(socket: CClientSocket, fSendReset: number): void {
    if (!socket) return;
    if (!socket.GetUser(0)) return;
    const idx = socket.m_nSessionIdx;
    const serial = socket.m_nSessionSerialNo;
    if (idx >= SESSION_IDX_MAX) return;
    if (socket.m_nPoolType === 6) {
      // the practice branch resets the socket's own bookkeeping (the game
      // branch resets each user's) and closes the room without the lobby
      // flags — practice rooms never announce themselves
      socket.m_nSessionIdx = SESSION_IDX_NONE;
      socket.m_nSessionSerialNo = SESSION_SERIAL_NONE;
      const practice = this.m_apPracticeSession[idx]!;
      if (practice.fValid !== 0 && practice.m_nSerialNo === serial && practice.DestroyPlayer(socket, fSendReset) !== 0 && practice.m_nCurPlayerNum === 0) {
        practice.fValid = 0; // CBaseSession::Destroy
      }
      return;
    }
    CBaseSession.LockBaseSessions(idx);
    for (let i = 0; i < socket.GetUserCount(); i++) {
      const user = socket.GetUser(i);
      if (user) {
        user.SetSessionIdx(SESSION_IDX_NONE);
        user.SetSessionSerialNo(SESSION_SERIAL_NONE);
      }
    }
    const session = this.m_apGameSession[idx]!;
    if (session && session.fValid !== 0 && session.m_nSerialNo === serial && session.DestroyPlayer(socket, fSendReset) !== 0 && session.m_nCurPlayerNum === 0 && this.CloseSession(idx, serial) !== 0) {
      if ((this.m_acTableFlags[idx]! & 1) !== 0) this.m_acTableFlags[idx] = 0;
      else this.m_acTableFlags[idx]! |= 4;
    }
    CBaseSession.UnlockBaseSessions(idx);
  }

  /** CGameSessionTable::CloseSession — fValid = 0 behind the serial check. */
  CloseSession(idx: number, serial: number): number {
    if (idx >= SESSION_IDX_MAX) {
      console.error("[GS] Invalid game session slot index (CloseSession)");
      return 0;
    }
    let ok = 1;
    CBaseSession.LockBaseSessions(idx);
    const session = this.m_apGameSession[idx]!;
    if (session && session.fValid !== 0 && session.m_nSerialNo === serial) {
      if (session.m_nCurPlayerNum !== 0) console.error("[GS] Game session closed although some players are not destroyed");
      session.fValid = 0; // CBaseSession::Destroy
    } else {
      ok = 0;
    }
    CBaseSession.UnlockBaseSessions(idx);
    return ok;
  }

  /** CGameSessionTable::KickImp — "Fatal Revenge". */
  KickImp(socket: CClientSocket): number {
    if (socket.m_fImpPoint === 0) return 0;
    console.error(`[GS] Fatal Revenge: Kick imp's ass [${socket.GetUser(0)?.GetName() ?? "NULL"}] !`);
    const p = new CSendPacket(S2C_GamePacket.OnKickoffUser, CipherDegree.kPacketEncryptedCRC8);
    p.EncodeStr("abnormal state, disconnect user.");
    socket.ForceSendAndClose(p);
    return 1;
  }

  /** Decode the inlined rgnBomber loop shared by native create/join paths:
   *  every wire byte is reduced modulo (CBomberAttr::GetTotalCount() + 1),
   *  where the extra value is the random-bomber sentinel. */
  private DecodeBomberSelections(n: CReceivedPacket, count: number): number[] {
    const modulo = CBomberAttr.ms_pInstance!.GetTotalCount() + 1;
    const selects = new Array<number>(count);
    for (let i = 0; i < count; i++) selects[i] = n.Decode1() % modulo;
    return selects;
  }

  /** CGameSessionTable::CreateSession — packet 80 body. */
  CreateSession(n: CReceivedPacket, socket: CClientSocket): void {
    const title = n.DecodeStr();
    const password = n.DecodeStr();
    const gameType = n.Decode1();
    const count = n.Decode1();
    if (count !== socket.GetUserCount()) {
      console.error("[GS] CChannelPool::OnRequestCreateSession, player count not matched!");
      socket.PostClosePacket();
      return;
    }
    this.DoCreateSession(socket, title, password, this.DecodeBomberSelections(n, count), gameType);
  }

  /** CGameSessionTable::CreateSessionGuild (vtbl+56, 004230F5) — packet 84:
   * [EStr password][E1 gameType][E1 count][count × E1 select].  The native
   * room title is the CP949 byte string 길드방 ("guild room"), while the one
   * client string is passed as the password. */
  CreateSessionGuild(n: CReceivedPacket, socket: CClientSocket): void {
    const password = n.DecodeStr();
    const gameType = n.Decode1();
    const count = n.Decode1();
    if (count !== socket.GetUserCount()) {
      console.error("[GS] ChannelPool::OnRequestCreateSession, player count not matched!");
      socket.PostClosePacket();
      return;
    }
    // Keep the original CP949 bytes in the latin1 string domain used by EStr.
    const guildRoomTitle = "\xb1\xe6\xb5\xe5\xb9\xe6";
    this.DoCreateSession(socket, guildRoomTitle, password, this.DecodeBomberSelections(n, count), gameType);
  }

  /** CGameSessionTable::DoCreateSession (FxServer.exe.c:38917). */
  DoCreateSession(socket: CClientSocket, title: string, password: string, selects: number[], gameType: number): void {
    if (this.KickImp(socket) !== 0) return;
    const res = new CSendPacket(S2C_GamePacket.OnCreateSessionRes, CipherDegree.kPacketEncryptedCRC8);
    const na = socket.GetUserCount();
    if (na <= 0) return;
    for (let i = 0; i < na; i++) {
      const user = socket.GetUser(i)!;
      if (user.GetSessionIdx() !== SESSION_IDX_NONE) {
        console.error(`[GS] User joined a session already request for creating session. Disconnect[${user.GetName()}]`);
        socket.PostClosePacket();
        res.Encode1(3);
        socket.SendPacket(res);
        return;
      }
    }
    let nb = 0;
    while (nb < SESSION_IDX_MAX && this.m_apGameSession[nb] && this.m_apGameSession[nb]!.fValid !== 0) nb++;
    if (nb >= SESSION_IDX_MAX) {
      res.Encode1(2);
      socket.SendPacket(res);
      return;
    }
    CBaseSession.LockBaseSessions(-1);
    const session = this.m_apGameSession[nb]!;
    session.Create(socket, title, password, selects, gameType);
    this.m_acTableFlags[nb]! |= 1;
    res.Encode1(0);
    res.Encode2(nb);
    res.Encode4(session.m_nSerialNo);
    res.Encode1(gameType);
    socket.SendPacket(res);
    // vtbl+80 — the creator sees the room (their own 105s + the 112 tail)
    session.SendSessionInfoPacket(socket);
    CBaseSession.UnlockBaseSessions(nb);
    CBaseSession.UnlockBaseSessions(-1);
  }

  /** CGameSessionTable::CreateSessionPractice (vtbl+60, 004231C5)
   *  — packet 86: [E1 count][count × E1 select].  The selects decode with the
   *  usual % (CBomberAttr total + 1) clamp and only feed the bomber
   *  preference; a count that disagrees with the socket's roster
   *  disconnects before the select bytes are consumed and without a reply. */
  CreateSessionPractice(n: CReceivedPacket, socket: CClientSocket): void {
    const count = n.Decode1();
    if (count !== socket.GetUserCount()) {
      console.error("[GS] ChannelPool::OnRequestCreatePraticeSession, player count not matched!");
      socket.PostClosePacket();
      return;
    }
    this.DoCreatePracticeSession(socket, this.DecodeBomberSelections(n, count));
  }

  /** CGameSessionTable::DoCreatePracticeSession (FxServer.exe.c:39300) —
   *  the 89 replies: [E1 0][E2 idx][E4 serial] on success, [E1 2] when all
   *  255 practice slots are live, [E1 3] + disconnect when a roster user is
   *  already seated somewhere. */
  DoCreatePracticeSession(socket: CClientSocket, selects: number[]): void {
    if (this.KickImp(socket) !== 0) return;
    const res = new CSendPacket(S2C_GamePacket.OnPracticeSessionCreated, CipherDegree.kPacketEncryptedCRC8);
    const na = socket.GetUserCount();
    if (na > 0) {
      for (let i = 0; i < na; i++) {
        const user = socket.GetUser(i)!;
        if (user.GetSessionIdx() !== SESSION_IDX_NONE) {
          console.error(`[GS] User joined a session already request for creating practicesession. Disconnect[${user.GetName()}]`);
          res.Encode1(3);
          socket.SendPacket(res);
          socket.PostClosePacket();
          return;
        }
      }
    }
    let nb = 0;
    while (nb < SESSION_IDX_MAX && this.m_apPracticeSession[nb]!.fValid !== 0) nb++;
    if (nb >= SESSION_IDX_MAX) {
      res.Encode1(2);
      socket.SendPacket(res);
      return;
    }
    // CPracticeSession::LockPracticeSessions(idx % 8) — the 8 lock groups
    const session = this.m_apPracticeSession[nb]!;
    session.CreatePractice(socket, selects);
    res.Encode1(0);
    res.Encode2(nb);
    res.Encode4(session.m_nSerialNo);
    socket.SendPacket(res);
    // vtbl+80 — the owner sees the room (105s + the AI-tailed 107s)
    session.SendSessionInfoPacket(socket);
  }

  /** CGameSessionTable::JoinSession — packet 81 body. */
  JoinSession(n: CReceivedPacket, socket: CClientSocket): void {
    const idx = n.Decode2();
    const serial = n.Decode4();
    const password = n.DecodeStr();
    const count = n.Decode1();
    if (count !== socket.GetUserCount()) {
      console.error("[GS] CChannelPool::OnRequestJoinSession, player count not matched!");
      socket.PostClosePacket();
      return;
    }
    this.DoJoinSession(socket, idx, serial, password, this.DecodeBomberSelections(n, count));
  }

  /** CGameSessionTable::DoJoinSession (FxServer.exe.c:39015). */
  DoJoinSession(socket: CClientSocket, idx: number, serial: number, password: string, selects: number[]): void {
    if (this.KickImp(socket) !== 0) return;
    const na = socket.GetUserCount();
    const res = new CSendPacket(S2C_GamePacket.OnJoinSessionRes, CipherDegree.kPacketEncryptedCRC8);
    if (idx >= SESSION_IDX_MAX) {
      console.error("[GS] Invalid game session slot index (DoJoinSession)");
      return;
    }
    CBaseSession.LockBaseSessions(idx);
    const session = this.m_apGameSession[idx]!;
    if (session && session.fValid !== 0 && session.m_fSupreme === 0 && session.m_nSerialNo === serial) {
      let seated = false;
      for (let i = 0; i < na; i++) {
        if (socket.GetUser(i)!.GetSessionIdx() !== SESSION_IDX_NONE) {
          seated = true;
          break;
        }
      }
      if (!seated) {
        if (socket.HasAuthority(1) === 0 && session.m_szPassword.length > 0 && session.m_szPassword !== password) {
          res.Encode1(1);
          socket.SendPacket(res);
          CBaseSession.UnlockBaseSessions(idx);
          return;
        }
        if (session.AddPlayer(socket, selects) !== 0) {
          res.Encode1(0);
          socket.SendPacket(res);
          session.SendSessionInfoPacket(socket); // vtbl+80
          session.SendJoinPacket(socket); // vtbl+84
          session.SendGameType(socket);
          CBaseSession.UnlockBaseSessions(idx);
          return;
        }
      }
    }
    res.Encode1(2);
    socket.SendPacket(res);
    CBaseSession.UnlockBaseSessions(idx);
  }

  /**
   * CGameSessionTable::JoinFreeSession (42331B) — packet 82, the auto-join.
   * DoJoinFreeSession (422A05) picks its candidate from the session list at
   * +1316, which nothing in FXGS ever inserts into (only ctor/dtor/this read
   * touch +524h), so the reply is always the [E1 2] failure; the decoded
   * selects (each % (CBomberAttr total + 1)) are discarded.
   */
  JoinFreeSession(n: CReceivedPacket, socket: CClientSocket): void {
    const count = n.Decode1();
    if (count !== socket.GetUserCount()) {
      console.error("[GS] CCChannelPool::OnRequestAutoJoinSession, player count not matched!");
      socket.PostClosePacket();
      return;
    }
    const mod = (CBomberAttr.ms_pInstance?.m_nTotalCount ?? 0) + 1;
    for (let i = 0; i < count; i++) void (n.Decode1() % mod);
    if (this.KickImp(socket) !== 0) return; // the revenge kick already destroyed the socket
    for (let i = 0; i < socket.GetUserCount(); i++) {
      // every user must still be outside a session (GetSessionIdx == 0xFFFF)
      if (socket.GetUser(i)!.GetSessionIdx() !== SESSION_IDX_NONE) return;
    }
    const res = new CSendPacket(S2C_GamePacket.OnJoinFreeSessionRes, CipherDegree.kPacketEncryptedCRC8);
    res.Encode1(2);
    socket.SendPacket(res);
  }

  /**
   * CGameSessionTable::OnUDPPeerInfo (421EE5) — the type-11 MTUDP check.
   * The serial argument is the session's +148 serial.
   */
  override OnUDPPeerInfo(
    idx: number,
    serial: number,
    user: CUser,
    host: HOSTHANDLE,
    hosts: number[],
    ports: number[],
  ): void {
    if (idx >= SESSION_IDX_MAX) {
      console.error("[GS] Invalid game session slot index (OnUDPPeerInfo)");
      user.m_pSocket?.PostClosePacket();
      return;
    }
    const session = this.m_apGameSession[idx];
    if (session && session.fValid !== 0 && session.m_nSerialNo === serial) {
      session.OnUDPPeerInfo(user, host, hosts, ports);
    }
  }

  /**
   * CGameSessionTable::OnReadyForImmediateStart (421E72) — the type-1 MTUDP
   * check.  The session re-reads the map CRC and the per-user attributes from
   * the packet body at the offset the dispatcher left it at.
   */
  OnReadyForImmediateStart(
    idx: number,
    serial: number,
    user: CUser,
    body: CReceivedPacket,
  ): void {
    if (idx >= SESSION_IDX_MAX) {
      console.error("[GS] Invalid game session slot index (OnReadyForImmediateStart)");
      user.m_pSocket?.PostClosePacket();
      return;
    }
    const session = this.m_apGameSession[idx];
    if (session && session.fValid !== 0 && session.m_nSerialNo === serial) {
      session.OnReadyForImmediateStart(body, user.m_pSocket!);
    }
  }

  /** CBaseSessionTable vtbl+12 ClearModifiedFlag (420CC0) — flags[idx] = 0. */
  ClearModifiedFlag(n: number): void {
    this.m_acTableFlags[n] = 0;
  }

  /** CGameSessionTable::FlushModifiedInfo (FxServer.exe.c:38719) — the 86
   *  sweep: build the lobby broadcast list once, then every session whose
   *  modified flag ships its packet through CUserPool::SendAll. */
  FlushModifiedInfo(): void {
    const list = CreateChannelSocketList(1);
    if (!list) return;
    for (const session of this.m_apGameSession) {
      if (!session || session.fValid === 0) continue;
      const packet = new CSendPacket(PACKET_TYPE_PLACEHOLDER, CipherDegree.kPacketEncryptedCRC8);
      if (session.MakeModifiedPacket(packet) !== 0) {
        CUserPool.SendAll(packet, list);
      }
    }
  }

  /** CGameSessionTable::CacheGameServerList (00422EC5). */
  CacheGameServerList(): void {
    const now = timeGetTime();
    const cached: typeof this.m_vtCachedGameServer = [];
    for (let index = 0; index < this.m_apGameSession.length; index++) {
      const session = this.m_apGameSession[index];
      if (!session || session.fValid === 0 || session.m_fHasPassword !== 0) continue;
      const emptySlotCount = session.GetEmptySlotCount();
      if (emptySlotCount <= 0) continue;
      const elapsedSecondsByte = (((now - session.m_dwCreateTime) >>> 0) / 1_000) & 0xff;
      cached.push({
        index,
        session,
        emptySlotCount,
        chiefLevel: session.GetChiefLevel(),
        priority: 0xff * (session.m_nGameType + 1) - elapsedSecondsByte,
      });
    }
    this.m_vtCachedGameServer = cached;
  }

  /** CGameSessionTable::UpdateGameSessions (4219A2) — the per-session tick. */
  UpdateGameSessions(): void {
    for (const session of this.m_apGameSession) {
      if (!session || session.fValid === 0) continue; // +8C gate
      session.Update();
    }
    for (const session of this.m_apPracticeSession) {
      if (session.fValid === 0) continue; // +8C gate
      session.Update();
    }
  }

  /** CGameSessionTable::FlushModifiedTableInfo — the 85/87 sweep (timer).
   *  NB: no fValid gate here (unlike FlushModifiedInfo) — a just-destroyed
   *  session (fValid = 0) must still announce its 87. (FxServer.exe.c:38335) */
  FlushModifiedTableInfo(): void {
    for (let n = 0; n < SESSION_IDX_MAX; n++) {
      const session = this.m_apGameSession[n];
      if (!session) continue;
      const flags = this.m_acTableFlags[n]!;
      if ((flags & 1) !== 0) {
        const packet = new CSendPacket(PACKET_TYPE_PLACEHOLDER, CipherDegree.kPacketEncryptedCRC8);
        session.MakeCreatedPacket(packet);
        this.m_acTableFlags[n] = 0;
        this.m_acTableFlags[n]! |= 2;
        SendChannelPacket(packet, 1);
      } else if ((flags & 4) !== 0) {
        const packet = new CSendPacket(PACKET_TYPE_PLACEHOLDER, CipherDegree.kPacketEncryptedCRC8);
        session.MakeDestroyedPacket(packet);
        this.m_acTableFlags[n] = 0;
        SendChannelPacket(packet, 1);
      }
    }
  }
}
