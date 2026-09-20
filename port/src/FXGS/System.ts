/** CMainSystem (the server's config state) and CCenterProcess (the center
 *  link). */

import { Decode1, Decode2, Decode4, Encode1, Encode2, Encode4 } from "../core/BufferManipulator.ts";
import { CRand } from "../core/CRand.ts";
import { CServerConfig } from "../core/Config.ts";
import { CReceivedPacket, CSendPacket, CipherDegree, kPacketEncryptedCRC8, kPacketRaw } from "../core/Packet.ts";
import { CDBMan } from "../db/DBMan.ts";
import { CLocalSocket } from "../lib/CenterLink.ts";
import { GS_ClientSend } from "../lib/PacketIDs.ts";
import { CENTER_VERSION, CM_ReceivedPacket, CONN_HELLO_VERSION, MC_ReceivedPacket, SVRCLASS_GAME } from "../lib/S2S.ts";
import { CDynInfoCalculator_GetLevel, CDynInfoCalculator_GetMaxExpInLevel } from "../lib/LevelTable.ts";
import { CChannelPool } from "./Chat";
import { CONN_PATCH_URL, SESSION_LOC_OTHER_SERVER } from "./Defs";
import { CConnectPool } from "./Pools";
import { CUserItemMan } from "./CUserItemMan";
import { CGuildTable, CLocalUserTable } from "./Tables";
import { CClientSocket, SendGameSlotInfo } from "./User";

// ============================ CMainSystem ============================

/** CMainSystem — config-derived globals + the client dispatch hook. */
export class CMainSystem {
  static ms_pInstance: CMainSystem | null = null;

  /** TS execution-context state, not an original CMainSystem field.
   * CThread::ProcEntry (00436E00) seeds each worker with time(NULL), in
   * epoch SECONDS. Bun has one logical request worker, shared by its rooms;
   * other services and the normal timer must not consume this stream.
   * Native IOCP worker scheduling is not emulated (see the RNG audit). */
  readonly m_WorkerRandom = new CRand(Math.floor(Date.now() / 1000));

  m_nGameDomain = 0; // +4
  m_nChannelType = 0; // +8 (MainSystem+8 — chByteType[ServerIndex])
  m_fInventoryDB = 0; // +27 (the entry path's InitUserInventory gate)
  m_nPremiumSvrReward = 0; // CChannelPool ctor fill
  m_nPremiumSvrLuckPro = 30000;
  m_nPremiumLv = 0; // +12 (GetMapLevelLimit's premium-channel discount)

  constructor(cfg: CServerConfig) {
    CMainSystem.ms_pInstance = this;
    this.m_nGameDomain = cfg.GetNumAttribute("GameDomain");
  }

  /** CMainSystem::IsPremiumChannel — the channel type is 41. */
  static IsPremiumChannel(): boolean {
    return CMainSystem.ms_pInstance!.m_nChannelType === 41;
  }

  /** CMainSystem::OnConnEstablished — the connect-time packet 0
   *  a default-constructed (plain) CSendPacket on every server). */
  OnConnEstablished(socket: CClientSocket): void {
    const packet = new CSendPacket(GS_ClientSend.OnConnect, CipherDegree.kPacketRaw);
    packet.Encode2(CENTER_VERSION);
    packet.Encode2(CONN_HELLO_VERSION[SVRCLASS_GAME]);
    packet.Encode4(socket.m_nHeaderType);
    packet.EncodeStr(CONN_PATCH_URL);
    socket.SendPacket(packet);
  }

  /** The worker-thread dispatch: connect/channel pool by the socket stage. */
  DispatchClient(n: CReceivedPacket, socket: CClientSocket): void {
    if (socket.m_nPoolType === 0) CConnectPool.ms_pInstance?.OnPacket(n, socket);
    else CChannelPool.ms_pInstance?.OnPacket(n, socket);
  }
}

// ============================ CCenterProcess ============================

/** CCenterProcess — the GS side of the center link. */
export class CCenterProcess {
  static ms_pInstance: CCenterProcess | null = null;

  m_pSocket: CLocalSocket;
  m_nChannels = 0; // +47384
  m_anConnCount: number[] = []; // +35096 (E4 per channel)
  m_vtGameStateOrder: number[] = []; // +47420 (vector<u8>)
  m_mapAlive = new Map<number, number>(); // +47432 map<u8,int>
  m_mapGameVersion = new Map<number, number>(); // +47444
  m_mapClientVersion = new Map<number, number>(); // +47456
  m_aszChannelName: string[] = []; // +1304 (33-byte names)
  m_anChannelMaxUser: number[] = []; // +39192 (CM 3's E4 = cfg FXGSMaxUser, CxCenter 13249)
  m_anChannelType: number[] = []; // +280
  m_anChannelSvrClass: number[] = []; // +43288
  m_anChannelPort: number[] = []; // +44312 (u16)
  m_anChannelEnterable: number[] = []; // +46360

  constructor(public db: CDBMan) {
    this.m_pSocket = new CLocalSocket({
      onPacket: (_sock, packet) => this.OnPacket(packet),
      onClose: () => {
        console.error("[GS] LocalSocket connection closed from center server, terminate process.");
        process.exit(0);
      },
    });
    CCenterProcess.ms_pInstance = this;
  }

  /** CCenterProcess::Init — connect, greet, identify. */
  async Init(cfg: CServerConfig): Promise<void> {
    await this.m_pSocket.ConnectToCenter(
      cfg.GetAttribute("CenterIP"),
      cfg.GetNumAttribute("CenterPort"),
      SVRCLASS_GAME,
      cfg.GetNumAttribute("ServerIndex"),
      // gameVersion/clientVersion default from S2S GAME_VERSION/CLIENT_VERSION
      // (FxServer.exe.c:3703 — [E2 7][E2 3])
    );
    console.log("[GS] Connection to Center Server established");
  }

  private m_channelInfoWaiter: (() => void)[] = [];

  /** The channel table (CM 3) is the only writer of MainSystem+8, and the
   *  session ctors read it through CreateSessionStrategy (:37220).  The
   *  original boots the table right after the DB opens and wins the race
   *  whenever those are slower than the center link; the port simply
   *  awaits the channel table before building the table. */
  WaitChannelInfo(): Promise<void> {
    if (this.m_nChannels !== 0) return Promise.resolve();
    return new Promise((resolve) => this.m_channelInfoWaiter.push(resolve));
  }

  /** CCenterProcess::SendPacket (the CLocalSocket uplink). */
  SendPacket(packet: CSendPacket): void {
    this.m_pSocket.SendToCenter(packet);
  }

  /** CCenterProcess::UnregisterConnection — MC 1 [E4 serial]. */
  UnregisterConnection(n: number): void {
    const p = new CSendPacket(MC_ReceivedPacket.OnDeleteUser);
    p.Encode4(n);
    this.SendPacket(p);
  }

  /** CCenterProcess::SendAuthenCode — MC 9 [E4 serial][E1 code]. */
  SendAuthenCode(n: number, code: number): void {
    const p = new CSendPacket(MC_ReceivedPacket.OnSetAuthenCode);
    p.Encode4(n);
    p.Encode1(code);
    this.SendPacket(p);
  }

  /** CCenterProcess::OnPacket — the 13-case dispatch. */
  OnPacket(n: CReceivedPacket): void {
    switch (n.Decode1()) {
      case CM_ReceivedPacket.OnCenterResConnectToSvr:
        CChannelPool.ms_pInstance?.OnCenterResConnectToSvr(n);
        break;
      case CM_ReceivedPacket.OnCenterResConnEstablished:
        CConnectPool.ms_pInstance?.OnCenterResConnEstablished(n);
        break;
      case CM_ReceivedPacket.OnLocalServerInfo:
        this.OnLocalServerInfo(n);
        break;
      case CM_ReceivedPacket.OnLocalServerState:
        this.OnLocalServerState(n);
        break;
      case CM_ReceivedPacket.OnLocalGameState:
        this.OnLocalGameState(n);
        break;
      case CM_ReceivedPacket.OnSvrReservedMsg:
        this.OnSvrReservedMsg(n);
        break;
      case CM_ReceivedPacket.OnAdminNotifyMsg:
        this.OnAdminNotifyMsg(n);
        break;
      case CM_ReceivedPacket.OnUserChannelResult:
        this.OnUserChannelResult(n);
        break;
      case CM_ReceivedPacket.OnDeleteUser:
        this.OnDeleteUser(n);
        break;
      case CM_ReceivedPacket.OnInitialSvrAttr:
        this.OnInitialSvrAttr(n);
        break;
      case CM_ReceivedPacket.OnSystemMsg:
        this.OnSystemMsg(n);
        break;
      case CM_ReceivedPacket.OnItemDBInit:
        CUserItemMan.ms_pInstance?.Init(this.db);
        break;
      default:
        break;
    }
  }

  /** CCenterProcess::OnLocalServerInfo — CM 3 (the channel table). */
  OnLocalServerInfo(n: CReceivedPacket): void {
    this.m_nChannels = n.Decode4();
    this.m_aszChannelName = [];
    this.m_anChannelMaxUser = [];
    this.m_anChannelType = [];
    this.m_anChannelSvrClass = [];
    this.m_anChannelPort = [];
    this.m_anChannelEnterable = [];
    for (let i = 0; i < this.m_nChannels; i++) {
      this.m_aszChannelName.push(n.DecodeStr());
      this.m_anChannelMaxUser.push(n.Decode4());
      this.m_anChannelType.push(n.Decode1());
      this.m_anChannelSvrClass.push(n.Decode1());
      this.m_anChannelPort.push(n.Decode2());
      this.m_anChannelEnterable.push(n.Decode1());
    }
    // MainSystem+8 = chByteType[ServerIndex]
    const idx = CServerConfig.ms_pInstance!.GetNumAttribute("ServerIndex");
    CMainSystem.ms_pInstance!.m_nChannelType = this.m_anChannelType[idx] ?? 0;
    for (const waiter of this.m_channelInfoWaiter.splice(0)) waiter();
  }

  /** CCenterProcess::OnLocalServerState — CM 4 (per-channel user counts). */
  OnLocalServerState(n: CReceivedPacket): void {
    if (this.m_nChannels === 0) return;
    const count = n.Decode4();
    if (count !== this.m_nChannels) {
      console.error("[GS] Fatal error: Channel number mismatch");
      return;
    }
    this.m_anConnCount = [];
    for (let i = 0; i < count; i++) this.m_anConnCount.push(n.Decode4());
  }

  /** CCenterProcess::OnLocalGameState — CM 5 (alive/version maps). */
  OnLocalGameState(n: CReceivedPacket): void {
    this.m_vtGameStateOrder = [];
    const count = n.Decode1();
    for (let i = 0; i < count; i++) {
      const ch = n.Decode1();
      this.m_vtGameStateOrder.push(ch);
      this.m_mapAlive.set(ch, n.Decode1());
      this.m_mapGameVersion.set(ch, n.Decode2());
      this.m_mapClientVersion.set(ch, n.Decode2());
    }
  }

  /** CCenterProcess::MakeChannelsStatePacket — the 13 body (InitPacket). */
  MakeChannelsStatePacket(packet: CSendPacket): void {
    packet.InitPacket(GS_ClientSend.OnChannelsState);
    packet.Encode2(this.m_nChannels);
    for (let i = 0; i < this.m_nChannels; i++) packet.Encode2(this.m_anConnCount[i] ?? 0);
  }

  /** CCenterProcess::MakeChannelsGameStatePacket — the 14 body (InitPacket). */
  MakeChannelsGameStatePacket(packet: CSendPacket): void {
    if (this.m_vtGameStateOrder.length === 0) return;
    packet.InitPacket(GS_ClientSend.OnChannelsGameState);
    packet.Encode1(this.m_vtGameStateOrder.length);
    for (const ch of this.m_vtGameStateOrder) {
      packet.Encode1(ch);
      packet.Encode1(this.m_mapAlive.get(ch) ?? 0);
      packet.Encode2(this.m_mapGameVersion.get(ch) ?? 0);
      packet.Encode2(this.m_mapClientVersion.get(ch) ?? 0);
    }
  }

  /** CCenterProcess::CheckEnterGame — 1 ok / 4 version / 5 not alive. */
  CheckEnterGame(i: number, _n: number, version: number): number {
    if (this.m_vtGameStateOrder.length === 0) return 0;
    if ((this.m_mapAlive.get(i) ?? 0) !== 0) {
      return (this.m_mapGameVersion.get(i) ?? 0) === version ? 1 : 4;
    }
    return 5;
  }

  /** CCenterProcess::OnSvrReservedMsg — CM 7 → client 16. */
  OnSvrReservedMsg(n: CReceivedPacket): void {
    const name = n.DecodeStr();
    const user = CLocalUserTable.ms_pInstance!.FindUserFromId(name);
    if (!user) return;
    const code = n.Decode1();
    const p = new CSendPacket(GS_ClientSend.OnSvrReservedMsg, CipherDegree.kPacketEncryptedCRC8);
    p.Encode1(code);
    if (code === 1) p.EncodeStr(n.DecodeStr());
    user.m_pSocket?.SendPacket(p);
  }

  /** CCenterProcess::OnAdminNotifyMsg — CM 8 → client 26 to everyone. */
  OnAdminNotifyMsg(n: CReceivedPacket): void {
    const msg = n.DecodeStr();
    const p = new CSendPacket(GS_ClientSend.OnAdminNotifyMsg, CipherDegree.kPacketEncryptedCRC8);
    p.EncodeStr(msg);
    CChannelPool.ms_pInstance?.SendAll(p, 0);
  }

  /** CCenterProcess::OnSystemMsg — CM 13 → client 30 to everyone. */
  OnSystemMsg(n: CReceivedPacket): void {
    const msg = n.DecodeStr();
    const p = new CSendPacket(GS_ClientSend.OnSystemMsg, CipherDegree.kPacketEncryptedCRC8);
    p.EncodeStr(msg);
    CChannelPool.ms_pInstance?.SendAll(p, 0);
  }

  /** CCenterProcess::OnDeleteUser — CM 11 [E4 serial] → close the socket. */
  OnDeleteUser(n: CReceivedPacket): void {
    const serial = n.Decode4();
    const user = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(serial);
    if (!user) {
      console.error("[GS] Center server tried to delete the absent user.");
      return;
    }
    console.log(`[GS] Center server disconnect [${user.GetName()}].`);
    user.m_pSocket?.PostClosePacket();
  }

  /** CMainSystem::OnInitialSvrAttr — CM 12 [E1 domain][E1 inventory flag]. */
  OnInitialSvrAttr(n: CReceivedPacket): void {
    const domain = n.Decode1();
    const inv = n.Decode1();
    CMainSystem.ms_pInstance!.m_nGameDomain = domain;
    CMainSystem.ms_pInstance!.m_fInventoryDB = inv;
  }

  /** CCenterProcess::OnUserChannelResult — CM 10 → 71/72 to the asker. */
  OnUserChannelResult(n: CReceivedPacket): void {
    const r = n.Decode1();
    const serial = n.Decode4();
    const name = n.DecodeStr();
    const type = n.Decode1();
    const sessionIdx = n.Decode4();
    const asker = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(serial);
    if (!asker || !asker.m_pSocket) return;
    if (r === 1) {
      // SendUserLocation → 72
      const p = new CSendPacket(GS_ClientSend.OnRequestUserLocationRes, CipherDegree.kPacketEncryptedCRC8);
      p.Encode1(1);
      p.EncodeStr(name);
      p.Encode1(type);
      p.Encode4(sessionIdx);
      p.Encode2(SESSION_LOC_OTHER_SERVER); // the other-server marker
      asker.m_pSocket.SendPacket(p);
    } else {
      // SendUserDetailInfo → 71 (DB-backed)
      const info = this.db.prGetUserInfo(name);
      const p = new CSendPacket(GS_ClientSend.OnRequestUserInfoDetailRes, CipherDegree.kPacketEncryptedCRC8);
      if (info.retval === 0) {
        p.Encode1(1);
        p.EncodeStr(name);
        p.EncodeStr(info.Name);
        if (info.GuildSn > 0 && CGuildTable.ms_pInstance!.Insert(info.GuildSn) !== 0) {
          const g = CGuildTable.ms_pInstance!.FindGuildFromSerialNo(info.GuildSn)!;
          p.EncodeStr(g.strName);
        } else {
          p.EncodeStr("");
        }
        p.Encode1(info.Gender);
        p.Encode4(info.win);
        p.Encode4(info.draw);
        p.Encode4(info.lose);
        p.Encode4(info.exp);
        const level = CDynInfoCalculator_GetLevel(info.exp);
        p.Encode4(CDynInfoCalculator_GetMaxExpInLevel(level));
        p.Encode2(level);
        p.Encode4(info.money);
        p.Encode1(type);
        p.Encode4(sessionIdx);
        p.Encode2(SESSION_LOC_OTHER_SERVER);
        p.Encode1(info.Reveal);
        if (info.Reveal !== 0) {
          p.EncodeStr(info.Address);
          p.EncodeStr(info.Tel);
          p.EncodeStr(info.Profile);
          p.EncodeStr(info.Birthday);
        }
        p.Encode4(0);
        p.Encode1(info.CommunitySvr);
        SendGameSlotInfo(p, null);
      } else {
        p.Encode1(0);
        p.EncodeStr(name);
      }
      asker.m_pSocket.SendPacket(p);
    }
  }
}
