/**
 * CxUtil — the FXUS utility server: an admin-tool relay.
 *
 * Tools connect on the listen socket (CListenThread::Proc binds the literal
 * 0x1FC0 = 8128; cfg ServerPort is never read), announce their identities
 * with packet 7, and every other packet is re-wrapped and forwarded to the
 * center over a CLocalSocket (identified as server class 99 — the same
 * FXUSNumber/FXUSIP0/FXUSPort0 table the center keeps).  Center traffic
 * comes back as broadcasts (CM 8) or directed replies (CM 10 → 64).
 * The client link is plain: CListenThread::Proc calls SetCipherDegree(0).
 *
 * Boot order (CUtilServerApp::SetUp): MainWindow/CRC → CServerConfig →
 * CMainSystem → CGarbageCollector → CVMMan (a VirtualAlloc pool — plain
 * allocation here) → CMainPool → CLocalUserTable → CThreadJobQueue →
 * CSockRcvMultiplexer → CCenterProcess → CTimerThread → CListenThread.
 */
import { CServerConfig } from "../core/Config.ts";
import { CPacketSocket } from "../core/CPacketSocket.ts";
import { CipherDegree, CReceivedPacket, CSendPacket } from "../core/Packet.ts";
import {
  CLIENTSOCKET_HEADER_CODE_MODIFIER,
  CLIENTSOCKET_HEADER_CODE_RCV,
  CLIENTSOCKET_HEADER_CODE_SND,
  CLIENTSOCKET_SEQ,
  CLIENTSOCKET_SEQ_DELTA,
} from "../lib/PacketIDs.ts";
import {
  CM_ReceivedPacket,
  MC_ReceivedPacket,
  SVRCLASS_UTIL,
} from "../lib/S2S.ts";
import { CLocalSocket } from "../lib/CenterLink.ts";
import { UTIL_ClientPacket, UTIL_ClientSend } from "../lib/PacketIDs.ts";

/** CMainSystem::OnConnEstablished — the tool hello's patch URL. */
const SERVER_URL = "ftp://patch.nexon.co.kr/ca";
/** CListenThread::Proc — htons(0x1FC0); cfg ServerPort is dead config. */
const LISTEN_PORT = 0x1fc0;

/**
 * CUser (CxUtil.exe.c) — a tool identity.  m_pSocket (+272) and
 * m_dwGlobalSerialNo (+276, SetGlobalSerialNo) are the only fields the
 * handlers touch; the name lives in the CNamedObject base.
 */
export class CUser {
  m_pSocket: CClientSocket;
  m_dwGlobalSerialNo = 0; // +276
  m_strName = "";

  constructor(socket: CClientSocket) {
    this.m_pSocket = socket;
  }

  /** CNamedObject::SetName */
  SetName(strName: string): void {
    this.m_strName = strName;
  }

  GetName(): string {
    return this.m_strName;
  }

  /** CUser::SetGlobalSerialNo (+276). */
  SetGlobalSerialNo(a2: number): void {
    this.m_dwGlobalSerialNo = a2 >>> 0;
  }

  GetSocket(): CClientSocket {
    return this.m_pSocket;
  }
}

/** CClientSocket (CxUtil) — one connected admin tool. */
export class CClientSocket extends CPacketSocket {
  static ms_nLocalSerialNo = 1;
  /** dword_49F968 — the per-connection header-type counter. It starts at 0
   *  and is separate from the serial: the first client connection gets
   *  header type 0 (CxLogin.exe.c:9898, CxUtil.exe.c:17717). */
  static ms_nHeaderTypeCounter = 0;

  m_nLocalSerialNo = 0; // +236
  m_apUser: CUser[] = []; // +476 (the array is 476, the count 472)
  m_nUserCount = 0; // +472

  constructor() {
    super(CPacketSocket.dwRcvBufferSize, CPacketSocket.dwSndBufferSize, {
      // the vtable routes completed packets into CMainPool::OnPacket
      onPacket: (_sock, packet) => CMainPool.ms_pInstance?.OnPacket(packet, this),
    });
    // dword_49F968: the header type comes from the counter's PRE-increment
    // value (v5 = counter; counter = v5 + 1; SetHeaderType(v5 % 16)) — the
    // first client connection gets header type 0.
    this.SetHeaderType(CClientSocket.ms_nHeaderTypeCounter % 16);
    CClientSocket.ms_nHeaderTypeCounter++;
    this.m_nLocalSerialNo = CClientSocket.ms_nLocalSerialNo++;
    this.SetHeaderCode(CLIENTSOCKET_HEADER_CODE_RCV, CLIENTSOCKET_HEADER_CODE_SND, CLIENTSOCKET_HEADER_CODE_MODIFIER);
    this.SetSequence(CLIENTSOCKET_SEQ, CLIENTSOCKET_SEQ, CLIENTSOCKET_SEQ_DELTA, CLIENTSOCKET_SEQ_DELTA);
  }

  /** CClientSocket::AddNewUsers — n fresh users REPLACE the old array. */
  AddNewUsers(a2: number): void {
    if (a2 <= 0) {
      this.m_nUserCount = a2;
      return;
    }
    this.m_apUser = [];
    for (let i = 0; i < a2; i++) this.m_apUser.push(new CUser(this));
    this.m_nUserCount = a2;
  }

  /** CClientSocket::GetUser(socket, i). */
  GetUser(a2: number): CUser | null {
    return this.m_apUser[a2] ?? null;
  }

  GetUserCount(): number {
    return this.m_nUserCount;
  }

  /** CClientSocket::ClearAttachedUsers. */
  ClearAttachedUsers(): void {
    this.m_apUser = [];
    this.m_nUserCount = 0;
  }
}

/**
 * CLocalUserTable — lowercase-name map (+52) and the serial tree (+72).
 * Insert fails (returns 0) when the name is already resident.
 */
export class CLocalUserTable {
  static ms_pInstance: CLocalUserTable | null = null;

  private m_mapName = new Map<string, CUser>(); // keys are MakeLower'd names
  private m_mapSerial = new Map<number, CUser>(); // +72, FindUserFromGlobalSerialNo

  /** CLocalUserTable::Insert — 0 when the name is taken. */
  Insert(User: CUser): number {
    const key = User.GetName().toLowerCase();
    if (this.m_mapName.has(key)) return 0;
    this.m_mapName.set(key, User);
    if (User.m_dwGlobalSerialNo !== 0) this.m_mapSerial.set(User.m_dwGlobalSerialNo, User);
    return 1;
  }

  /** CLocalUserTable::Remove (by the user's own name). */
  Remove(User: CUser): void {
    const key = User.GetName().toLowerCase();
    this.m_mapName.delete(key);
    this.m_mapSerial.delete(User.m_dwGlobalSerialNo);
  }

  /** CLocalUserTable::FindUserFromGlobalSerialNo. */
  FindUserFromGlobalSerialNo(a2: number): CUser | null {
    return this.m_mapSerial.get(a2 >>> 0) ?? null;
  }

  FindUserFromId(id: string): CUser | null {
    return this.m_mapName.get(id.toLowerCase()) ?? null;
  }
}

/** CMainSystem — the FXAttr byte (CM 12) and the user serial counter (+32). */
export class CMainSystem {
  static ms_pInstance: CMainSystem | null = null;

  m_nFXAttr = -1; // +4 (OnInitialSvrAttr)
  m_nConnNo = 0; // +32 — the ++ source for accept-time serials

  /** CMainSystem::OnInitialSvrAttr — [E1 attr][E1 ?] keeps the first byte. */
  OnInitialSvrAttr(n: CReceivedPacket): void {
    const attr = n.Decode1();
    n.Decode1();
    this.m_nFXAttr = attr;
  }

  /**
   * CMainSystem::OnConnEstablished — accept-time: one placeholder user with
   * a counter serial, the table insert, then the plain hello
   * [E2 3][E2 5][E4 headerType][EStr url].
   */
  OnConnEstablished(rConnectedSocket: CClientSocket): void {
    rConnectedSocket.ClearAttachedUsers();
    rConnectedSocket.AddNewUsers(1);
    const User = rConnectedSocket.GetUser(0)!;
    User.SetGlobalSerialNo(++this.m_nConnNo);
    if (CLocalUserTable.ms_pInstance?.Insert(User) === 0) console.error("Error! Failed to Add User");
    const packet = new CSendPacket(UTIL_ClientSend.OnConnect, CipherDegree.kPacketRaw);
    packet.Encode2(3);
    packet.Encode2(5);
    packet.Encode4(rConnectedSocket.m_nHeaderType);
    packet.EncodeStr(SERVER_URL);
    rConnectedSocket.SendPacket(packet);
  }
}

/** CMainPool — the tool pool and the whole client-side dispatch. */
export class CMainPool {
  static ms_pInstance: CMainPool | null = null;

  m_setSocket = new Set<CClientSocket>(); // CUserPool::AddNewSocket / DelSocket

  /** CUserPool::AddNewSocket. */
  AddNewSocket(User: CClientSocket): void {
    this.m_setSocket.add(User);
  }

  /** CUserPool::DelSocket — drop the socket from the pool.  (The original's
   *  OnClose path never removes CLocalUserTable rows; stale rows stay until
   *  the same name logs in again, exactly as shipped.) */
  DelSocket(a2: CClientSocket): void {
    this.m_setSocket.delete(a2);
  }

  /** CUserPool::SendAll — every connected tool. */
  SendAll(packet: CSendPacket): void {
    for (const s of this.m_setSocket) s.SendPacket(packet);
  }

  /** CMainPool::OnPacket (CxUtil.exe.c:21528) — the relay dispatch. */
  OnPacket(n: CReceivedPacket, a3: CClientSocket): void {
    switch (n.Decode1()) {
      case UTIL_ClientPacket.OnConnEstablished:
        this.OnConnEstablished(n, a3);
        break;
      case UTIL_ClientPacket.OnAdminNotifyMsg:
        this.OnAdminNotifyMsg(n, a3);
        break;
      case UTIL_ClientPacket.OnAdminNotifyGameServerMsg:
        this.OnAdminNotifyGameServerMsg(n, a3);
        break;
      case UTIL_ClientPacket.OnSystemMsg:
        this.OnSystemMsg(n, a3);
        break;
      case UTIL_ClientPacket.OnKickoffUser:
        this.OnKickoffUser(n, a3);
        break;
      case UTIL_ClientPacket.OnReqUserInfo:
        this.OnReqUserInfo(n, a3);
        break;
      case UTIL_ClientPacket.OnUpdateItem:
        this.OnUpdateItem(n, a3);
        break;
      default:
        n.m_uOffset = 0;
        this.OnEstimateRTT(n, a3); // CUserPool::OnPacket: only 20 answers
        break;
    }
  }

  /**
   * CMainPool::OnConnEstablished (packet 7) — the tool login:
   * [E1 n][n × (EStr name, E4 serial)]; any duplicate name rolls back the
   * whole batch and disconnects (the lst: SetGlobalSerialNo is the mov to
   * +276 between the two decodes).
   */
  OnConnEstablished(n: CReceivedPacket, User: CClientSocket): void {
    const nCount = n.Decode1();
    User.AddNewUsers(nCount);
    this.AddNewSocket(User);
    let i = 0;
    for (; i < nCount; i++) {
      const u = User.GetUser(i)!;
      const name = n.DecodeStr();
      const serial = n.Decode4();
      u.SetName(name);
      u.SetGlobalSerialNo(serial);
      if (CLocalUserTable.ms_pInstance?.Insert(u) === 0) break;
    }
    if (i < nCount) {
      // rollback the batch, then drop the connection
      for (let j = 0; j < i; j++) CLocalUserTable.ms_pInstance?.Remove(User.GetUser(j)!);
      User.PostClosePacket();
    }
  }

  /** CMainPool::OnAdminNotifyMsg (25) — CSendPacket(4) [EStr] to the center. */
  OnAdminNotifyMsg(n: CReceivedPacket, _a3: CClientSocket): void {
    const str = n.DecodeStr();
    const packet = new CSendPacket(MC_ReceivedPacket.OnAdminNotifyMsg);
    packet.EncodeStr(str);
    CCenterProcess.ms_pInstance?.SendPacket(packet);
  }

  /** CMainPool::OnAdminNotifyGameServerMsg (26) — CSendPacket(5) [E1][EStr]. */
  OnAdminNotifyGameServerMsg(n: CReceivedPacket, _a3: CClientSocket): void {
    const b = n.Decode1();
    const str = n.DecodeStr();
    const packet = new CSendPacket(MC_ReceivedPacket.OnAdminNotifyGameServerMsg);
    packet.Encode1(b);
    packet.EncodeStr(str);
    CCenterProcess.ms_pInstance?.SendPacket(packet);
  }

  /** CMainPool::OnSystemMsg (31) — CSendPacket(10) [EStr] to the center. */
  OnSystemMsg(n: CReceivedPacket, _a3: CClientSocket): void {
    const str = n.DecodeStr();
    const packet = new CSendPacket(MC_ReceivedPacket.OnSystemMsg);
    packet.EncodeStr(str);
    CCenterProcess.ms_pInstance?.SendPacket(packet);
  }

  /** CMainPool::OnKickoffUser (32) — CSendPacket(1) [EStr name] to the center. */
  OnKickoffUser(n: CReceivedPacket, _a3: CClientSocket): void {
    const str = n.DecodeStr();
    const packet = new CSendPacket(MC_ReceivedPacket.OnDeleteUser);
    packet.EncodeStr(str);
    CCenterProcess.ms_pInstance?.SendPacket(packet);
  }

  /** CMainPool::OnReqUserInfo (64) — CSendPacket(7) [E4 serial][EStr account]. */
  OnReqUserInfo(n: CReceivedPacket, a3: CClientSocket): void {
    const str = n.DecodeStr();
    const packet = new CSendPacket(MC_ReceivedPacket.OnRequestUserChannel);
    const User = a3.GetUser(0);
    console.error("OnReqUserInfo called");
    packet.Encode4(User ? User.m_dwGlobalSerialNo : 0);
    packet.EncodeStr(str);
    CCenterProcess.ms_pInstance?.SendPacket(packet);
  }

  /** CMainPool::OnUpdateItem (66) — CSendPacket(11) [EStr] ("UpdateFxItem"). */
  OnUpdateItem(n: CReceivedPacket, _a3: CClientSocket): void {
    const packet = new CSendPacket(MC_ReceivedPacket.OnSystemCmd);
    let str = "";
    if (n.Decode1() === MC_ReceivedPacket.OnSystemCmd) str = "UpdateFxItem";
    packet.EncodeStr(str);
    CCenterProcess.ms_pInstance?.SendPacket(packet);
  }

  /** CUserPool::OnEstimateRTT (20) — echo the [E4] back under id 20. */
  OnEstimateRTT(n: CReceivedPacket, a3: CClientSocket): void {
    if (n.Decode1() !== UTIL_ClientPacket.OnEstimateRTT) return;
    const t = n.Decode4();
    const packet = new CSendPacket(UTIL_ClientSend.OnEstimateRTTRes);
    packet.Encode4(t);
    a3.SendPacket(packet);
  }

  /**
   * CMainPool::SendUserDetailInfo (static) — the CM 10 answer as packet 64
   * [E1 n][E4 n2] to the tool that owns the serial.
   */
  static SendUserDetailInfo(User: CUser, _p_str: string, n: number, a4: number): void {
    const socket = User.GetSocket();
    if (!socket.m_bConnected) return;
    const packet = new CSendPacket(UTIL_ClientSend.OnUserDetailInfo);
    packet.Encode1(n);
    packet.Encode4(a4);
    socket.SendPacket(packet);
  }
}

/** CCenterProcess — the util's center link (class 99). */
export class CCenterProcess {
  static ms_pInstance: CCenterProcess | null = null;

  m_cLocalSocket = new CLocalSocket({
    // the recv loop pumps every parsed packet into CCenterProcess::OnPacket
    onPacket: (_sock, packet) => this.OnPacket(packet),
    onClose: () => {
      console.error("LocalSocket connection closed from center server, terminate process.");
      process.exit(0);
    },
  });

  /** CCenterProcess::SendPacket — to the center over the local socket. */
  SendPacket(packet: CSendPacket): void {
    this.m_cLocalSocket.SendToCenter(packet);
  }

  /**
   * CCenterProcess::Init — the "Try to connect center server." loop: retry
   * every 3 s until the greeting + identify ([99][idx^0x77][E2 5][E2 3])
   * succeed, then report "Connection to Center Server established".
   */
  async Init(cfg: CServerConfig): Promise<void> {
    // the 3 s retry loop lives in CLocalSocket.ConnectToCenter (CxUtil.exe.c:15596)
    await this.m_cLocalSocket.ConnectToCenter(
      cfg.GetAttribute("CenterIP"),
      cfg.GetNumAttribute("CenterPort"),
      SVRCLASS_UTIL,
      cfg.GetNumAttribute("ServerIndex"),
      5, // gameVersion
      3, // clientVersion
    );
    console.log("[FXUS] Connection to Center Server established");
  }

  /** CCenterProcess::OnPacket — 8 broadcast, 10 user result, 12 FXAttr. */
  OnPacket(a2: CReceivedPacket): void {
    switch (a2.Decode1()) {
      case CM_ReceivedPacket.OnAdminNotifyMsg:
        this.OnAdminNotifyMsg(a2);
        break;
      case CM_ReceivedPacket.OnUserChannelResult:
        this.OnUserChannelResult(a2);
        break;
      case CM_ReceivedPacket.OnInitialSvrAttr:
        CMainSystem.ms_pInstance?.OnInitialSvrAttr(a2);
        break;
      default:
        return;
    }
  }

  /**
   * CCenterProcess::OnAdminNotifyMsg (CM 8) — [EStr] rebroadcast to every
   * tool under id 26.
   */
  OnAdminNotifyMsg(a2: CReceivedPacket): void {
    const str = a2.DecodeStr();
    const packet = new CSendPacket(UTIL_ClientSend.OnAdminNotifyMsg);
    packet.EncodeStr(str);
    CMainPool.ms_pInstance?.SendAll(packet);
  }

  /**
   * CCenterProcess::OnUserChannelResult (CM 10) — [E4 serial][EStr][E1][E4];
   * the answer rides packet 64 to the tool that asked.
   */
  OnUserChannelResult(a2: CReceivedPacket): void {
    const serial = a2.Decode4();
    const str = a2.DecodeStr();
    const n = a2.Decode1();
    const n2 = a2.Decode4();
    const User = CLocalUserTable.ms_pInstance?.FindUserFromGlobalSerialNo(serial);
    if (User) CMainPool.SendUserDetailInfo(User, str, n, n2);
  }
}

/**
 * The boot (WinMain → CUtilServerApp::SetUp/Run): config → the system
 * singletons → the center link → the 0x1FC0 listener.
 */
export async function main(cfgFile: string): Promise<void> {
  const cfg = new CServerConfig();
  cfg.Init(cfgFile);
  CServerConfig.ms_pInstance = cfg;

  CMainSystem.ms_pInstance = new CMainSystem();
  CLocalUserTable.ms_pInstance = new CLocalUserTable();
  CMainPool.ms_pInstance = new CMainPool();
  CCenterProcess.ms_pInstance = new CCenterProcess();

  // CListenThread::Proc — bind the literal 0x1FC0, accept → OnConnEstablished
  // → SetCipherDegree(0) → the receive loop.
  Bun.listen({
    hostname: "0.0.0.0",
    port: LISTEN_PORT,
    socket: {
      open: (t) => {
        const socket = new CClientSocket();
        socketOf.set(t, socket);
        socket.bunSocket = t as Bun.Socket<any>;
        socket.m_bConnected = true;
        CMainSystem.ms_pInstance!.OnConnEstablished(socket);
        socket.SetCipherDegree(CipherDegree.kPacketRaw);
      },
      data: (t, data) => {
        socketOf.get(t)?.OnReceive(new Uint8Array(data as Buffer));
      },
      close: (t) => {
        const socket = socketOf.get(t);
        if (socket) {
          // CUserPool::OnClose — drop the socket's users, then the socket
          // itself (the pool only ever holds packet-7 logins).
          CMainPool.ms_pInstance?.DelSocket(socket);
          socket.Close();
        }
      },
      error: (_t, err) => console.error(`[FXUS] ${String(err)}`),
    },
  });
  console.log(`[FXUS] listening on :${LISTEN_PORT}`);

  await CCenterProcess.ms_pInstance.Init(cfg);
}

/** Bun socket → CClientSocket (module-scoped weak bookkeeping). */
const socketOf = new WeakMap<object, CClientSocket>();
