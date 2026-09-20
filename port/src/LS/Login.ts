/**
 * CxLogin — the login server (LS_000.cfg, listen port = ServerPort).
 *
 * Client dispatch : CLoginPool::OnPacket (CxLogin.exe.c:15254) →
 *   1 AskMultiServer, 2 AskFirstInfo, 3 Login, 4 NewUserConfirmId, 5 NewUser,
 *   6 ReqConnectToSvr, 7 ConnEstablished (error+disconnect), 8 CrashInfo,
 *   9 RequestEnterChannelStage, 60 RequestDestoryService,
 *   61 → CCenterProcess::DestructCenterSvr, then the shared
 *   CUserPool::OnPacket fallback (20 EstimateRTT).
 *
 * Center dispatch  : CCenterProcess::OnPacket (CxLogin.exe.c:6055) →
 *   0 ResAddNewUser, 1 ResConnectToSvr, 2 ResConnEstablished (fatal log),
 *   3 LocalServerInfo, 4 LocalServerState, 5 LocalGameState,
 *   7 SvrReservedMsg (→ client 16), 8 AdminNotifyMsg (→ client 26),
 *   11 DeleteUser, 13 SystemMsg (→ client 30).
 *
 * CAuthenThread (the external Nexon billing service) is not part of the
 * six-server suite; the paths that would defer to it answer immediately.
 */
import { CServerConfig, CXLOGIN_STR_KEYS } from "../core/Config.ts";
import { PacketLog } from "../core/PacketLog.ts";
import { CPacketSocket } from "../core/CPacketSocket.ts";
import { CipherDegree, CReceivedPacket, CSendPacket, enSocket, type enSocket as EnSocket } from "../core/Packet.ts";
import { CDBMan, EncodePassword } from "../db/DBMan.ts";
import { CMultiServer, inet_addr } from "./MultiServer.ts";
import { MTUDPServer, SetLocalUserTableFinder } from "./MTUDPServer.ts";
import { CChannelCache } from "./ChannelCache.ts";
import { CDynInfoCalculator_GetLevel } from "./LevelTable.ts";
import { CLocalSocket } from "../lib/CenterLink.ts";
import { MC_ReceivedPacket, CENTER_VERSION, CONN_HELLO_VERSION, SVRCLASS_GAME, SVRCLASS_LOGIN } from "../lib/S2S.ts";
import {
  CLIENTSOCKET_HEADER_CODE_MODIFIER,
  CLIENTSOCKET_HEADER_CODE_RCV,
  CLIENTSOCKET_HEADER_CODE_SND,
  CLIENTSOCKET_SEQ,
  CLIENTSOCKET_SEQ_DELTA,
  LS_ClientSend,
  PACKET_NAME_TABLES,
  LS_ReceivedPacket,
  LS_SendPacket,
} from "../lib/PacketIDs.ts";

/** "현재 게임을 하고 계시는 곳" (byte_47A458, EUC-KR) — the double-login notice. */
const STR_ALREADY_PLAYING = "\xc7\xf6\xc0\xe7 \xb0\xd4\xc0\xd3\xc0\xbb \xc7\xcf\xb0\xed \xb0\xe8\xbd\xc3\xb4\xc2 \xb0\xf7";
/** aPc (CxLogin.exe.lst: .text:0040F85C push offset aPc ; "PC") */
const STR_PC = "PC";

/** The client's IPv4 as the raw in_addr dword (CClientSocket+12, m_addr.sin_addr
 *  read little-endian): 127.0.0.1 → 0x0100007f. The center stores it for
 *  CUser::GetIP. IPv6 or unresolvable peers read 0 (the original is IPv4-only). */
function PeerAddressDword(socket: CClientSocket): number {
  let addr = socket.bunSocket?.remoteAddress ?? "";
  if (addr.startsWith("::ffff:")) addr = addr.slice(7);
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(addr);
  if (!m) return 0;
  return ((Number(m[1]) | (Number(m[2]) << 8) | (Number(m[3]) << 16) | (Number(m[4]) << 24)) >>> 0);
}

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

/** _USERACCOUNT + CUser of CxLogin (0x114 bytes). */
export class CUser {
  socket: CClientSocket;
  strId = ""; // UA +0  (CUser +24)
  strSSN1 = ""; // UA +36 (CUser +60, GetSSN1)
  strSSN2 = ""; // UA +48 (CUser +72, GetSSN2)
  strEmail = ""; // UA +60 (CUser +84)
  nSID = 0; // UA +152 (CUser +176, GetSID)
  nCommunitySvr = 0; // UA +148 (byte)
  nFxMoney = 0; // UA +168 (CUser +192)
  nFxexp = 0; // UA +172 (CUser +196)
  nTxexp = 0; // UA +224 (CUser +224)
  nGuildSerialNo = 0; // UA +244 (CUser +268)
  nGlobalSerialNo = 0; // CUser +264
  nPremiumTicket = 0; // CUser +272

  constructor(socket: CClientSocket) {
    this.socket = socket;
    // CUserPool::AddNewUser (CUser ctor) — a duplicate name logs in on the
    // same pool row in practice; the refusal return gates nothing here.
    CLoginPool.ms_pInstance?.AddNewUser(this);
  }

  GetId(): string {
    return this.strId;
  }

  GetName(): string {
    return this.strId; // CNamedObject name — set to the login id by CDBMan::InitUser
  }

  GetSID(): number {
    return this.nSID;
  }

  GetGlobalSerialNo(): number {
    return this.nGlobalSerialNo;
  }

  SetGlobalSerialNo(serial: number): void {
    this.nGlobalSerialNo = serial >>> 0;
  }

  SetGuildSerialNo(serial: number): void {
    this.nGuildSerialNo = serial;
  }

  GetPremiumTicket(): number {
    return this.nPremiumTicket;
  }

  SetPremiumTicket(ticket: number): void {
    this.nPremiumTicket = ticket;
  }

  GetSocket(): CClientSocket {
    return this.socket;
  }
}

/** CClientSocket — one connected game client (CxLogin.exe.c:9880). */
export class CClientSocket extends CPacketSocket {
  /** CClientSocket::OnReceiveCompletionPacket guards the client links only
   *  (CxLogin.exe.c:9753). */
  m_fReceiveFloodGuard = true;

  protected ReportReceiveOverflow(): void {
    console.error(`Socket receive buffer overflow(${this.bunSocket?.remoteAddress ?? ""}), disconnected.`);
  }

  protected ReportSendOverflow(): void {
    console.error(`Socket send buffer overflow, close connection: (${this.bunSocket?.remoteAddress ?? ""})`);
  }

  /** CClientSocket::PutPacket's wrapper switch (CxLogin.exe.c:9568). */
  protected ReportPutError(err: EnSocket): void {
    if (err === enSocket.kioNotConnected) console.error("Not-connected client socket tried to put packet.");
    else if (err === enSocket.kioInvalidPacket) console.error("tried to send invalid( =\tNULL ) packet");
  }
  static ms_nLocalSerialNo = 1;
  /** dword_49F968 — the per-connection header-type counter. It starts at 0
   *  and is separate from the serial: the first client connection gets
   *  header type 0 (CxLogin.exe.c:9898, CxUtil.exe.c:17717). */
  static ms_nHeaderTypeCounter = 0;
  /** CClientSocket::ms_tblSN2Obj — local serial → socket. */
  static ms_tblSN2Obj = new Map<number, CClientSocket>();

  m_nLocalSerialNo = 0; // +236
  m_nDeleteUserSN = 0; // +248 (the D4 tail of OnLogin; echoed by UnregisterConnection)
  m_nGameRoomCode = 0; // +472
  m_apUser: (CUser | null)[] = []; // +480
  m_nUserCount = 0; // +476
  m_machineId = new Uint8Array(16); // +456
  m_nFlushCount = 0; // +492
  m_nLoginCount = 0; // +496
  m_dwFlushTime = 0; // +500
  m_dwLastRTT = (Date.now() - 5000) & 0x7fffffff; // +488 (ctor: timeGetTime()-5000)

  constructor() {
    super(CPacketSocket.dwRcvBufferSize, CPacketSocket.dwSndBufferSize, {
      // the original's vtable routes completed packets into CLoginPool::OnPacket
      onPacket: (_sock, packet) => CLoginPool.ms_pInstance?.OnPacket(packet, this),
    });
    this.m_szLogTag = "LS";
    this.m_fClientLink = true;
    // dword_49F968: the header type comes from the counter's PRE-increment
    // value (read the counter, THEN increment; SetHeaderType(counter % 16)) — the
    // first client connection gets header type 0.
    this.SetHeaderType(CClientSocket.ms_nHeaderTypeCounter % 16);
    CClientSocket.ms_nHeaderTypeCounter++;
    this.m_nLocalSerialNo = CClientSocket.ms_nLocalSerialNo++;
    this.SetHeaderCode(CLIENTSOCKET_HEADER_CODE_RCV, CLIENTSOCKET_HEADER_CODE_SND, CLIENTSOCKET_HEADER_CODE_MODIFIER);
    this.SetSequence(CLIENTSOCKET_SEQ, CLIENTSOCKET_SEQ, CLIENTSOCKET_SEQ_DELTA, CLIENTSOCKET_SEQ_DELTA);
    this.m_dwFlushTime = Date.now() - 5000;
    CClientSocket.ms_tblSN2Obj.set(this.m_nLocalSerialNo, this);
  }

  /** CClientSocket::GetSocketFromLocalSerialNo */
  static GetSocketFromLocalSerialNo(serialNo: number): CClientSocket | null {
    return CClientSocket.ms_tblSN2Obj.get(serialNo) ?? null;
  }

  /** CClientSocket::GetLocalSerialNo */
  GetLocalSerialNo(): number {
    return this.m_nLocalSerialNo;
  }

  /** CClientSocket::SetGameRoomCode */
  SetGameRoomCode(code: number): void {
    this.m_nGameRoomCode = code;
  }

  GetGameRoomCode(): number {
    return this.m_nGameRoomCode;
  }

  /** CClientSocket::SetMachineId */
  SetMachineId(machineId: Uint8Array): void {
    this.m_machineId.set(machineId.subarray(0, 16));
  }

  GetMachineId(): Uint8Array {
    return this.m_machineId;
  }

  /** CClientSocket::AddNewUsers */
  AddNewUsers(count: number): void {
    this.m_apUser = [];
    for (let i = 0; i < count; i++) this.m_apUser.push(new CUser(this));
    this.m_nUserCount = count;
  }

  GetUser(i: number): CUser | null {
    return this.m_apUser[i] ?? null;
  }

  GetUserCount(): number {
    return this.m_nUserCount;
  }

  /** CClientSocket::ClearAttachedUsers */
  ClearAttachedUsers(): void {
    this.m_apUser = [];
    this.m_nUserCount = 0;
  }

    /**
     * CClientSocket::CheckLoginFlush — anti-flood (CxLogin.exe.c:8309): at
     * most 30 logins per socket; a login within 3 s of the previous one
     * increments the burst counter, and the 10th burst login fails.
     */
    CheckLoginFlush(): boolean {
      this.m_nLoginCount++;
      if (this.m_nLoginCount > 30) return false;
      const now = Date.now();
      if (now - this.m_dwFlushTime < 3000) {
        this.m_nFlushCount++;
        if (this.m_nFlushCount >= 10) return false;
      }
      this.m_dwFlushTime = now;
      return true;
    }

  PostClosePacket(): void {
    this.Close();
  }

  /** CClientSocket::SafeFree — pool cleanup + center unregistration. */
  Close(): void {
    if (!this.m_bConnected) return;
    for (const u of this.m_apUser) if (u) CLoginPool.ms_pInstance?.DelUser(u);
    super.Close();
    CLoginPool.ms_pInstance?.DelSocket(this);
    CClientSocket.ms_tblSN2Obj.delete(this.m_nLocalSerialNo);
    CCenterProcess.ms_pInstance?.UnregisterConnection(this.m_nDeleteUserSN);
  }
}

/** CLocalUserTable — the login server's view of its logged-in users. */
export class CLocalUserTable {
  private byName = new Map<string, CUser>();
  private bySN = new Map<number, CUser>();

  /** CLocalUserTable::Insert */
  Insert(user: CUser): void {
    this.byName.set(user.GetName(), user);
    if (user.GetGlobalSerialNo() !== 0) this.bySN.set(user.GetGlobalSerialNo(), user);
  }

  /** CLocalUserTable::ExtractUser */
  ExtractUser(user: CUser): void {
    this.byName.delete(user.GetName());
    this.bySN.delete(user.GetGlobalSerialNo());
  }

  /** CLocalUserTable::FindUserFromId */
  FindUserFromId(name: string): CUser | null {
    return this.byName.get(name) ?? null;
  }

  /** CLocalUserTable::FindUserFromGlobalSerialNo */
  FindUserFromGlobalSerialNo(sn: number): CUser | null {
    return this.bySN.get(sn) ?? null;
  }
}

/** CLoginPool extends CUserPool — owns every client socket and the handlers. */
export class CLoginPool {
  static ms_pInstance: CLoginPool | null = null;

  m_setSocket = new Set<CClientSocket>();
  m_setUser = new Set<CUser>();
  m_localUserTable = new CLocalUserTable();
  m_center: CCenterProcess;
  m_db: CDBMan;
  m_multiServer: CMultiServer;
  m_channelCache = new CChannelCache();

  constructor(center: CCenterProcess, db: CDBMan, multiServer: CMultiServer) {
    CLoginPool.ms_pInstance = this;
    this.m_center = center;
    this.m_db = db;
    this.m_multiServer = multiServer;
  }

  /** CUserPool::AddNewUser (:418D60) — a duplicate insert reports and the
   *  user is refused (no OnAddNewUser virtual). */
  AddNewUser(user: CUser): number {
    if (this.m_setUser.has(user)) {
      console.error(`[LS] Try to insert already resident user in user room`);
      return 0;
    }
    this.m_setUser.add(user);
    return 1;
  }

  /** CUserPool::DelUser */
  DelUser(user: CUser): void {
    this.m_setUser.delete(user);
  }

  /** CUserPool::FindUser */
  FindUser(user: CUser): boolean {
    return this.m_setUser.has(user);
  }

  /** CUserPool::AddSocket (:418E60) — a duplicate insert reports. */
  AddSocket(socket: CClientSocket): void {
    if (this.m_setSocket.has(socket)) console.error(`[LS] Try to insert already resident socket in userpool`);
    this.m_setSocket.add(socket);
  }

  /** CUserPool::DelSocket */
  DelSocket(socket: CClientSocket): void {
    this.m_setSocket.delete(socket);
  }

  /** CUserPool::DisconnectTimeoutSocket (CxLogin.exe.c:23685) — drops the
   *  sockets whose last client-20 RTT stamp is older than 0x7530 ms. Both
   *  stamps live on the 31-bit timeGetTime ring, so the difference is
   *  reduced modulo 0x7fffffff before comparing. */
  DisconnectTimeoutSocket(): void {
    const now = Date.now() & 0x7fffffff;
    for (const socket of [...this.m_setSocket]) {
      if (((now - socket.m_dwLastRTT) & 0x7fffffff) > 30000) {
        console.log(`Disconnect Timeout Socket: ${socket.bunSocket?.remoteAddress ?? ""}`);
        socket.Close();
      }
    }
  }

  /** CTimerThread (CxLogin.exe.c:22472 OnTimer / 22546 Proc, Sleep 0x190).
   *  400 ms tick driving: %9000 UpdateLevelLimit, dword_49FCAC's %150 gate
   *  (the counter only advances inside the gate, so the full advertisement
   *  reload fires exactly once), %3000 UpdateGuildServerList, %9999
   *  UpdateFxMessage, %11111 UpdatePremiumChannelMapSelReward and the
   *  CUserPool::OnTimer %75 timeout sweep. The %3 IssueSend / %6
   *  FlushClientSocketSndBuffer are transport batching (the port sends
   *  immediately) and %1500 is the datetime Report — none touch the wire. */
  StartTimer(center: CCenterProcess): void {
    let n = 0; // the CTimerThread tick
    let nAdv = 0; // dword_49FCAC
    let nUserPool = 0; // dword_49FD10
    const timer = setInterval(() => {
      if (n % 9000 === 0) center.UpdateLevelLimit();
      if (nAdv % 150 === 0) {
        const advCycle = nAdv % 4500;
        nAdv++;
        center.UpdateAdvertisement(advCycle === 0 ? 1 : 0);
      }
      if (n % 3000 === 0) center.UpdateGuildServerList();
      if (n % 9999 === 0) center.UpdateFxMessage();
      if (n % 11111 === 0) center.UpdatePremiumChannelMapSelReward();
      if (++nUserPool % 75 === 0) this.DisconnectTimeoutSocket();
      n++;
    }, 400);
    timer.unref?.();
  }

  /** CUserPool::OnPacket — the fallback dispatch (CxLogin.exe.c). */
  OnUserPoolPacket(n: CReceivedPacket, socket: CClientSocket): void {
    if (n.Decode1() === LS_ReceivedPacket.OnEstimateRTT) this.OnEstimateRTT(n, socket);
  }

  /** CUserPool::OnEstimateRTT (CxLogin.exe.c:23317) */
  OnEstimateRTT(n: CReceivedPacket, socket: CClientSocket): void {
    const packet = new CSendPacket(LS_SendPacket.OnEstimateRTTRes, CipherDegree.kPacketEncryptedCRC8);
    const rttValue = n.Decode4(); // the client's stamp, echoed verbatim
    const time = Date.now() & 0x7fffffff;
    packet.Encode4(rttValue);
    packet.Encode4(time);
    socket.m_dwLastRTT = time;
    socket.SendPacket(packet);
  }

  /** CLoginPool::OnPacket (CxLogin.exe.c:15254) */
  OnPacket(n: CReceivedPacket, socket: CClientSocket): void {
    switch (n.Decode1()) {
      case LS_ReceivedPacket.OnAskMultiServer:
        this.OnAskMultiServer(n, socket);
        break;
      case LS_ReceivedPacket.OnAskFirstInfo:
        this.OnAskFirstInfo(n, socket);
        break;
      case LS_ReceivedPacket.OnLogin:
        this.OnLogin(n, socket);
        break;
      case LS_ReceivedPacket.OnNewUserConfirmId:
        this.OnNewUserConfirmId(n, socket);
        break;
      case LS_ReceivedPacket.OnNewUser:
        this.OnNewUser(n, socket);
        break;
      case LS_ReceivedPacket.OnReqConnectToSvr:
        this.OnReqConnectToSvr(n, socket);
        break;
      case LS_ReceivedPacket.OnConnEstablished:
        this.OnConnEstablished(socket);
        break;
      case LS_ReceivedPacket.OnCrashInfo:
        this.OnCrashInfo(n, socket);
        break;
      case LS_ReceivedPacket.OnRequestEnterChannelStage:
        this.OnRequestEnterChannelStage(n, socket);
        break;
      case LS_ReceivedPacket.OnRequestDestoryService:
        this.OnRequestDestoryService(n, socket);
        break;
      case 61:
        n.Decode4();
        this.m_center.DestructCenterSvr();
        break;
      default:
        break;
    }
    n.ResetOffset();
    this.OnUserPoolPacket(n, socket);
  }

  /** CLoginPool::OnAskMultiServer (CxLogin.exe.c:14561) */
  OnAskMultiServer(n: CReceivedPacket, socket: CClientSocket): void {
    const hashValue = this.m_multiServer.GetHashValue();
    const clientHash = n.Decode4();
    const serverVersion = this.m_multiServer.m_nVersion; // CMultiServer+72
    const fHashMismatch = clientHash !== hashValue ? 1 : 0;
    const fVersionMismatch = n.Decode4() !== serverVersion ? 1 : 0;
    socket.SendPacket(this.m_multiServer.GetInfoPacket(fHashMismatch, fVersionMismatch));
  }

  /** CLoginPool::OnAskFirstInfo (CxLogin.exe.c:15095) */
  OnAskFirstInfo(n: CReceivedPacket, socket: CClientSocket): void {
    const packet = new CSendPacket(LS_SendPacket.OnAskFirstInfoRes, CipherDegree.kPacketEncryptedCRC8);
    if (n.Decode4() === 0) {
      packet.EncodeStr("http://mail.nexonclub.com/clubadmin/confirmuser");
      packet.EncodeStr("http://id.nexonclub.com/nxidquery.idsocno");
    }
    socket.SendPacket(packet);
  }

  /** CLoginPool::OnLogin (CxLogin.exe.c:15069) */
  OnLogin(n: CReceivedPacket, socket: CClientSocket): void {
    let inited = n.Decode1();
    const count = inited;
    if (!socket.CheckLoginFlush()) {
      socket.Close();
      console.log("Disconnect login_flush-suspected socket.");
      return;
    }
    for (const u of socket.m_apUser) if (u) this.DelUser(u);
    socket.ClearAttachedUsers();
    socket.AddNewUsers(inited);
    let userIdx = 0;
    if (inited > 0) {
      do {
        const user = socket.GetUser(userIdx)!;
        const id = n.DecodeEncryptedStr(0x11223344);
        const pw = n.DecodeEncryptedStr(0x44332211);
        inited = CDBMan_InitUser(this.m_db, user, id, pw);
        if (inited !== 0) break;
        userIdx++;
      } while (userIdx < count);
    }
    socket.m_nDeleteUserSN = n.Decode4();
    if (inited !== 0) {
      const packet = new CSendPacket(LS_SendPacket.OnLoginRes, CipherDegree.kPacketEncryptedCRC8);
      packet.Encode1(inited >= 2 && inited <= 3 ? 1 : 3);
      packet.Encode1(userIdx);
      socket.SendPacket(packet);
    } else {
      this.m_center.RegisterConnection(socket);
    }
  }

  /** CLoginPool::OnNewUserConfirmId (CxLogin.exe.c:14900) */
  OnNewUserConfirmId(n: CReceivedPacket, socket: CClientSocket): void {
    const id = n.DecodeStr();
    const confirmResult = this.m_db.prConfirmUnregisteredId(id);
    const packet = new CSendPacket(LS_SendPacket.OnNewUserConfirmIdRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(confirmResult);
    socket.SendPacket(packet);
  }

  /**
   * CLoginPool::OnNewUser (CxLogin.exe.c:14900).
   *
   * Wire order (verified against the RegisterNewUser push sequence in
   * CxLogin.exe.lst:0040A781..0040A8CB): s1=ID, s2=Password,
   * s3=PasswordQ, s4=PasswordA, s5=IdentityNo, s6=Birthday, s7=Name,
   * s8=Email, b1=EmailRcv, b2=Gender, s9=Address, s10=Tel, s11=Profile,
   * b3=Reveal.  @Password = EncodePassword(s2) (CxLogin.exe.c:11551).
   */
  OnNewUser(n: CReceivedPacket, socket: CClientSocket): void {
    const strId = n.DecodeStr();
    const strPassword = n.DecodeStr();
    const passwordQ = n.DecodeStr();
    const passwordA = n.DecodeStr();
    const identityNo = n.DecodeStr();
    const birthday = n.DecodeStr();
    const name = n.DecodeStr();
    const email = n.DecodeStr();
    const emailRcv = n.Decode1();
    const gender = n.Decode1();
    const address = n.DecodeStr();
    const tel = n.DecodeStr();
    const profile = n.DecodeStr();
    const reveal = n.Decode1();
    const regResult = CDBMan_RegisterNewUser(
      this.m_db,
      strId,
      strPassword,
      name,
      email,
      emailRcv,
      gender,
      address,
      tel,
      profile,
      reveal,
      passwordQ,
      passwordA,
      identityNo,
      birthday,
    );
    const packet = new CSendPacket(LS_SendPacket.OnNewUserRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(regResult);
    socket.SendPacket(packet);
  }

  /** CLoginPool::OnReqConnectToSvr (CxLogin.exe.c:14655) */
  OnReqConnectToSvr(n: CReceivedPacket, socket: CClientSocket): void {
    const user = socket.GetUser(0);
    if (user === null || user.GetGlobalSerialNo() === 0) {
      console.error("Global serial number not assigned user try to connect server. Disconnect");
      socket.Close();
      return;
    }
    const nServerType = n.Decode1();
    const nSvrIdx = n.Decode4();
    const nVersion = n.Decode2();
    const gate = this.m_center.CheckEnterGame(nServerType, nSvrIdx, nVersion);
    if (gate === 1) {
      const userCount = socket.GetUserCount();
      const packet = new CSendPacket(MC_ReceivedPacket.OnReqConnectToSvr); // MC
      packet.Encode1(userCount);
      for (let i = 0; i < userCount; i++) packet.Encode4(socket.GetUser(i)!.GetGlobalSerialNo());
      packet.Encode1(nServerType);
      packet.Encode4(nSvrIdx);
      this.m_center.SendFrPacketToCenter(packet);
    } else {
      const packet = new CSendPacket(LS_SendPacket.OnReqConnectToSvrRes, CipherDegree.kPacketEncryptedCRC8);
      packet.Encode1(gate);
      socket.SendPacket(packet);
    }
  }

  /** CLoginPool::OnConnEstablished — the client must never send this here. */
  OnConnEstablished(socket: CClientSocket): void {
    console.error("Login server cannot handle 'kcConnEstablished'. Disconnect");
    socket.Close();
  }

  /** CLoginPool::OnCrashInfo (CxLogin.exe.c:15125) */
  OnCrashInfo(n: CReceivedPacket, socket: CClientSocket): void {
    const str = n.DecodeStr();
    const addr = socket.bunSocket?.remoteAddress ?? "";
    const user = socket.GetUser(0);
    console.log(`CrashInfo(${user?.GetName() ?? "?"}:${str} from ${addr})`);
  }

  /** CLoginPool::OnRequestEnterChannelStage (CxLogin.exe.c:14599) */
  OnRequestEnterChannelStage(n: CReceivedPacket, socket: CClientSocket): void {
    const user = socket.GetUser(0);
    if (user === null || user.GetGlobalSerialNo() === 0) {
      console.error("Unauthenticated user try to notify 'network environment suitable' pakcet");
      socket.Close();
      return;
    }
    const fHashMatch = n.Decode4() === this.m_channelCache.GetHashValue();
    const infoPacket = this.m_channelCache.GetInfoPacket(fHashMatch ? 0 : 1);
    socket.SendPacket(infoPacket);
    socket.SendPacket(this.m_channelCache.GetStatePacket());
    const p14 = new CSendPacket(LS_ClientSend.OnChannelsGameState, CipherDegree.kPacketEncryptedCRC8);
    this.m_center.MakeChannelsGameStatePacket(p14);
    socket.SendPacket(p14);
    const p11 = new CSendPacket(LS_ClientSend.OnChannelsExtraInfo, CipherDegree.kPacketEncryptedCRC8);
    this.m_center.MakeChannelsExtraInfoPacket(p11);
    socket.SendPacket(p11);
  }

  /** CLoginPool::OnRequestDestoryService (CxLogin.exe.c:14743) */
  OnRequestDestoryService(n: CReceivedPacket, socket: CClientSocket): void {
    if (socket.m_nHeaderType === n.Decode4()) {
      const packet = new CSendPacket(LS_SendPacket.OnRequestDestoryServiceRes, CipherDegree.kPacketEncryptedCRC8);
      const roomCode = Math.floor(Math.random() * 0x8000) & 3;
      packet.Encode4(socket.GetLocalSerialNo());
      packet.Encode4(roomCode);
      socket.SendPacket(packet);
      socket.SetGameRoomCode(roomCode);
    } else {
      socket.Close();
    }
  }

  /** CLoginPool::OnCenterResAddNewUser (CxLogin.exe.c:15312) */
  OnCenterResAddNewUser(n: CReceivedPacket): void {
    const localSerialNo = n.Decode4();
    const socket = CClientSocket.GetSocketFromLocalSerialNo(localSerialNo);
    const fAllAdded = n.Decode4();
    const count = n.Decode1();
    const sns: number[] = [];
    const authencodes: number[] = [];
    let fAllSimpleInfo = 1; // cleared when any authencode is the 2 (simple-info) form
    for (let i = 0; i < count; i++) {
      sns.push(n.Decode4());
      if (fAllAdded !== 0) {
        const authencode = n.Decode1();
        authencodes.push(authencode);
        if (authencode === 2) fAllSimpleInfo = 0;
      } else {
        authencodes.push(0);
      }
    }
    if (socket === null) {
      if (fAllAdded !== 0) for (const sn of sns) this.m_center.UnregisterConnection(sn);
      return;
    }
    let fAllFound = 1; // all users still seated on the socket and in the pool
    const users: (CUser | null)[] = [];
    for (let i = 0; i < count; i++) {
      const user = socket.GetUser(i);
      users.push(user);
      if (user !== null && this.FindUser(user)) {
        if (fAllAdded !== 0) {
          user.SetGlobalSerialNo(sns[i]!);
          this.m_localUserTable.Insert(user);
          console.log(`User login(${user.GetName()})`);
        }
      } else {
        fAllFound = 0;
      }
    }
    if (fAllAdded === 0) {
      const packet = new CSendPacket(LS_SendPacket.OnLoginRes, CipherDegree.kPacketEncryptedCRC8);
      packet.Encode1(2);
      socket.SendPacket(packet);
      return;
    }
    if (fAllFound === 0) {
      for (const sn of sns) this.m_center.UnregisterConnection(sn);
      socket.Close();
      return;
    }
    // strDes: the double-login message (EUC-KR when 1 user, "PC" when several).
    let strDes = count <= 1 ? STR_ALREADY_PLAYING : STR_PC;
    const packet = new CSendPacket(LS_SendPacket.OnLoginRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(0);
    packet.Encode2(fAllSimpleInfo !== 0 ? 1 : 0);
    packet.EncodeStr(strDes);
    packet.Encode1(count);
    for (let i = 0; i < count; i++) {
      const user = users[i]!;
      packet.Encode4(sns[i]!);
      packet.EncodeStr(user.strId);
      packet.Encode1(0); // LOBYTE of the never-initialized _USERACCOUNT int (UA+76)
      packet.Encode2(0);
      packet.Encode1(1);
      packet.Encode1(10);
      packet.Encode2(CDynInfoCalculator_GetLevel(user.nFxexp));
      packet.Encode4(user.nFxMoney);
      packet.Encode4(user.nGuildSerialNo);
      packet.Encode1(0);
      packet.EncodeStr(user.strEmail);
      // CUser::CheckVajinishi — the SSN-based adult/gender flags
      const [adult, gender] = CheckVajinishi(user.strSSN1, user.strSSN2);
      packet.Encode1(adult);
      packet.Encode1(gender);
      packet.Encode4(authencodes[i]!);
    }
    packet.EncodeStr(""); // dst — zero-initialized buffer
    socket.SendPacket(packet);
    void strDes;
    strDes = "";
  }
}

/**
 * CUser::CheckVajinishi — the adult/gender flags of login packet 3
 * (CxLogin.exe.c:15500).  adult = today < (digit ≤ 2 ? 1918 : 2018)0000 +
 * atoi(SSN1) → 1; gender = SSN2[0] odd → 1; SSNs missing or digit ∉ [1..4]
 * → 2, 2.
 */
export function CheckVajinishi(ssn1: string, ssn2: string): [number, number] {
  if (ssn1.length === 0 || ssn2.length === 0) return [2, 2];
  const genderDigit = ssn2.charCodeAt(0) - 48;
  if (genderDigit > 4 || genderDigit <= 0) return [2, 2];
  const now = new Date();
  const todayPacked = now.getDate() + 100 * (now.getMonth() + 1 + 100 * now.getFullYear()); // GetLocalTime yyyymmdd
  const birthPacked = 10000 * (genderDigit <= 2 ? 1918 : 2018) + Number.parseInt(ssn1.slice(0, 6), 10);
  const adult = todayPacked - birthPacked < 0 ? 1 : 0;
  const gender = (genderDigit & 1) === 1 ? 1 : 0;
  return [adult, gender];
}

/** CDBMan::InitUser (CxLogin.exe.c:11337) — returns 0 ok, else the failure
 *  code (3 = the stored proc's -1: invalid id/password).  The original also
 *  runs an inert _mbscmp(password, "Invalid User Id and Password!") whose
 *  result no instruction reads (0040B3D3: call __mbscmp; next consumer of
 *  eax never comes) — a dev leftover with no behavior to port. */
function CDBMan_InitUser(db: CDBMan, user: CUser, id: string, pw: string): number {
  let res: ReturnType<CDBMan["prCAAuthUser"]>;
  try {
    res = db.prCAAuthUser(id, EncodePassword(pw));
  } catch {
    // the original's ExecStoredProc < 0 path (CxLogin.exe.c:11433) — a DB
    // layer failure answers code 1, distinct from the proc's own -1 → 3
    console.error("[LS] Fail to open UserDB recordset");
    return 1;
  }
  if (res.retval === -1) return 3;
  user.strId = id;
  user.nFxexp = res.Fxexp;
  user.nTxexp = res.Txexp;
  user.nFxMoney = res.FxMoney;
  user.strEmail = res.Email;
  user.nCommunitySvr = res.CommunitySvr;
  user.SetGuildSerialNo(res.GuildSn);
  user.nSID = res.SID;
  if (res.retval === 10) user.SetPremiumTicket(1);
  return 0;
}

/** CDBMan::RegisterNewUser (CxLogin.exe.c:11465) — 0 ok, 1 fail. */
function CDBMan_RegisterNewUser(
  db: CDBMan,
  id: string,
  password: string,
  name: string,
  email: string,
  emailRcv: number,
  gender: number,
  address: string,
  tel: string,
  profile: string,
  reveal: number,
  passwordQ: string,
  passwordA: string,
  identityNo: string,
  birthday: string,
): number {
  const ret = db.prCreateUser(
    id,
    name,
    EncodePassword(password),
    email,
    emailRcv,
    gender,
    address,
    tel,
    reveal,
    profile,
    passwordQ,
    passwordA,
    identityNo,
    birthday,
  );
  if (ret !== 0) return 1;
  console.log(`[LS] New User [${id}] Created`); // CxLogin.exe.c:10767
  return 0;
}

/** CCenterProcess — the LS side of the center link. */
export class CCenterProcess {
  static ms_pInstance: CCenterProcess | null = null;

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
    await this.m_pCenterSocket.ConnectToCenter(host, port, 1, cfg.GetNumAttribute("ServerIndex"));
    console.log(`[LS] attached to center ${host}:${port}`);
  }

  /** CCenterProcess::SendFrPacketToCenter */
  SendFrPacketToCenter(packet: CSendPacket): void {
    this.m_pCenterSocket?.SendPacket(packet);
  }

  /** CCenterProcess::OnPacket (CxLogin.exe.c:6055) */
  OnPacket(n: CReceivedPacket): void {
    switch (n.Decode1()) {
      case 0:
        this.m_pLoginPool.OnCenterResAddNewUser(n);
        break;
      case 1:
        this.OnCenterResConnectToSvr(n);
        break;
      case 2:
        console.error("Fatal error: Login server cannot handle 'kmcResConnEstablished'");
        break;
      case 3:
        this.OnLocalServerInfo(n);
        break;
      case 4:
        this.OnLocalServerState(n);
        break;
      case 5:
        this.OnLocalGameState(n);
        break;
      case 7:
        this.OnSvrReservedMsg(n);
        break;
      case 8:
        this.OnAdminNotifyMsg(n);
        break;
      case 11:
        this.OnDeleteUser(n);
        break;
      case 13:
        this.OnSystemMsg(n);
        break;
      default:
        return;
    }
  }

  /** CCenterProcess::RegisterConnection (CxLogin.exe.c:4942) — center packet 0. */
  RegisterConnection(socket: CClientSocket): void {
    const packet = new CSendPacket(MC_ReceivedPacket.OnAddNewUser); // MC
    packet.Encode4(PeerAddressDword(socket)); // the client's in_addr (the D4 the center stores as CUser::GetIP)
    packet.EncodeBuffer(socket.GetMachineId(), 16);
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
    const packet = new CSendPacket(MC_ReceivedPacket.OnDeleteUser); // MC
    packet.Encode4(sn);
    this.SendFrPacketToCenter(packet);
  }

  /** CCenterProcess::DestructCenterSvr (CxLogin.exe.c:1406) — center packet 100. */
  DestructCenterSvr(): void {
    const packet = new CSendPacket(MC_ReceivedPacket.OnDestructCenterSvr);
    this.SendFrPacketToCenter(packet);
  }

  /** CCenterProcess::CheckEnterGame (CxLogin.exe.c:5964) */
  CheckEnterGame(nServerType: number, _nSvrIdx: number, nVersion: number): number {
    if (this.m_vtGameState.length === 0) return 0;
    if ((this.m_mapGameState.get(nServerType) ?? 0) === 0) return 5;
    if ((this.m_mapGameVersion.get(nServerType) ?? 0) !== nVersion) return 4;
    return 1;
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
    packet.InitPacket(LS_ClientSend.OnChannelsGameState);
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
    packet.InitPacket(LS_ClientSend.OnChannelsExtraInfo);
    // rotating advertisement: [EStr strImage][E2 Param1][E2 Param2][E2 60]
    const adv = this.GetAdvertisement();
    packet.EncodeStr(adv.strImage);
    packet.Encode2(adv.Param1 & 0xffff);
    packet.Encode2(adv.Param2 & 0xffff);
    packet.Encode2(60);
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
      const packet = new CSendPacket(LS_ClientSend.OnSvrReservedMsg, CipherDegree.kPacketEncryptedCRC8);
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
    const packet = new CSendPacket(LS_ClientSend.OnAdminNotifyMsg, CipherDegree.kPacketEncryptedCRC8);
    packet.EncodeStr(str);
    this.SendToAll(packet);
  }

  /** CCenterProcess::OnSystemMsg (CxLogin.exe.c:5189) — client p30 broadcast. */
  OnSystemMsg(n: CReceivedPacket): void {
    const str = n.DecodeStr();
    const packet = new CSendPacket(LS_ClientSend.OnSystemMsg, CipherDegree.kPacketEncryptedCRC8);
    packet.EncodeStr(str);
    this.SendToAll(packet);
  }

  /** CUserPool::CreateSocketList + SendAll */
  SendToAll(packet: CSendPacket): void {
    for (const socket of [...this.m_pLoginPool.m_setSocket]) {
      if (socket.m_bConnected) socket.SendPacket(packet);
    }
  }

  /** CCenterProcess::OnDeleteUser (CxLogin.exe.c:2431) — center p11. */
  OnDeleteUser(n: CReceivedPacket): void {
    const sn = n.Decode4();
    const user = this.m_pLoginPool.m_localUserTable.FindUserFromGlobalSerialNo(sn);
    if (user !== null) user.GetSocket().Close();
    else console.error("Center server tried to delete the absent user.");
  }

  /** CCenterProcess::OnCenterResConnectToSvr (CxLogin.exe.c:14715) — center p1. */
  OnCenterResConnectToSvr(n: CReceivedPacket): void {
    const count = n.Decode1();
    let user: CUser | null = null;
    let checked = 0;
    if (count !== 0) {
      // walk the serial list; the LAST resolved user's socket gets the reply
      for (;;) {
        const serial = n.Decode4();
        user = this.m_pLoginPool.m_localUserTable.FindUserFromGlobalSerialNo(serial);
        if (user === null) return;
        if (++checked >= count) break;
      }
    }
    const result = n.Decode1();
    const packet = new CSendPacket(LS_SendPacket.OnReqConnectToSvrRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(result);
    if (result === 1) {
      const svrType = n.Decode1();
      const svrIdx = n.Decode4();
      const ip = n.Decode4();
      const port = n.Decode2();
      packet.Encode1(svrType);
      packet.Encode4(svrIdx);
      packet.Encode4(ip);
      packet.Encode2(port);
    }
    user?.GetSocket().SendPacket(packet);
  }
}

/**
 * CMainSystem (CxLogin.exe.c:16669 ctor, 16362 OnConnEstablished) — the LS's
 * accept-greeter.  The ctor reads the UrlPatchNumber/UrlPatch[i] config family
 * into a string table; OnConnEstablished sends the accept packet 0
 * ([E2 3][E2 7][E4 headerType][EStr table entry]) round-robin per connection
 * and the accept path then arms the socket's cipher degree (CListenThread::Proc
 * CxLogin.exe.c:12021-12025: hello → SetCipherDegree(2) → IssueReceive).
 */
class CMainSystem {
  static ms_pInstance: CMainSystem | null = null;

  m_astrUrlPatch: string[] = []; // this+1..+3 (vector<string>)
  m_nUrlPatchIdx = 0; // this+4

  constructor(cfg: CServerConfig) {
    CMainSystem.ms_pInstance = this;
    const n = cfg.GetNumAttribute("UrlPatchNumber");
    for (let i = 0; i < n; i++) this.m_astrUrlPatch.push(cfg.GetAttribute(`UrlPatch${i}`));
  }

  OnConnEstablished(socket: CClientSocket): void {
    const packet = new CSendPacket(LS_ClientSend.OnConnect, CipherDegree.kPacketRaw);
    packet.Encode2(CENTER_VERSION);
    packet.Encode2(CONN_HELLO_VERSION[SVRCLASS_LOGIN]);
    packet.Encode4(socket.m_nHeaderType);
    // round-robin: idx = (idx + 1) % count, then send table[idx]
    if (this.m_astrUrlPatch.length > 0) {
      this.m_nUrlPatchIdx = (this.m_nUrlPatchIdx + 1) % this.m_astrUrlPatch.length;
      packet.EncodeStr(this.m_astrUrlPatch[this.m_nUrlPatchIdx]!);
    } else {
      packet.EncodeStr("");
    }
    socket.SendPacket(packet);
  }
}

/** CxLogin entry (LS_000.cfg). */
export async function main(cfgFile: string, dbDir: string): Promise<void> {
  const cfg = new CServerConfig(CXLOGIN_STR_KEYS);
  cfg.Init(cfgFile);
  CServerConfig.ms_pInstance = cfg;

  PacketLog.Configure("LS");
  PacketLog.Register("LS", "recv", ...PACKET_NAME_TABLES.LS.recv);
  PacketLog.Register("LS", "send", ...PACKET_NAME_TABLES.LS.send);

  const db = new CDBMan(dbDir);
  const multiServer = new CMultiServer();
  multiServer.Init(db);

  const centerProcess = new CCenterProcess(null as unknown as CLoginPool, multiServer, db);
  centerProcess.m_cfg = cfg;
  const loginPool = new CLoginPool(centerProcess, db, multiServer);
  centerProcess.AttachPool(loginPool);
  centerProcess.UpdateLevelLimit();
  centerProcess.UpdateAdvertisement();
  centerProcess.UpdateGuildServerList();

  // MTUDPServer + CUDPPacketDispatcher (CxLogin.exe.c:16086-16098) — the
  // unreliable UDP peer on ServerPort+1 for the 'check udp comm' handshake,
  // started BEFORE CListenThread, exactly like the original's boot order.
  SetLocalUserTableFinder(
    (sn) => CLoginPool.ms_pInstance?.m_localUserTable.FindUserFromGlobalSerialNo(sn) ?? null,
  );
  await new MTUDPServer().StartupBase(0);

  // the client listener (CMainSystem init — ServerPort). The original boots it
  // last: CCenterProcess::Init (with the endless 3 s retry loop) runs before
  // CListenThread::Resume, so the port only opens 3838 once the center is up.
  const port = cfg.GetNumAttribute("ServerPort") || 3838;
  await centerProcess.ConnectToCenter(cfg);

  // CTimerThread::Resume (CxLogin.exe.c:16048 — right after CCenterProcess::Init)
  loginPool.StartTimer(centerProcess);

  const mainSystem = new CMainSystem(cfg);
  const clientSockets = new WeakMap<object, CClientSocket>();
  Bun.listen({
    hostname: "0.0.0.0",
    port,
    socket: {
      open: (t) => {
        const socket = new CClientSocket();
        clientSockets.set(t, socket);
        socket.bunSocket = t as Bun.Socket<any>;
        socket.m_bConnected = true;
        // CListenThread::Proc sets TCP_NODELAY on every accepted client socket
        // (CxLogin.exe.c:12018, optval 1) before the identification exchange.
        (t as Bun.Socket<any>).setNoDelay?.(true);
        // CListenThread::Proc (CxLogin.exe.c:12021-12025) — the accept packet,
        // then SetCipherDegree(2), then the receive loop starts.
        mainSystem.OnConnEstablished(socket);
        socket.SetCipherDegree(CipherDegree.kPacketEncryptedCRC8);
        loginPool.AddSocket(socket);
      },
      data: (t, data) => {
        if (process.env.LS_DEBUG) {
          const b = new Uint8Array(data as Buffer);
          console.error(`[LS_DEBUG] recv ${b.length}B: ${Array.from(b.subarray(0, 64)).map((x) => x.toString(16).padStart(2, "0")).join(" ")}`);
        }
        clientSockets.get(t)?.OnReceive(new Uint8Array(data as Buffer));
      },
      close: (t) => {
        clientSockets.get(t)?.Close();
      },
      error: (_t, err) => console.error(`[LS] ${String(err)}`),
    },
  });
  console.log(`[LS] listening on :${port}`);
}
