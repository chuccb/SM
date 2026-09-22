/** Native source unit: FX/FxServer/CenterProcess.cpp. */
import type { CServerConfig } from "../core/ServerConfig.ts";
import { CReceivedPacket, CSendPacket, CipherDegree } from "../core/Packet.ts";
import { CDBMan } from "../db/DBMan.ts";
import { CLocalSocket } from "../common/LocalSocket.ts";
import { S2C_GamePacket } from "../core/protocol/PacketIDs.ts";
import { CM_GameServerPacket, MC_GameServerSendPacket, SVRCLASS_GAME } from "../core/protocol/CenterProtocol.ts";
import { CDynInfoCalculator_GetLevel, CDynInfoCalculator_GetMaxExpInLevel } from "../common/LevelTable.ts";
import { CONNECT_GATE_RESULT, SESSION_LOC_OTHER_SERVER } from "./Defs.ts";
import { CUserItemMan } from "./ItemMan.ts";
import { CGuildTable } from "./Guild.ts";
import { CLocalUserTable } from "./LocalUserTable.ts";
import { CMainSystem } from "./MainSystem.ts";
import {
  DispatchChannelCenterResponse,
  DispatchConnectCenterResponse,
  SendChannelPacket,
  WriteGameSlotInfo,
} from "./runtime/ClientSocketRuntime.ts";
import { RegisterCenterProcess } from "./runtime/CenterProcessRuntime.ts";

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

  constructor(
    public db: CDBMan,
    private readonly cfg: CServerConfig,
  ) {
    this.m_pSocket = new CLocalSocket({
      onPacket: (_sock, packet) => this.OnPacket(packet),
      onClose: () => {
        console.error("[GS] LocalSocket connection closed from center server, terminate process.");
        process.exit(0);
      },
    });
    CCenterProcess.ms_pInstance = this;
    RegisterCenterProcess(this);
  }

  /** CCenterProcess::Init — connect, greet, identify. */
  async Init(): Promise<void> {
    const cfg = this.cfg;
    await this.m_pSocket.ConnectToCenter(
      cfg.GetAttribute("CenterIP"),
      cfg.GetNumAttribute("CenterPort"),
      SVRCLASS_GAME,
      cfg.GetServerIdx(),
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

  /** Port-side destruction of the owned center transport. */
  Stop(): void {
    this.m_pSocket.hooks.onClose = () => {};
    this.m_pSocket.Close();
    this.m_channelInfoWaiter = [];
    if (CCenterProcess.ms_pInstance === this) {
      CCenterProcess.ms_pInstance = null;
      RegisterCenterProcess(null);
    }
  }

  /** CCenterProcess::SendPacket (the CLocalSocket uplink). */
  SendPacket(packet: CSendPacket): void {
    this.m_pSocket.SendToCenter(packet);
  }

  /** CCenterProcess::UnregisterConnection — MC 1 [E4 serial]. */
  UnregisterConnection(n: number): void {
    const p = new CSendPacket(MC_GameServerSendPacket.OnDeleteUser, CipherDegree.kPacketRaw);
    p.Encode4(n);
    this.SendPacket(p);
  }

  /** CCenterProcess::SendAuthenCode — MC 9 [E4 serial][E1 code]. */
  SendAuthenCode(n: number, code: number): void {
    const p = new CSendPacket(MC_GameServerSendPacket.SendAuthenCode, CipherDegree.kPacketRaw);
    p.Encode4(n);
    p.Encode1(code);
    this.SendPacket(p);
  }

  /** CCenterProcess::OnPacket — the 12-case dispatch. */
  OnPacket(n: CReceivedPacket): void {
    switch (n.Decode1()) {
      case CM_GameServerPacket.OnCenterResConnectToSvr:
        DispatchChannelCenterResponse(n);
        break;
      case CM_GameServerPacket.OnCenterResConnEstablished:
        DispatchConnectCenterResponse(n);
        break;
      case CM_GameServerPacket.OnLocalServerInfo:
        this.OnLocalServerInfo(n);
        break;
      case CM_GameServerPacket.OnLocalServerState:
        this.OnLocalServerState(n);
        break;
      case CM_GameServerPacket.OnLocalGameState:
        this.OnLocalGameState(n);
        break;
      case CM_GameServerPacket.OnSvrReservedMsg:
        this.OnSvrReservedMsg(n);
        break;
      case CM_GameServerPacket.OnAdminNotifyMsg:
        this.OnAdminNotifyMsg(n);
        break;
      case CM_GameServerPacket.OnUserChannelResult:
        this.OnUserChannelResult(n);
        break;
      case CM_GameServerPacket.OnDeleteUser:
        this.OnDeleteUser(n);
        break;
      case CM_GameServerPacket.OnInitialSvrAttr:
        CMainSystem.ms_pInstance?.OnInitialSvrAttr(n);
        break;
      case CM_GameServerPacket.OnSystemMsg:
        this.OnSystemMsg(n);
        break;
      case CM_GameServerPacket.OnItemDBInit:
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
    // MainSystem+8 = chByteType[this FXGS process's ServerIndex]. The port
    // captures that service config because all six emulated EXEs can share
    // one Bun process and must not observe another service's singleton.
    CMainSystem.ms_pInstance!.m_nChannelType = this.m_anChannelType[this.cfg.GetServerIdx()] ?? 0;
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
    packet.InitPacket(S2C_GamePacket.OnChannelsState);
    packet.Encode2(this.m_nChannels);
    for (let i = 0; i < this.m_nChannels; i++) packet.Encode2(this.m_anConnCount[i] ?? 0);
  }

  /** CCenterProcess::MakeChannelsGameStatePacket — the 14 body (InitPacket). */
  MakeChannelsGameStatePacket(packet: CSendPacket): void {
    if (this.m_vtGameStateOrder.length === 0) return;
    packet.InitPacket(S2C_GamePacket.OnChannelsGameState);
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
    if (this.m_vtGameStateOrder.length === 0) return CONNECT_GATE_RESULT.NoGameState;
    if ((this.m_mapAlive.get(i) ?? 0) !== 0) {
      return (this.m_mapGameVersion.get(i) ?? 0) === version ? CONNECT_GATE_RESULT.Success : CONNECT_GATE_RESULT.VersionMismatch;
    }
    return CONNECT_GATE_RESULT.ServerTypeUnavailable;
  }

  /** CCenterProcess::OnSvrReservedMsg — CM 7 → client 16. */
  OnSvrReservedMsg(n: CReceivedPacket): void {
    const name = n.DecodeStr();
    const user = CLocalUserTable.ms_pInstance!.FindUserFromId(name);
    if (!user) return;
    const code = n.Decode1();
    const p = new CSendPacket(S2C_GamePacket.OnSvrReservedMsg);
    p.Encode1(code);
    if (code === 1) p.EncodeStr(n.DecodeStr());
    user.m_pSocket?.SendPacket(p);
  }

  /** CCenterProcess::OnAdminNotifyMsg — CM 8 → client 26 to everyone. */
  OnAdminNotifyMsg(n: CReceivedPacket): void {
    const msg = n.DecodeStr();
    const p = new CSendPacket(S2C_GamePacket.OnAdminNotifyMsg);
    p.EncodeStr(msg);
    SendChannelPacket(p, 0);
  }

  /** CCenterProcess::OnSystemMsg — CM 13 → client 30 to everyone. */
  OnSystemMsg(n: CReceivedPacket): void {
    const msg = n.DecodeStr();
    const p = new CSendPacket(S2C_GamePacket.OnSystemMsg);
    p.EncodeStr(msg);
    SendChannelPacket(p, 0);
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
      const p = new CSendPacket(S2C_GamePacket.OnRequestUserLocationRes);
      p.Encode1(1);
      p.EncodeStr(name);
      p.Encode1(type);
      p.Encode4(sessionIdx);
      p.Encode2(SESSION_LOC_OTHER_SERVER); // the other-server marker
      asker.m_pSocket.SendPacket(p);
    } else {
      // SendUserDetailInfo → 71 (DB-backed)
      const info = this.db.prGetUserInfo(name);
      const p = new CSendPacket(S2C_GamePacket.OnRequestUserInfoDetailRes);
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
        WriteGameSlotInfo(p, null);
      } else {
        p.Encode1(0);
        p.EncodeStr(name);
      }
      asker.m_pSocket.SendPacket(p);
    }
  }
}
