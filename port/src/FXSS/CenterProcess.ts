/** Native source unit: FX/FxShop/CenterProcess.cpp. */
import { CServerConfig } from "../core/ServerConfig.ts";
import { CDBMan } from "../db/DBMan.ts";
import { CReceivedPacket, CSendPacket, CipherDegree } from "../core/Packet.ts";
import { CLocalSocket } from "../shared/LocalSocket.ts";
import { SC_SendPacket } from "../protocol/PacketIDs.ts";
import { CM_ShopServerPacket, MC_ShopServerSendPacket, SVRCLASS_SHOP } from "../protocol/CenterProtocol.ts";
import { CItemMan } from "./ItemMan.ts";
import { CUserPool } from "./UserPool.ts";
import {
  DispatchShopConnectResponse,
  DispatchShopEstablishedResponse,
  GetShopMainPool,
} from "./MainPoolRuntime.ts";
import { CMainSystem } from "./MainSystem.ts";

/** CCenterProcess — the center uplink client (CCenterProcess::Init). */
export class CCenterProcess {
  static ms_pInstance: CCenterProcess | null = null;

  m_pSocket: CLocalSocket;
  m_dwServerIP = 0;

  constructor(public db: CDBMan) {
    this.m_pSocket = new CLocalSocket({
      onPacket: (_sock, packet) => this.OnPacket(packet),
      onClose: () => {
        console.error("[Shop] LocalSocket connection closed from center server, terminate process.");
        process.exit(0);
      },
    });
    CCenterProcess.ms_pInstance = this;
  }

  /** CCenterProcess::Init — bind(ServerIP, 0), connect with a 3000 ms retry
   *  loop, the [E2 3][E2 sd] greeting (≠3 → "Version mismatch, terminate
   *  process"), then identify [E1 11][E4 idx^0x77][E2 7][E2 3] and
   *  setsockopt(0xFFFF, 4097, 0). */
  async Init(cfg: CServerConfig): Promise<void> {
    // the 3 s retry loop lives in CLocalSocket.ConnectToCenter (FxShop.exe.c:4247)
    await this.m_pSocket.ConnectToCenter(
      cfg.GetAttribute("CenterIP"),
      cfg.GetNumAttribute("CenterPort"),
      SVRCLASS_SHOP,
      cfg.GetServerIdx(),
      // gameVersion/clientVersion default from S2S GAME_VERSION/CLIENT_VERSION
      // (FxShop.exe.c:4276 — [E2 7][E2 3])
    );
    console.log("[Shop] Connection to Center Server established");
  }

  SendPacket(packet: CSendPacket): void {
    this.m_pSocket.SendToCenter(packet);
  }

  /** Port-side destruction of the owned center transport. */
  Stop(): void {
    this.m_pSocket.hooks.onClose = () => {};
    this.m_pSocket.Close();
    if (CCenterProcess.ms_pInstance === this) CCenterProcess.ms_pInstance = null;
  }

  /** CCenterProcess::SendAuthenCode — center MC 9 [E4 serial][E1 code]. */
  SendAuthenCode(serial: number, code: number): void {
    const p = new CSendPacket(MC_ShopServerSendPacket.SendAuthenCode);
    p.Encode4(serial);
    p.Encode1(code);
    this.SendPacket(p);
  }

  /** CCenterProcess::OnPacket — the CM dispatch (1/2/6/8/12/14). */
  OnPacket(n: CReceivedPacket): void {
    switch (n.Decode1()) {
      case CM_ShopServerPacket.OnCenterResConnectToSvr:
        DispatchShopConnectResponse(n);
        return;
      case CM_ShopServerPacket.OnCenterResConnEstablished:
        DispatchShopEstablishedResponse(n);
        return;
      case CM_ShopServerPacket.OnShopServerInfo:
        this.OnShopServerInfo(n);
        return;
      case CM_ShopServerPacket.OnAdminNotifyMsg:
        this.OnAdminNotifyMsg(n);
        return;
      case CM_ShopServerPacket.OnInitialSvrAttr:
        CMainSystem.ms_pInstance?.OnInitialSvrAttr(n);
        return;
      case CM_ShopServerPacket.OnItemDBInit:
        this.OnUpdateTable(n);
        return;
      default:
        return;
    }
  }

  /** CCenterProcess::OnShopServerInfo — CM 6 [E4 n][n×(E4 ip, E2 port)]: the
   *  whole local-server list (this+280 ips, this+4376 ports, count +1606). */
  OnShopServerInfo(n: CReceivedPacket): void {
    const count = n.Decode4();
    this.m_anSvrIP = [];
    this.m_anSvrPort = [];
    for (let i = 0; i < count; i++) {
      this.m_anSvrIP.push(n.Decode4());
      this.m_anSvrPort.push(n.Decode2());
    }
    this.m_nSvrCount = count;
  }

  m_anSvrIP: number[] = [];
  m_anSvrPort: number[] = [];
  m_nSvrCount = 0;

  /** CCenterProcess::OnAdminNotifyMsg — CM 8 [EStr] → broadcast client 26. */
  OnAdminNotifyMsg(n: CReceivedPacket): void {
    const str = n.DecodeStr();
    const p = new CSendPacket(SC_SendPacket.OnAdminNotifyMsg, CipherDegree.kPacketEncryptedCRC8);
    p.EncodeStr(str);
    const pool = GetShopMainPool();
    if (pool) CUserPool.SendAll(CUserPool.CreateSocketList(pool), p);
  }

  /**
   * CCenterProcess::OnItemDBInit — CM 14 (FxShop.exe.c:4365): the packet has
   * NO body (the center's CLocalServerMan::OnSystemCmd sends a bare
   * CSendPacket(14) for "UpdateFxItem") and reloads ALL five tables in the
   * decompiled order; return values are ignored.
   */
  OnUpdateTable(_n: CReceivedPacket): void {
    const itemMan = CItemMan.ms_pInstance!;
    const db = this.db;
    itemMan.UpdateUserItemTable(db);
    itemMan.UpdateStringTable(db);
    itemMan.UpdateShopItemTable(db);
    itemMan.UpdateCouponMapTable(db);
    itemMan.UpdatePackageMapTable(db);
  }
}
