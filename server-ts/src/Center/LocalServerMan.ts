/** Native source unit: CX/CxCenter/LocalServerMan.cpp. */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { CServerConfig } from "../core/ServerConfig.ts";
import { CReceivedPacket, CSendPacket } from "../core/Packet.ts";
import {
  CM_ReceivedPacket,
  SVRCLASS_GAME,
  SVRCLASS_LOGIN,
  SVRCLASS_SHOP,
  SVRCLASS_UTIL,
} from "../protocol/CenterProtocol.ts";
import { CGlobalUserTable } from "./GlobalUserTable.ts";
import { CLocalServer } from "./LocalServer.ts";
import { CLoginServer } from "./LoginServer.ts";
import { CGameServer } from "./GameServer.ts";
import { CShopServer } from "./ShopServer.ts";
import { CUtilServer } from "./UtilServer.ts";
import { CLocalSocket } from "./LocalSocket.ts";
import { IpToU32 } from "./NetworkAddress.ts";
import { SERVER_STATE_BROADCAST_BATCH_SIZE } from "./Defs.ts";

const USER_COUNT_GROUP_SIZE = 5;
const USER_COUNT_LINE_SIZE = 10;

export class CLocalServerMan {
  cfg: CServerConfig;
  servers: CLocalServer[] = [];
  readonly globalUserTable: CGlobalUserTable;
  /** Per-GS-class live connection count / versions (CLocalServerMan +52/+64/+76). */
  m_mapConnNo = new Map<number, number>();
  m_mapGameVersion = new Map<number, number>();
  m_mapClientVersion = new Map<number, number>();

  constructor(cfg: CServerConfig) {
    this.cfg = cfg;
    this.globalUserTable = new CGlobalUserTable(this);
  }

  GetGameDomain(): number {
    return this.cfg.GetNumAttribute("GameDomain");
  }
  GetGameShopAttribute(): number {
    return this.cfg.GetNumAttribute("FXAttrShop") !== 0 ? 1 : 0;
  }

  GetSvrNo(nServerClass: number): number {
    switch (nServerClass) {
      case SVRCLASS_LOGIN:
        return this.cfg.GetNumAttribute("LSNumber");
      case SVRCLASS_GAME:
        return this.cfg.GetNumAttribute("FXGSNumber");
      case SVRCLASS_SHOP:
        return this.cfg.GetNumAttribute("FXSSNumber");
      default:
        return this.cfg.GetNumAttribute("FXUSNumber");
    }
  }

  /** CLocalServerMan::Init — build the server table from the cfg. */
  Init(): void {
    const lsNo = this.cfg.GetNumAttribute("LSNumber");
    for (let i = 0; i < lsNo; i++)
      this.servers.push(
        new CLoginServer(`LoginSvr${i}`, SVRCLASS_LOGIN, i, this.cfg.GetAttribute(`LSIP${i}`), this.cfg.GetNumAttribute(`LSPort${i}`)),
      );
    const gsNo = this.cfg.GetNumAttribute("FXGSNumber");
    for (let i = 0; i < gsNo; i++) {
      const gs = new CGameServer(
        this.cfg.GetAttribute(`FXGSName${i}`) || `GameSvr${i}`,
        SVRCLASS_GAME,
        i,
        this.cfg.GetAttribute(`FXGSIP${i}`),
        this.cfg.GetNumAttribute(`FXGSPort${i}`),
      );
      gs.m_nMaxUser = this.cfg.GetNumAttribute(`FXGSMaxUser${i}`);
      gs.nType = this.cfg.GetNumAttribute(`FXGSType${i}`);
      gs.nCommunity = this.cfg.GetNumAttribute(`FXGSCommunity${i}`) & 0xff;
      gs.nFXAttrShopFlag = this.cfg.GetNumAttribute("FXAttrShop") !== 0 ? 1 : 0;
      gs.nEnterableType = this.cfg.GetNumAttribute(`FXGSEnterableType${i}`);
      this.servers.push(gs);
    }
    const ssNo = this.cfg.GetNumAttribute("FXSSNumber");
    for (let i = 0; i < ssNo; i++)
      this.servers.push(
        new CShopServer(`ShopSvr${i}`, SVRCLASS_SHOP, i, this.cfg.GetAttribute(`FXSSIP${i}`), this.cfg.GetNumAttribute(`FXSSPort${i}`)),
      );
    const usNo = this.cfg.GetNumAttribute("FXUSNumber");
    for (let i = 0; i < usNo; i++)
      this.servers.push(
        new CUtilServer(`UtilSvr${i}`, SVRCLASS_UTIL, i, this.cfg.GetAttribute(`FXUSIP${i}`), this.cfg.GetNumAttribute(`FXUSPort${i}`)),
      );
  }

  GetSvr(nServerClass: number, nSvrIdx: number): CLocalServer | null {
    return this.servers.find((s) => s.nServerClass === nServerClass && s.nSvrIdx === nSvrIdx) ?? null;
  }

  /**
   * CLocalServerMan::GetSmallLoadedSvrIdx (0040B020, CxCenter.exe.c:11735).
   * Static round-robin counter dword_481088. If the candidate shop server
   * has a connected socket, return candidate. Otherwise fallback to the
   * connected shop server with minimum nConnNo (< 2000). Returns 0 if none active.
   */
  private m_dwSmallLoadedSvrIdx = 0;

  GetSmallLoadedSvrIdx(nServerClass: number): number {
    if (nServerClass !== SVRCLASS_SHOP) return -1;
    const shopServers = this.servers.filter((s) => s.nServerClass === SVRCLASS_SHOP);
    const count = shopServers.length;
    if (count <= 0) return 0;

    this.m_dwSmallLoadedSvrIdx = (this.m_dwSmallLoadedSvrIdx + 1) | 0;
    // 32-bit signed modulo matching native cdq; idiv edi
    const candidateIdx = ((this.m_dwSmallLoadedSvrIdx % count) + count) % count;
    const candidate = shopServers[candidateIdx];
    if (candidate && candidate.socket !== null) {
      return candidate.nSvrIdx;
    }

    let minConnNo = 2000;
    let selectedIdx = 0;
    for (const svr of shopServers) {
      if (svr.socket !== null && svr.nConnNo < minConnNo) {
        minConnNo = svr.nConnNo;
        selectedIdx = svr.nSvrIdx;
      }
    }
    return selectedIdx;
  }

  /**
   * CLocalServerMan::OnConnEstablished continuation (CxCenter.exe.c:14420).
   * Greeting + identification have already been exchanged on the socket.
   */
  RegisterLocalServer(sock: CLocalSocket, nServerClass: number, nSvrIdx: number, nGameVersion: number, nClientVersion: number): void {
    const addr = sock.bunSocket?.remoteAddress ?? "";
    const expected = this.GetSvr(nServerClass, nSvrIdx);
    if (!expected) {
      console.error(`[Center] Invalid Local server ID[${nSvrIdx}] from host[${addr}]`);
      sock.Close();
      return;
    }
    if (expected.socket) {
      console.error(`[Center] Local server(ID:${nSvrIdx}) already attached, connection closed[${addr}]`);
      sock.Close();
      return;
    }
    if (expected.strIP !== addr) {
      console.error(`[Center] Incorrect host try to attach(ID:${nSvrIdx}, IP:${addr})`);
      sock.Close();
      return;
    }
    sock.owner = expected;
    expected.socket = sock;
    // vtbl+20 (SendInitialAttr) runs for every class after AttachSocket;
    // the login server has no override, and the base thunk is a bare `retn`
    // (CxCenter.exe.lst:409AF0), so only game/FXSS/util get CM 12.
    expected.SendInitialAttr(this);
    if (nServerClass === SVRCLASS_GAME) {
      // Version bookkeeping is keyed by the server class (map@+52/+64/+76).
      const connNo = (this.m_mapConnNo.get(nServerClass) ?? 0) + 1;
      this.m_mapConnNo.set(nServerClass, connNo);
      const known = this.m_mapGameVersion.get(nServerClass) ?? 0;
      if (nGameVersion <= known) {
        if (nGameVersion < known)
          console.error(`[Center] Illegal Game Version(${nServerClass} v${nGameVersion} < v${known})`);
        this.SendLocalSvrGameStatePacket(null);
      } else {
        this.m_mapGameVersion.set(nServerClass, nGameVersion);
        this.m_mapClientVersion.set(nServerClass, nClientVersion);
        console.log(`[Center] Game Version Update(${nServerClass} v${nGameVersion} cv${nClientVersion})`);
        this.SendLocalSvrGameStatePacket(null);
      }
    } else {
      this.SendLocalSvrGameStatePacket(sock);
    }
    this.globalUserTable.DeleteAllUserOnSvr(nServerClass, nSvrIdx);
    if (nServerClass === SVRCLASS_SHOP) {
      this.SendShopSvrInfoPacket(nServerClass, nSvrIdx);
    } else {
      this.SendLocalSvrInfoPacket(nServerClass, nSvrIdx);
      this.SendLocalSvrStatePacket(1);
    }
    console.log(`[Center] Local server connected successfully(${expected.m_strName}:${addr})`);
  }

  /** CLocalServerMan::SendLocalSvrGameStatePacket — packet 5 (CxCenter.exe.c:14107).
   *  The type vector holds one entry per configured game server, keyed by the
   *  server class (10); the connection-count/version maps are class keyed too. */
  SendLocalSvrGameStatePacket(sock: CLocalSocket | null): void {
    const gsServers = this.servers.filter((s) => s.nServerClass === SVRCLASS_GAME);
    const packet = new CSendPacket(CM_ReceivedPacket.OnLocalGameState);
    packet.Encode1(gsServers.length);
    for (const _gs of gsServers) {
      const cls = SVRCLASS_GAME;
      packet.Encode1(cls);
      packet.Encode1((this.m_mapConnNo.get(cls) ?? 0) !== 0 ? 1 : 0);
      packet.Encode2(this.m_mapGameVersion.get(cls) ?? 0);
      packet.Encode2(this.m_mapClientVersion.get(cls) ?? 0);
    }
    if (sock) sock.SendPacket(packet);
    else this.SendPacketToAllLoginAndGameSvr(packet);
  }

  /** CLocalServerMan::SendLocalSvrInfoPacket — packet 3 (CxCenter.exe.c:13249). */
  SendLocalSvrInfoPacket(nServerClass: number, nSvrIdx: number): void {
    const packet = new CSendPacket(CM_ReceivedPacket.OnLocalServerInfo);
    const gsServers = this.servers.filter((s) => s.nServerClass === SVRCLASS_GAME);
    packet.Encode4(gsServers.length);
    for (const gs of gsServers) {
      packet.EncodeStr(gs.m_strName);
      packet.Encode4(gs.m_nMaxUser);
      packet.Encode1(gs.nType);
      packet.Encode1(gs.nServerClass);
      // the word at +96: community in the low byte, the FXAttrShop flag in
      // the high one (CGameServer::Init ors bit0 of +97 when cfg FXAttrShop)
      packet.Encode2((gs.nCommunity & 0xff) | ((gs.nFXAttrShopFlag & 1) << 8));
      packet.Encode1(gs.nEnterableType);
    }
    const svr = this.GetSvr(nServerClass, nSvrIdx);
    svr?.socket?.SendPacket(packet);
  }

  /** CLocalServerMan::SendShopSvrInfoPacket (CxCenter.exe.c:11832) — packet 6,
   *  ONLY for the shop-class link: [E4 totalServers][per server: E4 ip][E2 port].
   *  The list covers every configured local server (entry stride 96: +56 ip,
   *  +60 port), not just the live ones. */
  SendShopSvrInfoPacket(_nServerClass: number, _nSvrIdx: number): void {
    // CLocalServerMan::SendShopSvrInfoPacket (CxCenter.exe.c:11832): the FXSS
    // table only (count = FXSSNumber; entries stride 96: +56 ip E4, +60 port
    // E2) - the login/game/util servers are NOT in this list.
    const shopServers = this.servers.filter((s) => s.nServerClass === SVRCLASS_SHOP);
    const packet = new CSendPacket(CM_ReceivedPacket.OnShopServerInfo);
    packet.Encode4(shopServers.length);
    for (const svr of shopServers) {
      packet.Encode4(IpToU32(svr.strIP));
      packet.Encode2(svr.nPort);
    }
    const shop = this.GetSvr(SVRCLASS_SHOP, _nSvrIdx);
    shop?.socket?.SendPacket(packet);
  }

  /** CLocalServerMan::SendLocalSvrStatePacket — packet 4 (CxCenter.exe.c:12304). */
  /** CLocalServerMan::SendLocalSvrStatePacket (CxCenter.exe.c:12304) —
   *  [E4 FXGSNumber][per GS: nConnNo or -1].  fRegister!=0 (the register
   *  path) broadcasts to every connected LS+GS; fRegister==0 (CTimerThread)
   *  sends to at most 10 connected LS+GS per call through a rotating
   *  cursor (dword_48108C). */
  m_nStateRotate = 0;

  SendLocalSvrStatePacket(fRegister: number): void {
    const packet = new CSendPacket(CM_ReceivedPacket.OnLocalServerState);
    const gsServers = this.servers.filter((s) => s.nServerClass === SVRCLASS_GAME);
    packet.Encode4(gsServers.length);
    for (const gs of gsServers) packet.Encode4(gs.socket ? gs.nConnNo : -1);
    if (fRegister !== 0) {
      this.SendPacketToAllLoginAndGameSvr(packet);
      return;
    }
    const targets = this.servers.filter(
      (s) => (s.nServerClass === SVRCLASS_LOGIN || s.nServerClass === SVRCLASS_GAME) && s.socket,
    );
    const n = targets.length;
    if (n === 0) return;
    let i = this.m_nStateRotate % n;
    for (let sent = 0; sent < SERVER_STATE_BROADCAST_BATCH_SIZE && sent < n; sent++) {
      targets[i]!.socket!.SendPacket(packet);
      i = (i + 1) % n;
    }
    this.m_nStateRotate = i;
  }

  /** CLocalServerMan::MakeUserCountLog. */
  MakeUserCountLog(): number {
    const now = new Date();
    const stamp = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
    console.log(`[Center] [${stamp}] Current(${this.globalUserTable.GetTotalSize()}), Peak(${this.globalUserTable.GetTotalPeakSize()})`);
    return 1;
  }

  /** CLocalServerMan::MakeUserCountHTML. */
  MakeUserCountHTML(): number {
    const now = new Date();
    const day = now.toLocaleDateString("en-US", { weekday: "short" });
    const stamp = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")} (${day}) ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const loginServers = this.servers.filter((server) => server.nServerClass === SVRCLASS_LOGIN);
    const counts = loginServers.map((server, index) => {
      const next = index + 1;
      let separator = ",";
      if (next === loginServers.length) separator = "";
      else if (next % USER_COUNT_LINE_SIZE === 0) separator = "/";
      else if (next % USER_COUNT_GROUP_SIZE === 0) separator = ":";
      return `${server.nConnNo}${separator}`;
    }).join("");
    const html = `<html>\n<head>\n<style>\nbody { font-size:10pt; }\n</style>\n</head>\n<body>\n<h2>BnB Server Information</h2>\n<hr noshade size=1 width=500 align=left>\n<blockquote>\n${stamp} CA:${this.globalUserTable.GetTotalSize()} (${counts})</blockquote>\n<hr noshade size=1 width=500 align=left>\n<p>\n</body></html>`;
    const logDir = this.cfg.GetAttribute("WebLogDir") || join(import.meta.dir, "..", "..", "Log");
    mkdirSync(logDir, { recursive: true });
    const tmpPath = join(logDir, "tmp_html.txt");
    try {
      writeFileSync(tmpPath, html);
    } catch {
      return 0;
    }
    const target = this.cfg.GetAttribute("WebLog");
    if (target !== "") {
      try {
        copyFileSync(tmpPath, target);
      } catch {
        // Native CopyFile failure is ignored after the temporary file succeeds.
      }
    }
    return 1;
  }

  /** CLocalServerMan::SendPacketToAllLoginAndGameSvr */
  SendPacketToAllLoginAndGameSvr(packet: CSendPacket): void {
    for (const s of this.servers) {
      if ((s.nServerClass === SVRCLASS_LOGIN || s.nServerClass === SVRCLASS_GAME) && s.socket)
        s.socket.SendPacket(packet);
    }
  }

  SendPacketServerType(nServerClass: number, packet: CSendPacket): void {
    for (const s of this.servers) if (s.nServerClass === nServerClass && s.socket) s.socket.SendPacket(packet);
    console.log(`[Center] sent packet ${packet.m_nPacketType} to ${nServerClass}-type servers.`); // CxCenter.exe.c:12015
  }

  /**
   * CLocalServerMan::OnAdminNotifyMsg (CxCenter.exe.c:11182) — CM 8 [EStr]
   * to every connected login, game and shop server, one count Report per
   * family (:11227/:11251/:11275).
   */
  OnAdminNotifyMsg(n: CReceivedPacket): void {
    const str = n.DecodeStr();
    const packet = new CSendPacket(CM_ReceivedPacket.OnAdminNotifyMsg);
    packet.EncodeStr(str);
    const families: [number, string][] = [
      [SVRCLASS_LOGIN, "LoginServers"],
      [SVRCLASS_GAME, "FxGameServers"],
      [SVRCLASS_SHOP, "FxShopServers"],
    ];
    for (const [serverClass, label] of families) {
      let count = 0;
      for (const s of this.servers) {
        if (s.nServerClass === serverClass && s.socket) {
          s.socket.SendPacket(packet);
          count++;
        }
      }
      console.log(`[Center] sent kmcAdminNotifyMsg to ${label} - count : ${count}`);
    }
  }

  /**
   * CLocalServerMan::OnSystemMsg (CxCenter.exe.c:11281) — CM 13 [EStr] to
   * every connected login, game and shop server.
   */
  OnSystemMsg(n: CReceivedPacket): void {
    const str = n.DecodeStr();
    const packet = new CSendPacket(CM_ReceivedPacket.OnSystemMsg);
    packet.EncodeStr(str);
    this.SendPacketToLoginGameShop(packet);
  }

  /**
   * CLocalServerMan::OnSystemCmd (CxCenter.exe.c:11925) — the first 12 bytes
   * compared case-insensitively against "UpdateFxItem"; on a match an EMPTY
   * CM 14 goes to the game + shop lists, otherwise nothing is sent.
   */
  OnSystemCmd(n: CReceivedPacket): void {
    const str = n.DecodeStr();
    if (!str.toLowerCase().startsWith("updatefxitem")) return;
    const packet = new CSendPacket(CM_ReceivedPacket.OnItemDBInit);
    this.SendPacketGameShop(packet);
  }

  /** The LS + GS + SHOP connected sockets (the CM 8/13 audience). */
  SendPacketToLoginGameShop(packet: CSendPacket): void {
    for (const s of this.servers) {
      if (s.nServerClass !== SVRCLASS_UTIL && s.socket) s.socket.SendPacket(packet);
    }
  }

  /** The GS + SHOP connected sockets (the CM 14 audience). */
  SendPacketGameShop(packet: CSendPacket): void {
    for (const s of this.servers) {
      if ((s.nServerClass === SVRCLASS_GAME || s.nServerClass === SVRCLASS_SHOP) && s.socket)
        s.socket.SendPacket(packet);
    }
  }

  /** CLocalServerMan::OnDisconnect (CxCenter.exe.c:14489). */
  OnDisconnect(sock: CLocalSocket): void {
    const owner = sock.owner;
    if (!owner) {
      console.error(`[Center] Local server[${sock.bunSocket?.remoteAddress ?? ""}] disconnected while identifying`);
      return;
    }
    console.log(`[Center] End of file, close connection(${owner.m_strName}:${owner.strIP})`);
    owner.socket = null;
    if (this.m_mapConnNo.has(owner.nServerClass)) {
      this.m_mapConnNo.set(owner.nServerClass, (this.m_mapConnNo.get(owner.nServerClass) ?? 1) - 1);
      this.SendLocalSvrGameStatePacket(null);
    }
    this.globalUserTable.DeleteAllUserOnSvr(owner.nServerClass, owner.nSvrIdx);
  }

}
