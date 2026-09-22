/** Native source unit: CX/CxLogin/CenterProcess.cpp. */
import { CServerConfig } from "../core/ServerConfig.ts";
import { CReceivedPacket, CSendPacket, CipherDegree } from "../core/Packet.ts";
import { CDBMan } from "../db/DBMan.ts";
import { CMultiServer, inet_addr } from "./MultiServer.ts";
import { CChannelCache } from "./ChannelCache.ts";
import { CLocalSocket } from "../common/LocalSocket.ts";
import { CM_LoginServerPacket, MC_LoginServerSendPacket, SVRCLASS_LOGIN } from "../core/protocol/CenterProtocol.ts";
import { S2C_LoginNoticePacket } from "../core/protocol/PacketIDs.ts";
import { MACHINE_ID_BYTES, PeerAddressDword, type CClientSocket } from "./ClientSocket.ts";
import type { CLoginPool } from "./LoginPool.ts";
import { CUserPool } from "./UserPool.ts";
import { RegisterLoginCenter } from "./runtime/LoginRuntime.ts";
import { ADVERTISEMENT_TRAILING, CONNECT_GATE_RESULT } from "./Defs.ts";

/** _Advertisement (FxAdvertisement row, 36-byte vector entry): std::string
 *  (12 bytes, no SSO) plus six int slots at +12..+32. UpdateAdvertisement
 *  (CxLogin.exe.lst:407570) stores only five of them: +12←Param1 and
 *  +16←Param2 ride the client-11 wire, +24←Param3 repeats the ad inside the
 *  rotation pool, +28←Param4/+32←Param5 bound the visibility hour window
 *  (Param5 < Param4 wraps past midnight). The +20 slot is never written by
 *  the original — no sixth parameter exists. */
interface _Advertisement {
  strImage: string;
  Param1: number;
  Param2: number;
  Param3: number;
  Param4: number;
  Param5: number;
}

/** CCenterProcess — the LS side of the center link. */
export class CCenterProcess {
  private static m_pInstance: CCenterProcess | null = null;

  static get ms_pInstance(): CCenterProcess | null {
    return CCenterProcess.m_pInstance;
  }

  static set ms_pInstance(center: CCenterProcess | null) {
    CCenterProcess.m_pInstance = center;
    RegisterLoginCenter(center);
  }

  m_pCenterSocket: CLocalSocket | null = null;
  m_pLoginPool: CLoginPool;
  m_pMultiServer: CMultiServer;
  m_pChannelCache!: CChannelCache;
  m_db: CDBMan;

  // OnLocalServerInfo state
  m_nChannelNo = 0;
  m_anSvrType: number[] = []; // +42264 (GetLevelLimit key)
  m_anChannelMaxUser: number[] = []; // +38168 (CM 3's E4 = cfg FXGSMaxUser)
  m_anFieldB: number[] = []; // +43288
  m_anCommunity: number[] = []; // +44312
  m_anFieldC: number[] = []; // +55576
  m_anConnNo: number[] = []; // +34072 (from p4)
  m_nLevelLimitMax = 0; // +47420 (type 1)
  m_nLevelLimitMin = 0; // +47421 (type 99)

  // OnLocalGameState state
  m_vtGameState: number[] = []; // +47680 (one entry per GS: its class)
  m_mapGameState = new Map<number, number>(); // +47692
  m_mapGameVersion = new Map<number, number>(); // +47704
  m_mapClientVersion = new Map<number, number>(); // +47716

  // ExtraInfo state
  m_vtAdvertisement: _Advertisement[] = []; // +47456 — the full FxAdvertisement reload
  m_vtSelAdvertisement: _Advertisement[] = []; // +47468 — the hour-window selection (Param3 repeats)
  m_vtFxMessage: { strMessage: string; nAttr: number }[] = []; // +47556 — FxMessage (MessageUse = 1)
  m_vtGuildSvrList: { strIp: string; nPort: number }[] = [];
  m_nPreChMapSelReward = 0; // +47600 (WORD on the wire) — FxUserOptions PRECHMAPREWARD
  m_nAdvCursor = 0; // dword_49F61C — rotates the SELECTED ads
  m_nGuildSvrCursor = 0; // dword_49F950
  m_nNdaCursor = 0; // dword_49F7B4
  m_nNdaIps: number[] = []; // dword_49F7B8
  m_nRelayIps: number[] = []; // dword_49F620

  /** The LS's own config (the process global is per-process in the original). */
  m_cfg: CServerConfig | null = null;

  constructor(loginPool: CLoginPool, multiServer: CMultiServer, db: CDBMan) {
    CCenterProcess.ms_pInstance = this;
    this.m_pLoginPool = loginPool;
    this.m_pMultiServer = multiServer;
    this.m_db = db;
  }

  /** bound once the pool exists (main wires the two singletons together) */
  AttachPool(loginPool: CLoginPool): void {
    this.m_pLoginPool = loginPool;
    this.m_pChannelCache = loginPool.m_channelCache;
  }

  /** CCenterProcess::ConnectToCenter */
  async ConnectToCenter(cfg: CServerConfig): Promise<void> {
    const host = cfg.GetAttribute("CenterIP");
    const port = cfg.GetNumAttribute("CenterPort");
    this.m_pCenterSocket = new CLocalSocket({
      onPacket: (_sock, packet) => this.OnPacket(packet),
      onClose: () => {
        console.error("[LS] center connection lost");
        this.m_pCenterSocket = null;
      },
    });
    await this.m_pCenterSocket.ConnectToCenter(host, port, SVRCLASS_LOGIN, cfg.GetServerIdx());
    console.log(`[LS] attached to center ${host}:${port}`);
  }

  /** Port-side destruction of the owned center transport. */
  Stop(): void {
    if (this.m_pCenterSocket !== null) {
      this.m_pCenterSocket.hooks.onClose = () => {};
      this.m_pCenterSocket.Close();
      this.m_pCenterSocket = null;
    }
    if (CCenterProcess.ms_pInstance === this) CCenterProcess.ms_pInstance = null;
  }

  /** CCenterProcess::SendFrPacketToCenter */
  SendFrPacketToCenter(packet: CSendPacket): void {
    this.m_pCenterSocket?.SendPacket(packet);
  }

  /** CCenterProcess::OnPacket (CxLogin.exe.c:6055) */
  OnPacket(n: CReceivedPacket): void {
    switch (n.Decode1()) {
      case CM_LoginServerPacket.OnCenterResAddNewUser:
        this.m_pLoginPool.OnCenterResAddNewUser(n);
        break;
      case CM_LoginServerPacket.OnCenterResConnectToSvr:
        this.m_pLoginPool.OnCenterResConnectToSvr(n);
        break;
      case CM_LoginServerPacket.OnCenterResConnEstablished:
        console.error("Fatal error: Login server cannot handle 'kmcResConnEstablished'");
        break;
      case CM_LoginServerPacket.OnLocalServerInfo:
        this.OnLocalServerInfo(n);
        break;
      case CM_LoginServerPacket.OnLocalServerState:
        this.OnLocalServerState(n);
        break;
      case CM_LoginServerPacket.OnLocalGameState:
        this.OnLocalGameState(n);
        break;
      case CM_LoginServerPacket.OnSvrReservedMsg:
        this.OnSvrReservedMsg(n);
        break;
      case CM_LoginServerPacket.OnAdminNotifyMsg:
        this.OnAdminNotifyMsg(n);
        break;
      case CM_LoginServerPacket.OnDeleteUser:
        this.OnDeleteUser(n);
        break;
      case CM_LoginServerPacket.OnSystemMsg:
        this.OnSystemMsg(n);
        break;
      default:
        return;
    }
  }

  /** CCenterProcess::RegisterConnection (CxLogin.exe.c:4942) — center packet 0. */
  RegisterConnection(socket: CClientSocket): void {
    const packet = new CSendPacket(MC_LoginServerSendPacket.OnAddNewUser); // MC
    packet.Encode4(PeerAddressDword(socket)); // the client's in_addr (the D4 the center stores as CUser::GetIP)
    packet.EncodeBuffer(socket.GetMachineId(), MACHINE_ID_BYTES);
    packet.Encode4(socket.GetGameRoomCode());
    const userCount = socket.GetUserCount();
    packet.Encode1(userCount);
    for (let i = 0; i < userCount; i++) {
      const user = socket.GetUser(i)!;
      packet.EncodeStr(user.GetName());
      packet.Encode4(user.GetSID());
      packet.Encode1(user.GetPremiumTicket());
      packet.Encode1(user.nCommunitySvr);
    }
    packet.Encode4(socket.GetLocalSerialNo());
    this.SendFrPacketToCenter(packet);
  }

  /** CCenterProcess::UnregisterConnection (CxLogin.exe.c:1380) — center packet 1. */
  UnregisterConnection(sn: number): void {
    if (sn === 0) return;
    const packet = new CSendPacket(MC_LoginServerSendPacket.OnDeleteUser); // MC
    packet.Encode4(sn);
    this.SendFrPacketToCenter(packet);
  }

  /** CCenterProcess::DestructCenterSvr (CxLogin.exe.c:1406) — center packet 100. */
  DestructCenterSvr(): void {
    const packet = new CSendPacket(MC_LoginServerSendPacket.OnDestructCenterSvr);
    this.SendFrPacketToCenter(packet);
  }

  /** CCenterProcess::CheckEnterGame (CxLogin.exe.c:5964) */
  CheckEnterGame(nServerType: number, _nSvrIdx: number, nVersion: number): number {
    if (this.m_vtGameState.length === 0) return CONNECT_GATE_RESULT.NoGameState;
    if ((this.m_mapGameState.get(nServerType) ?? 0) === 0) return CONNECT_GATE_RESULT.ServerTypeUnavailable;
    if ((this.m_mapGameVersion.get(nServerType) ?? 0) !== nVersion) return CONNECT_GATE_RESULT.VersionMismatch;
    return CONNECT_GATE_RESULT.Success;
  }

  /** CCenterProcess::UpdateLevelLimit (CxLogin.exe.c:5235) */
  UpdateLevelLimit(): void {
    this.m_nLevelLimitMax = this.m_db.GetOption("LEVELLIMITMAX");
    this.m_nLevelLimitMin = this.m_db.GetOption("LEVELLIMITMIN");
  }

  /** CCenterProcess::GetLevelLimit (CxLogin.exe.c:2436) */
  GetLevelLimit(nType: number): number {
    const svrType = this.m_anSvrType[nType] ?? 0;
    if ((svrType !== 1 && svrType !== 99) || !this.m_db) return 0;
    return svrType === 1 ? this.m_nLevelLimitMax : this.m_nLevelLimitMin;
  }

  /** CCenterProcess::OnLocalServerInfo (CxLogin.exe.c:5520) — center p3. */
  OnLocalServerInfo(n: CReceivedPacket): void {
    this.UpdateLevelLimit();
    const channelNo = n.Decode4();
    this.m_nChannelNo = channelNo;
    this.m_pChannelCache.SetChannelNo(channelNo);
    this.m_anSvrType = [];
    this.m_anChannelMaxUser = [];
    this.m_anFieldB = [];
    this.m_anCommunity = [];
    this.m_anFieldC = [];
    if (this.m_nChannelNo > 0) {
      for (let i = 0; i < this.m_nChannelNo; i++) {
        const name = n.DecodeStr();
        const chNo = n.Decode4();
        const a = n.Decode1();
        const b = n.Decode1();
        const community = n.Decode2();
        const c = n.Decode1();
        this.m_anSvrType.push(a);
        this.m_anChannelMaxUser.push(chNo);
        this.m_anFieldB.push(b);
        this.m_anCommunity.push(community);
        this.m_anFieldC.push(c);
        this.m_pChannelCache.SetChannelInfo(i, name, 0, chNo, this.GetLevelLimit(i), a, b, community, c);
      }
    }
    this.m_pChannelCache.MakeInfoPacket();
  }

  /** CCenterProcess::OnLocalServerState (CxLogin.exe.c:2389) — center p4. */
  OnLocalServerState(n: CReceivedPacket): void {
    const channelNo = this.m_nChannelNo;
    if (channelNo !== n.Decode4()) return;
    this.m_anConnNo = [];
    for (let i = 0; i < channelNo; i++) {
      const connNo = n.Decode4();
      this.m_anConnNo.push(connNo);
      this.m_pChannelCache.SetChannelInfo(i, connNo);
    }
    this.m_pChannelCache.MakeStatePacket();
  }

  /** CCenterProcess::OnLocalGameState (CxLogin.exe.c:5820) — center p5. */
  OnLocalGameState(n: CReceivedPacket): void {
    const count = n.Decode1();
    this.m_vtGameState = [];
    for (let i = 0; i < count; i++) {
      const type = n.Decode1();
      this.m_vtGameState.push(type);
      this.m_mapGameState.set(type, n.Decode1());
      this.m_mapGameVersion.set(type, n.Decode2());
      this.m_mapClientVersion.set(type, n.Decode2());
    }
  }

  /** CCenterProcess::MakeChannelsGameStatePacket (CxLogin.exe.c:5925) — client p14. */
  MakeChannelsGameStatePacket(packet: CSendPacket): void {
    packet.InitPacket(S2C_LoginNoticePacket.OnChannelsGameState);
    packet.Encode1(this.m_vtGameState.length);
    for (const type of this.m_vtGameState) {
      packet.Encode1(type);
      packet.Encode1(this.m_mapGameState.get(type) ?? 0);
      packet.Encode2(this.m_mapGameVersion.get(type) ?? 0);
      packet.Encode2(this.m_mapClientVersion.get(type) ?? 0);
    }
  }

  /** CCenterProcess::MakeChannelsExtraInfoPacket (CxLogin.exe.c:6414) — client p11. */
  MakeChannelsExtraInfoPacket(packet: CSendPacket): void {
    packet.InitPacket(S2C_LoginNoticePacket.OnChannelsExtraInfo);
    // rotating advertisement: [EStr strImage][E2 Param1][E2 Param2][E2 60]
    const adv = this.GetAdvertisement();
    packet.EncodeStr(adv.strImage);
    packet.Encode2(adv.Param1 & 0xffff);
    packet.Encode2(adv.Param2 & 0xffff);
    packet.Encode2(ADVERTISEMENT_TRAILING);
    // guild server list: at most 2 entries, the window start rotates per call
    const guildCount = this.m_vtGuildSvrList.length;
    let guildStart = 0;
    if (guildCount > 2) {
      packet.Encode1(2);
      guildStart = this.m_nGuildSvrCursor % (guildCount - 2);
    } else {
      this.m_nGuildSvrCursor = 0;
      packet.Encode1(guildCount);
    }
    let guildSent = 0;
    for (let i = guildStart; i < guildCount && guildSent < 2; i++, guildSent++) {
      const gs = this.m_vtGuildSvrList[i]!;
      packet.Encode4(inet_addr(gs.strIp));
      packet.Encode2(gs.nPort);
    }
    if (guildCount > 2) this.m_nGuildSvrCursor++;
    // NDA list: at most 2, round-robin cursor
    if (this.m_nNdaIps.length === 0) {
      const ndaCfg = this.m_cfg ?? CServerConfig.ms_pInstance;
      const ndaNumber = ndaCfg.GetNumAttribute("NDANumber");
      for (let i = 0; i < ndaNumber; i++) this.m_nNdaIps.push(inet_addr(ndaCfg.GetAttribute(`NDAIP${i}`)));
    }
    {
      const ndaCount = this.m_nNdaIps.length;
      const ndaMax = ndaCount < 2 ? ndaCount : 2;
      packet.Encode1(ndaMax);
      for (let j = ndaMax; j !== 0; j--) {
        packet.Encode4(this.m_nNdaIps[this.m_nNdaCursor]!);
        this.m_nNdaCursor = (this.m_nNdaCursor + 1) % this.m_nNdaIps.length;
      }
    }
    // relay list
    if (this.m_nRelayIps.length === 0) {
      const relayCfg = this.m_cfg ?? CServerConfig.ms_pInstance;
      const relayNumber = relayCfg.GetNumAttribute("RelayNumber");
      for (let i = 0; i < relayNumber; i++) this.m_nRelayIps.push(inet_addr(relayCfg.GetAttribute(`RelayIP${i}`)));
    }
    packet.Encode1(this.m_nRelayIps.length);
    for (const ip of this.m_nRelayIps) packet.Encode4(ip);
    // fx messages: [E2 count][count×(E1 0, E1 attr, EStr message)]
    packet.Encode2(this.m_vtFxMessage.length);
    for (const m of this.m_vtFxMessage) {
      packet.Encode1(0);
      packet.Encode1(m.nAttr);
      packet.EncodeStr(m.strMessage);
    }
    // premium channel map-select reward (FxUserOptions PRECHMAPREWARD)
    packet.Encode2(this.m_nPreChMapSelReward & 0xffff);
    // JUM servers
    const cfg = this.m_cfg ?? CServerConfig.ms_pInstance;
    const jumNumber = cfg.GetNumAttribute("JUMSvrNumber");
    packet.Encode1(jumNumber);
    for (let i = 0; i < jumNumber; i++) {
      packet.Encode4(inet_addr(cfg.GetAttribute(`JUMSvrIP${i}`)));
      packet.Encode2(cfg.GetNumAttribute(`JUMSvrPort${i}`));
    }
  }

  /** CCenterProcess::GetAdvertisement (CxLogin.exe.c:6164) — rotates the
   *  SELECTED pool (dword_49F61C cursor, unbounded). Empty pool → the
   *  zero-ad struct (the empty-vector copy reads an empty string). */
  GetAdvertisement(): _Advertisement {
    if (this.m_vtSelAdvertisement.length === 0) {
      return { strImage: "", Param1: 0, Param2: 0, Param3: 0, Param4: 0, Param5: 0 };
    }
    const idx = this.m_nAdvCursor % this.m_vtSelAdvertisement.length;
    this.m_nAdvCursor++;
    return this.m_vtSelAdvertisement[idx]!;
  }

  /** CCenterProcess::UpdateAdvertisement (CxLogin.exe.c:7742) — aFull
   *  reloads FxAdvertisement, then the hour-window selection always runs:
   *  visible when Param4 <= now <= Param5, or across midnight (Param5 <
   *  Param4) when Param4 <= now || now <= Param5. Each visible ad enters the
   *  rotation pool Param3 times. */
  UpdateAdvertisement(aFull = 1, nowHour = new Date().getHours()): void {
    if (aFull) {
      this.m_vtAdvertisement = this.m_db.GetAdvertisements().map((r) => ({
        strImage: r.strImage,
        Param1: r.p1,
        Param2: r.p2,
        Param3: r.p3,
        Param4: r.p4,
        Param5: r.p5,
      }));
    }
    const sel: _Advertisement[] = [];
    for (const ad of this.m_vtAdvertisement) {
      const fromHour = ad.Param4;
      const toHour = ad.Param5;
      const visible = toHour < fromHour ? fromHour <= nowHour || nowHour <= toHour : fromHour <= nowHour && nowHour <= toHour;
      if (visible) for (let i = 0; i < ad.Param3; i++) sel.push(ad);
    }
    this.m_vtSelAdvertisement = sel;
  }

  /** CCenterProcess::UpdateFxMessage (CxLogin.exe.c:7961) — FxMessage rows
   *  with MessageUse = 1 (select "messageattr , message"). */
  UpdateFxMessage(): void {
    this.m_vtFxMessage = this.m_db.GetFxMessages().map((r) => ({ strMessage: r.message, nAttr: r.attr }));
  }

  /** CCenterProcess::UpdatePremiumChannelMapSelReward (CxLogin.exe.c:5328) —
   *  FxUserOptions "PRECHMAPREWARD" (CRSOptions), WORD on the wire. */
  UpdatePremiumChannelMapSelReward(): void {
    this.m_nPreChMapSelReward = this.m_db.GetPremiumSvrReward();
  }

  /** CCenterProcess::UpdateGuildServerList (CxLogin.exe.c:8079) */
  UpdateGuildServerList(): void {
    this.m_vtGuildSvrList = this.m_db.GetGuildServerList().map((r) => ({ strIp: r.IP, nPort: r.Port }));
  }

  /** CCenterProcess::OnSvrReservedMsg (CxLogin.exe.c:5005) — client p16. */
  OnSvrReservedMsg(n: CReceivedPacket): void {
    const name = n.DecodeStr();
    const user = this.m_pLoginPool.m_localUserTable.FindUserFromId(name);
    if (user !== null) {
      const packet = new CSendPacket(S2C_LoginNoticePacket.OnSvrReservedMsg, CipherDegree.kPacketEncryptedCRC8);
      const count = n.Decode1();
      packet.Encode1(count);
      if (count === 1) {
        const str = n.DecodeStr();
        packet.EncodeStr(str);
      }
      user.GetSocket().SendPacket(packet);
    }
  }

  /** CCenterProcess::OnAdminNotifyMsg (CxLogin.exe.c:5153) — client p26 broadcast. */
  OnAdminNotifyMsg(n: CReceivedPacket): void {
    const str = n.DecodeStr();
    const packet = new CSendPacket(S2C_LoginNoticePacket.OnAdminNotifyMsg, CipherDegree.kPacketEncryptedCRC8);
    packet.EncodeStr(str);
    this.SendToAll(packet);
  }

  /** CCenterProcess::OnSystemMsg (CxLogin.exe.c:5189) — client p30 broadcast. */
  OnSystemMsg(n: CReceivedPacket): void {
    const str = n.DecodeStr();
    const packet = new CSendPacket(S2C_LoginNoticePacket.OnSystemMsg, CipherDegree.kPacketEncryptedCRC8);
    packet.EncodeStr(str);
    this.SendToAll(packet);
  }

  /** CUserPool::CreateSocketList + SendAll. */
  SendToAll(packet: CSendPacket): void {
    CUserPool.SendAll(this.m_pLoginPool.CreateSocketList(), packet);
  }

  /** CCenterProcess::OnDeleteUser (CxLogin.exe.c:2431) — center p11. */
  OnDeleteUser(n: CReceivedPacket): void {
    const sn = n.Decode4();
    const user = this.m_pLoginPool.m_localUserTable.FindUserFromGlobalSerialNo(sn);
    if (user !== null) user.GetSocket().Close();
    else console.error("Center server tried to delete the absent user.");
  }


}
