/**
 * CxCenter — the central hub (port 2828).
 *
 * Responsibilities (CxCenter.exe.c):
 *  - accept the local servers (LS/GS/Shop/Util), validate their IP against the
 *    configured lists and exchange the 4-byte version greeting + 9-byte
 *    identification (CLocalServerMan::OnConnEstablished);
 *  - CGlobalUserTable: every logged-in user of the whole service, used for
 *    double-login prevention, connect-to-server brokering and authen codes;
 *  - fan-out of channel lists / states / system messages;
 *  - CMonitorSocket: the operator console.
 *
 * CAuthenThread (the external Nexon billing authen service) is not part of the
 * six-server suite, so every authen-deferred path resolves immediately, exactly
 * like the original behaves when the billing service is absent.
 */
import { CServerConfig } from "../core/Config.ts";
import { CPacketSocket } from "../core/CPacketSocket.ts";
import { CReceivedPacket, CSendPacket } from "../core/Packet.ts";
import {
  CM_ReceivedPacket,
  MC_ReceivedPacket,
  SVRCLASS_GAME,
  SVRCLASS_LOGIN,
  SVRCLASS_SHOP,
  SVRCLASS_UTIL,
  CENTER_VERSION,
} from "../lib/S2S.ts";
import { MONITOR_ReceivedPacket } from "../lib/PacketIDs.ts";

export function IpToU32(ip: string): number {
  const parts = ip.split(".").map((x) => Number.parseInt(x, 10) & 0xff);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return 0;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

export function U32ToIp(v: number): string {
  return `${(v >>> 24) & 0xff}.${(v >>> 16) & 0xff}.${(v >>> 8) & 0xff}.${v & 0xff}`;
}

/** CGlobalUserTable entry (CUser of CxCenter, 0x74 bytes). */
export class CUser {
  strName: string;
  nServerClass: number;
  nSvrIdx: number;
  nSN: number; // +28 (v16[7]): the DB SN forwarded from the login server
  nAuthencode = 0; // CUser::GetAuthencode / SetAuthenCode
  nLocalSerialNo: number; // the LS socket's local serial (p0 tail)
  nConnStamp: number; // p0 head (the LS socket's address stamp)
  fSimpleInfoModified = 0; // +56: premium-ticket flag from the LS
  nCommunitySvr = 0; // +76 (byte)
  nChannel: number; // +60 (byte): the server class the user currently sits on
  nSessionIdx = 0; // +64: the session slot on that server (0 = none)
  nConnectStamp = 0; // +72 (GetTickCount at SetConnectingToSvr)
  fFree = 0; // +20 (CSafeObject: freed by SetFree)
  fConnectionEstablished = 0;
  nConnectingType = -1;
  nConnectingIdx = -1;

  constructor(
    strName: string,
    nServerClass: number,
    nSvrIdx: number,
    nSN: number,
    nLocalSerialNo: number,
    nConnStamp: number,
  ) {
    this.strName = strName;
    this.nServerClass = nServerClass;
    this.nSvrIdx = nSvrIdx;
    this.nSN = nSN;
    this.nLocalSerialNo = nLocalSerialNo;
    this.nConnStamp = nConnStamp;
    this.nChannel = nServerClass; // CUser::SetSvrIdx at construction
  }

  GetAuthencode(): number {
    return this.nAuthencode;
  }

  /** CUser::SetAuthenCode */
  SetAuthenCode(a2: number): void {
    if (this.nAuthencode !== 1) this.nAuthencode = a2;
  }

  /**
   * CUser::CheckConnectingToSvr (CxCenter.exe.c:4151B0) — fails on a second
   * request while still connecting, on re-entering the currently attached
   * server, on unregistered types and on shutdown targets; the
   * enterable-type-41 premium branch (authencode != 1) answers 2.
   */
  CheckConnectingToSvr(nServerType: number, SmallLoadedSvrIdx: number): number {
    if (this.fFree !== 0) return 0; // Set-freed user
    if (this.nConnectingType !== -1) return 0; // "connect twice"
    if (this.nSvrIdx === SmallLoadedSvrIdx && this.nChannel === nServerType) return 0; // same server again
    if (nServerType !== SVRCLASS_LOGIN && nServerType !== SVRCLASS_GAME && nServerType !== SVRCLASS_SHOP) return 0;
    return 1;
  }

  /** CUser::SetConnectingToSvr (CUser::SetSvrIdx moves the user + the conn counters). */
  SetConnectingToSvr(nServerType: number, SmallLoadedSvrIdx: number, man: CxCenter): void {
    const oldSvr = man.GetSvr(this.nChannel, this.nSvrIdx);
    if (oldSvr) oldSvr.nConnNo--; // CLocalServer::DecConn
    this.nConnectingType = nServerType;
    this.nConnectingIdx = SmallLoadedSvrIdx;
    this.nChannel = nServerType;
    this.nSvrIdx = SmallLoadedSvrIdx;
    const newSvr = man.GetSvr(nServerType, SmallLoadedSvrIdx);
    if (newSvr) newSvr.nConnNo++; // CLocalServer::IncConn
    this.nConnectStamp = Date.now() & 0x7fffffff;
  }

  /** CUser::CheckConnectionEstablished — the connecting state must match. */
  CheckConnectionEstablished(nServerType: number, SmallLoadedSvrIdx: number): number {
    if (this.fFree !== 0) return 0;
    if (this.nConnectingType !== -1 && this.nConnectingType === nServerType && this.nConnectingIdx === SmallLoadedSvrIdx) {
      return 1;
    }
    return 0;
  }

  /** CUser::SetConnectionEstablished — clears the connecting state (+68). */
  SetConnectionEstablished(): void {
    this.nConnectingType = -1;
    this.nConnectingIdx = -1;
  }

  /** CUser::DeferDisconnectTimeout — 0x445C ms without the established call. */
  DeferDisconnectTimeout(man: CxCenter): boolean {
    if (this.nConnectingType === -1) return false;
    if ((Date.now() & 0x7fffffff) - this.nConnectStamp > 0x445c) {
      this.SetFree(man);
      return true;
    }
    return false;
  }

  /** CUser::SetFree */
  SetFree(man: CxCenter): void {
    if (this.fFree === 0) {
      this.fFree = 1;
      const svr = man.GetSvr(this.nChannel, this.nSvrIdx);
      if (svr) svr.nConnNo--; // CLocalServer::DecConn
      this.nSvrIdx = -0x80000000;
    }
  }
}

/** One attached local server (CLocalServer, 100 bytes, on the center side). */
export class CLocalServer {
  strName: string;
  nServerClass: number; // +20
  nSvrIdx: number; // +28
  strIP: string;
  nPort: number;
  nType = 0; // +32 : cfg FXGSType
  nCommunity = 0; // +96 (u16) : cfg FXGSCommunity
  nEnterableType = 0; // +98 : cfg FXGSEnterableType
  nConnNo = 0; // +48 : connected user count (IncConn / DecConn)
  socket: CenterClientSocket | null = null; // +52

  constructor(strName: string, nServerClass: number, nSvrIdx: number, strIP: string, nPort: number) {
    this.strName = strName;
    this.nServerClass = nServerClass;
    this.nSvrIdx = nSvrIdx;
    this.strIP = strIP;
    this.nPort = nPort;
  }
}

/**
 * CxCenter.exe.c:14833 — accepted local sockets take a global counter as
 * their header type (dword_481090 & 0x8000000F).  Until the first framed
 * packet from the server derives the real shared type, sends convert through
 * whatever row the counter gives — exactly like the original.
 */
let ms_nLocalSocketHeaderTypeCounter = 0;

/** Center-side socket for one attached local server. */
export class CenterClientSocket extends CPacketSocket {
  owner: CLocalServer | null = null;
  private pending = new Uint8Array(0);
  private fGreeted = false;
  private fIdentified = false;

  constructor(private center: CxCenter) {
    super(CPacketSocket.dwRcvBufferSize, CPacketSocket.dwSndBufferSize, {
      onPacket: (sock, packet) => center.OnLocalPacket(sock as CenterClientSocket, packet),
      onClose: (sock) => center.OnLocalDisconnect(sock as CenterClientSocket),
    });
    // CServerSocket on the center side (CxCenter.exe.c:14833): mirrors CLocalSocket.
    this.SetHeaderType(ms_nLocalSocketHeaderTypeCounter++ & 0x8000000f);
    this.SetHeaderCode(189, 96, 231);
    this.SetSequence(40, 40, 0, 0);
  }

  /** CLocalServerMan::OnConnEstablished — the greeting goes out on accept. */
  SendGreeting(): void {
    if (this.fGreeted) return;
    // CxCenter.exe.c:14324: Encode2(3 /* version */); Encode2(sd);
    const greeting = new Uint8Array(4);
    greeting[0] = (CENTER_VERSION >>> 8) & 0xff;
    greeting[1] = CENTER_VERSION & 0xff;
    const sd = (this.bunSocket?.localPort ?? 0) & 0xffff;
    greeting[2] = (sd >>> 8) & 0xff;
    greeting[3] = sd & 0xff;
    this.bunSocket?.write(greeting);
    this.fGreeted = true;
  }

  OnData(data: Uint8Array): void {
    this.SendGreeting();
    if (this.fIdentified) {
      this.OnReceive(data);
      return;
    }
    const all = new Uint8Array(this.pending.length + data.length);
    all.set(this.pending);
    all.set(data, this.pending.length);
    if (all.length < 9) {
      this.pending = all;
      return;
    }
    this.pending = new Uint8Array(0);
    this.fIdentified = true;
    const nServerClass = all[0]!;
    const idxX = (all[1]! | (all[2]! << 8) | (all[3]! << 16) | (all[4]! << 24)) >>> 0;
    const nSvrIdx = (idxX ^ 0x77) >>> 0;
    const nGameVersion = all[5]! | (all[6]! << 8);
    const nClientVersion = all[7]! | (all[8]! << 8);
    this.center.RegisterLocalServer(this, nServerClass, nSvrIdx, nGameVersion, nClientVersion);
    if (all.length > 9) this.OnReceive(all.subarray(9));
  }

  PostClosePacket(): void {
    this.Close();
  }
}

export class CxCenter {
  cfg: CServerConfig;
  servers: CLocalServer[] = [];
  userTable = new Map<string, CUser>(); // CGlobalUserTable (name keyed)
  serialTable = new Map<number, CUser>(); // SN keyed
  nMaxUser = 0;
  /** Per-GS-class live connection count / versions (CLocalServerMan +52/+64/+76). */
  m_mapConnNo = new Map<number, number>();
  m_mapGameVersion = new Map<number, number>();
  m_mapClientVersion = new Map<number, number>();
  private listenServer: Bun.TCPSocketListener | null = null;
  private monitorSockets = new Set<MonitorSocket>();
  private clientSockets = new WeakMap<object, CenterClientSocket>();
  private monitorBySock = new WeakMap<object, MonitorSocket>();

  constructor(cfg: CServerConfig) {
    this.cfg = cfg;
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
  InitServerTable(): void {
    const lsNo = this.cfg.GetNumAttribute("LSNumber");
    for (let i = 0; i < lsNo; i++)
      this.servers.push(
        new CLocalServer(`LoginSvr${i}`, SVRCLASS_LOGIN, i, this.cfg.GetAttribute(`LSIP${i}`), this.cfg.GetNumAttribute(`LSPort${i}`)),
      );
    const gsNo = this.cfg.GetNumAttribute("FXGSNumber");
    for (let i = 0; i < gsNo; i++) {
      const gs = new CLocalServer(
        this.cfg.GetAttribute(`FXGSName${i}`) || `GameSvr${i}`,
        SVRCLASS_GAME,
        i,
        this.cfg.GetAttribute(`FXGSIP${i}`),
        this.cfg.GetNumAttribute(`FXGSPort${i}`),
      );
      gs.nType = this.cfg.GetNumAttribute(`FXGSType${i}`);
      gs.nCommunity = this.cfg.GetNumAttribute(`FXGSCommunity${i}`) & 0xffff;
      gs.nEnterableType = this.cfg.GetNumAttribute(`FXGSEnterableType${i}`);
      this.servers.push(gs);
    }
    const ssNo = this.cfg.GetNumAttribute("FXSSNumber");
    for (let i = 0; i < ssNo; i++)
      this.servers.push(
        new CLocalServer(`ShopSvr${i}`, SVRCLASS_SHOP, i, this.cfg.GetAttribute(`FXSSIP${i}`), this.cfg.GetNumAttribute(`FXSSPort${i}`)),
      );
    const usNo = this.cfg.GetNumAttribute("FXUSNumber");
    for (let i = 0; i < usNo; i++)
      this.servers.push(
        new CLocalServer(`UtilSvr${i}`, SVRCLASS_UTIL, i, this.cfg.GetAttribute(`FXUSIP${i}`), this.cfg.GetNumAttribute(`FXUSPort${i}`)),
      );
  }

  GetSvr(nServerClass: number, nSvrIdx: number): CLocalServer | null {
    return this.servers.find((s) => s.nServerClass === nServerClass && s.nSvrIdx === nSvrIdx) ?? null;
  }

  /** CLocalServerMan::GetSmallLoadedSvrIdx */
  GetSmallLoadedSvrIdx(nServerClass: number): number {
    let best: CLocalServer | null = null;
    for (const s of this.servers) {
      if (s.nServerClass !== nServerClass) continue;
      if (!best || s.nConnNo < best.nConnNo) best = s;
    }
    return best ? best.nSvrIdx : 0;
  }

  async Listen(): Promise<void> {
    const port = this.cfg.GetNumAttribute("CenterPort") || 2828;
    this.listenServer = Bun.listen({
      hostname: "0.0.0.0",
      port,
      socket: {
        open: (t) => {
          const sock = new CenterClientSocket(this);
          this.clientSockets.set(t, sock);
          sock.bunSocket = t as Bun.Socket<any>;
          sock.m_bConnected = true;
          sock.SendGreeting();
        },
        data: (t, data) => {
          this.clientSockets.get(t)?.OnData(new Uint8Array(data as Buffer));
        },
        close: (t) => {
          this.clientSockets.get(t)?.Close();
        },
        error: (_t, err) => console.error(`[Center] ${String(err)}`),
      },
    });
    console.log(`[Center] listening on :${port}`);
  }

  /**
   * CLocalServerMan::OnConnEstablished continuation (CxCenter.exe.c:14420).
   * Greeting + identification have already been exchanged on the socket.
   */
  RegisterLocalServer(sock: CenterClientSocket, nServerClass: number, nSvrIdx: number, nGameVersion: number, nClientVersion: number): void {
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
    if (nServerClass === SVRCLASS_GAME) {
      // CGameServer::SendInitialAttr — [E1 GameDomain][E1 FXAttrShop?1:0]
      this.SendInitialAttr(sock);
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
    this.DeleteAllUserOnSvr(nServerClass, nSvrIdx);
    if (nServerClass === SVRCLASS_SHOP) {
      this.SendShopSvrInfoPacket(nServerClass, nSvrIdx);
    } else {
      this.SendLocalSvrInfoPacket(nServerClass, nSvrIdx);
      this.SendLocalSvrStatePacket(1);
    }
    console.log(`[Center] Local server connected successfully(${expected.strName}:${addr})`);
  }

  /** CGlobalUserTable::DeleteAllUserOnSvr */
  DeleteAllUserOnSvr(nServerClass: number, nSvrIdx: number): void {
    for (const [name, u] of [...this.userTable]) {
      if (u.nServerClass === nServerClass && u.nSvrIdx === nSvrIdx) {
        this.serialTable.delete(u.nSN);
        this.userTable.delete(name);
      }
    }
  }

  /** CLocalServerMan::SendLocalSvrGameStatePacket — packet 5 (CxCenter.exe.c:14107).
   *  The type vector holds one entry per configured game server, keyed by the
   *  server class (10); the connection-count/version maps are class keyed too. */
  SendLocalSvrGameStatePacket(sock: CenterClientSocket | null): void {
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
      packet.EncodeStr(gs.strName);
      packet.Encode4(gs.nSvrIdx);
      packet.Encode1(gs.nType);
      packet.Encode1(gs.nServerClass);
      packet.Encode2(gs.nCommunity);
      packet.Encode1(gs.nEnterableType);
    }
    const svr = this.GetSvr(nServerClass, nSvrIdx);
    svr?.socket?.SendPacket(packet);
  }

  /** CLocalServerMan::SendShopSvrInfoPacket — the shop gets the same list. */
  SendShopSvrInfoPacket(nServerClass: number, nSvrIdx: number): void {
    this.SendLocalSvrInfoPacket(nServerClass, nSvrIdx);
  }

  /** CLocalServerMan::SendLocalSvrStatePacket — packet 4 (CxCenter.exe.c:12304). */
  SendLocalSvrStatePacket(a2: number): void {
    const packet = new CSendPacket(CM_ReceivedPacket.OnLocalServerState);
    const gsServers = this.servers.filter((s) => s.nServerClass === SVRCLASS_GAME);
    packet.Encode4(gsServers.length);
    for (const gs of gsServers) packet.Encode4(gs.socket ? gs.nConnNo : -1);
    if (a2 === 0) {
      const lsServers = this.servers.filter((s) => s.nServerClass === SVRCLASS_LOGIN);
      packet.Encode4(gsServers.length + lsServers.length);
      for (const ls of lsServers) packet.Encode4(ls.socket ? ls.nConnNo : -1);
      for (const gs of gsServers) packet.Encode4(gs.socket ? gs.nConnNo : -1);
    }
    this.SendPacketToAllLoginAndGameSvr(packet);
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
  }

  // ============================ packet dispatch ============================

  /** CGameServer::SendInitialAttr — packet 12 right after a GS attach. */
  SendInitialAttr(sock: CenterClientSocket): void {
    const packet = new CSendPacket(CM_ReceivedPacket.OnInitialSvrAttr);
    packet.Encode1(this.cfg.GetNumAttribute("GameDomain"));
    packet.Encode1(this.cfg.GetNumAttribute("FXAttrShop") === 1 ? 1 : 0);
    sock.SendPacket(packet);
  }

  /**
   * CGameServer::OnRequestUserChannel (CxCenter.exe.c:6508) — MC 7 from a GS:
   * [E1 type][E4 gSN][EStr name] → CM 10 [E1 type][E4 gSN][EStr name]
   * [E1 the user's current server class][E4 sessionIdx].
   */
  OnRequestUserChannel(owner: CLocalServer, n: CReceivedPacket): void {
    const type = n.Decode1();
    const gSN = n.Decode4();
    const name = n.DecodeStr();
    const user = this.userTable.get(name);
    const packet = new CSendPacket(CM_ReceivedPacket.OnUserChannelResult);
    packet.Encode1(type);
    packet.Encode4(gSN);
    packet.EncodeStr(name);
    if (user) {
      packet.Encode1(user.nChannel);
      packet.Encode4(user.nSessionIdx);
    } else {
      packet.Encode1(0);
      packet.Encode4(0);
    }
    owner.socket?.SendPacket(packet);
  }

  /** CLocalServer::OnPacket and friends (CxCenter.exe.c:10155+). */
  OnLocalPacket(sock: CenterClientSocket, n: CReceivedPacket): void {
    const owner = sock.owner;
    if (owner === null) return;
    const id = n.Decode1();
    switch (id) {
      case MC_ReceivedPacket.OnAddNewUser:
        if (owner.nServerClass === SVRCLASS_LOGIN) this.OnAddNewUser(owner, n);
        return;
      case MC_ReceivedPacket.OnDeleteUser:
        this.OnDeleteUser(owner, n);
        return;
      case MC_ReceivedPacket.OnReqConnectToSvr:
        this.OnReqConnectToSvr(owner, n);
        return;
      case MC_ReceivedPacket.OnConnEstablished:
        this.OnConnEstablished(owner, n);
        return;
      case MC_ReceivedPacket.OnAdminNotifyMsg:
        this.Forward(n, CM_ReceivedPacket.OnAdminNotifyMsg, false);
        return;
      case MC_ReceivedPacket.OnAdminNotifyGameServerMsg:
        this.Forward(n, MC_ReceivedPacket.OnAdminNotifyGameServerMsg, true); // forwarded with its own id (5)
        return;
      case MC_ReceivedPacket.OnSvrReservedMsg:
        // CGameServer::OnPacket routes 7 to OnRequestUserChannel; the other
        // classes treat it as the operator-only slot.
        if (owner.nServerClass === SVRCLASS_GAME) this.OnRequestUserChannel(owner, n);
        return;
      case MC_ReceivedPacket.OnSetAuthenCode:
        return; // billing-side; no CAuthenThread in this suite
      case MC_ReceivedPacket.OnSystemMsg:
        this.Forward(n, CM_ReceivedPacket.OnSystemMsg, false);
        return;
      case MC_ReceivedPacket.OnSystemCmd:
        this.Forward(n, MC_ReceivedPacket.OnSystemCmd, false); // forwarded with its own id (11)
        return;
      default:
        return;
    }
  }

  /**
   * CLoginServer::OnAddNewUser (center side, CxCenter.exe.c:15163).
   * Without CAuthenThread the deferred branch never runs — the immediate
   * response path below is the one the client observes.
   */
  OnAddNewUser(owner: CLocalServer, n: CReceivedPacket): void {
    const nConnStamp = n.Decode4();
    n.m_uOffset += 16; // machine id (DecodeBuffer into a scratch buffer)
    n.Decode4(); // game room code
    const count = n.Decode1();
    const users: CUser[] = [];
    let fAllAdded = 1;
    let fAllSimpleInfo = 1;
    for (let i = 0; i < count; i++) {
      const name = n.DecodeStr();
      const sn = n.Decode4();
      const fSimpleInfoModified = n.Decode1();
      const communitySvr = n.Decode1();
      const u = new CUser(name, SVRCLASS_LOGIN, owner.nSvrIdx, sn, 0, nConnStamp);
      if (fSimpleInfoModified !== 0) u.fSimpleInfoModified = 1;
      else fAllSimpleInfo = 0;
      u.nCommunitySvr = communitySvr;
      u.nLocalSerialNo = 0; // filled from the packet tail below
      if (!this.userTable.has(name)) {
        this.userTable.set(name, u);
        this.serialTable.set(sn, u);
      } else {
        fAllAdded = 0;
      }
      users.push(u);
    }
    const nb = n.Decode4();
    for (const u of users) u.nLocalSerialNo = nb;
    const packet = new CSendPacket(CM_ReceivedPacket.OnCenterResAddNewUser);
    packet.Encode4(nb);
    packet.Encode4(fAllAdded);
    packet.Encode1(users.length);
    for (const u of users) {
      if (fAllAdded) {
        packet.Encode4(u.nSN);
        packet.Encode1(u.GetAuthencode());
      } else {
        packet.Encode4(0);
      }
    }
    owner.socket?.SendPacket(packet);
    if (!fAllAdded) {
      for (const u of users) {
        if (this.userTable.get(u.strName) === u) this.userTable.delete(u.strName);
        if (this.serialTable.get(u.nSN) === u) this.serialTable.delete(u.nSN);
      }
    }
    void fAllSimpleInfo;
  }

  /** CLocalServer::OnDeleteUser (center side). */
  OnDeleteUser(owner: CLocalServer, n: CReceivedPacket): void {
    const serial = n.Decode4();
    const u = this.serialTable.get(serial);
    if (!u) {
      console.error(`[Center] Try to delete nonresident user[${owner.nServerClass}:${owner.nSvrIdx}:${serial}]`);
      return;
    }
    // CUser::SetFree only when the user really sits on this server (+60/+16)
    if (u.nChannel === owner.nServerClass && u.nSvrIdx === owner.nSvrIdx) {
      u.SetFree(this);
      this.serialTable.delete(serial);
      this.userTable.delete(u.strName);
    }
  }

  /** CLocalServer::OnReqConnectToSvr (center side). */
  OnReqConnectToSvr(owner: CLocalServer, n: CReceivedPacket): void {
    const count = n.Decode1();
    const serials: number[] = [];
    for (let i = 0; i < count; i++) serials.push(n.Decode4());
    const serverType = n.Decode1();
    let smallLoadedSvrIdx = n.Decode4();
    if (serverType === SVRCLASS_SHOP) smallLoadedSvrIdx = this.GetSmallLoadedSvrIdx(SVRCLASS_SHOP);
    let result = 0;
    const users: (CUser | undefined)[] = serials.map((s) => this.serialTable.get(s));
    if (users.every((u) => u !== undefined && u.nSvrIdx === owner.nSvrIdx)) {
      result = 1;
      for (const u of users) {
        if (u!.CheckConnectingToSvr(serverType, smallLoadedSvrIdx) !== 1) {
          result = 0;
          break;
        }
      }
      if (result === 1) for (const u of users) u!.SetConnectingToSvr(serverType, smallLoadedSvrIdx, this);
    }
    const packet = new CSendPacket(CM_ReceivedPacket.OnCenterResConnectToSvr);
    packet.Encode1(count);
    for (const s of serials) packet.Encode4(s);
    packet.Encode1(result);
    if (result === 1) {
      packet.Encode1(serverType);
      packet.Encode4(smallLoadedSvrIdx);
      const target = this.GetSvr(serverType, smallLoadedSvrIdx);
      if (target && target.socket) {
        packet.Encode4(IpToU32(target.strIP));
        packet.Encode2(target.nPort);
      } else {
        packet.Encode4(0);
        packet.Encode2(0);
      }
    }
    owner.socket?.SendPacket(packet);
  }

  /** CLocalServer::OnConnEstablished (center side). */
  OnConnEstablished(owner: CLocalServer, n: CReceivedPacket): void {
    const count = n.Decode1();
    const names: string[] = [];
    const serials: number[] = [];
    for (let i = 0; i < count; i++) {
      names.push(n.DecodeStr());
      serials.push(n.Decode4());
    }
    let result = 0;
    const users: (CUser | undefined)[] = names.map((nm) => this.userTable.get(nm));
    if (users.every((u, i) => u !== undefined && u.strName === names[i] && u.nSvrIdx === owner.nSvrIdx)) {
      result = 1;
      for (const u of users) {
        if (u!.CheckConnectionEstablished(owner.nServerClass, owner.nSvrIdx) === 0) {
          result = 0;
          break;
        }
      }
      if (result === 1) for (const u of users) u!.SetConnectionEstablished();
    } else {
      result = 0;
    }
    // CxCenter.exe.c:10454 — [E1 n][n×(E4 serial, E1 authencode)][E1 flag]
    const packet = new CSendPacket(CM_ReceivedPacket.OnCenterResConnEstablished);
    packet.Encode1(count);
    for (let i = 0; i < count; i++) {
      packet.Encode4(serials[i]!);
      packet.Encode1(users[i]?.GetAuthencode() ?? 0);
    }
    packet.Encode1(result);
    owner.socket?.SendPacket(packet);
  }

  /**
   * CTimerThread (CxCenter.exe.c:20929) — a 0x190 ms tick; every 4th tick
   * sweeps the connection timeouts (CGlobalUserTable::DeleteConnectionTimeout
   * User) and every 2nd tick re-broadcasts the server state (packet 4) so the
   * game servers' channel user counts stay current.
   */
  StartTimer(): void {
    let n = 0;
    const timer = setInterval(() => {
      n++;
      if (n % 4 === 0) this.DeleteConnectionTimeoutUser();
      if (n % 2 === 0) this.SendLocalSvrStatePacket(0);
    }, 400);
    timer.unref?.();
  }

  /** CGlobalUserTable::DeleteConnectionTimeoutUser — the 0x445C ms sweep. */
  DeleteConnectionTimeoutUser(): void {
    for (const u of [...this.userTable.values()]) {
      if (u.DeferDisconnectTimeout(this)) {
        this.serialTable.delete(u.nSN);
        this.userTable.delete(u.strName);
      }
    }
  }

  /** CLocalServerMan broadcast of admin/system messages (raw passthrough). */
  Forward(n: CReceivedPacket, forwardType: number, gameOnly: boolean): void {
    const packet = new CSendPacket(forwardType);
    packet.EncodeBuffer(n.m_pBlock.subarray(n.m_uOffset), n.m_uLength - n.m_uOffset);
    if (gameOnly) this.SendPacketServerType(SVRCLASS_GAME, packet);
    else this.SendPacketToAllLoginAndGameSvr(packet);
  }

  /** CLocalServerMan::OnDisconnect (CxCenter.exe.c:14489). */
  OnLocalDisconnect(sock: CenterClientSocket): void {
    const owner = sock.owner;
    if (!owner) return;
    console.log(`[Center] End of file, close connection(${owner.strName}:${owner.strIP})`);
    owner.socket = null;
    if (this.m_mapConnNo.has(owner.nServerClass)) {
      this.m_mapConnNo.set(owner.nServerClass, (this.m_mapConnNo.get(owner.nServerClass) ?? 1) - 1);
      this.SendLocalSvrGameStatePacket(null);
    }
    this.DeleteAllUserOnSvr(owner.nServerClass, owner.nSvrIdx);
  }

  /** CMonitorListenThread — the operator console listener. */
  ListenMonitor(): void {
    const port = this.cfg.GetNumAttribute("MonitorPort") || 2829;
    Bun.listen({
      hostname: "0.0.0.0",
      port,
      socket: {
        open: (t) => {
          const sock = new MonitorSocket(this);
          this.monitorBySock.set(t, sock);
          sock.bunSocket = t as Bun.Socket<any>;
          sock.m_bConnected = true;
          this.monitorSockets.add(sock);
        },
        data: (t, data) => {
          this.monitorBySock.get(t)?.OnReceive(new Uint8Array(data as Buffer));
        },
        close: (t) => {
          const sock = this.monitorBySock.get(t);
          if (sock) this.monitorSockets.delete(sock);
        },
        error: (_t, err) => console.error(`[Center:monitor] ${String(err)}`),
      },
    });
    console.log(`[Center] monitor listening on :${port}`);
  }
}

/** CMonitorSocket (center) — SetHeaderCode(102,102,231), no rolling seq (CxCenter.exe.c:16424). */
export class MonitorSocket extends CPacketSocket {
  constructor(private center: CxCenter) {
    super(1024, 1024, {
      onPacket: (_sock, packet) => this.OnPacket(packet),
    });
    this.SetHeaderCode(102, 102, 231);
    this.SetSequence(0, 0, 0, 0);
  }

  PostClosePacket(): void {
    this.Close();
  }

  OnPacket(n: CReceivedPacket): void {
    switch (n.Decode1()) {
      case MONITOR_ReceivedPacket.OnRequestCurrentUserStat:
        this.OnRequestCurrentUserStat();
        return;
      case MONITOR_ReceivedPacket.OnRequestSvrState:
        this.OnRequestSvrState();
        return;
      default:
        return;
    }
  }

  OnRequestCurrentUserStat(): void {
    const packet = new CSendPacket(1);
    packet.Encode4(this.center.userTable.size);
    packet.Encode4(this.center.nMaxUser);
    this.SendPacket(packet);
  }

  OnRequestSvrState(): void {
    const packet = new CSendPacket(2);
    const all = this.center.servers;
    packet.Encode1(all.length);
    for (const s of all) {
      packet.Encode1(s.nServerClass);
      packet.Encode4(s.nSvrIdx);
      packet.Encode4(s.socket ? 1 : 0);
      packet.Encode4(s.nConnNo);
    }
    this.SendPacket(packet);
  }
}
