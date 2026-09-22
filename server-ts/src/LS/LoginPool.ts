/** Native source unit: CX/CxLogin/LoginPool.cpp. */
import { CReceivedPacket, CSendPacket, CipherDegree } from "../core/Packet.ts";
import { CRand } from "../core/CRand.ts";
import { GetUnixTimeSeconds } from "../core/LocalTime.ts";
import { CDBMan, EncodePassword } from "../db/DBMan.ts";
import { CMultiServer } from "./MultiServer.ts";
import { CChannelCache } from "./ChannelCache.ts";
import { CConfigDyn } from "./ConfigDyn.ts";
import { CDynInfoCalculator_GetLevel } from "../shared/LevelTable.ts";
import { MC_LoginServerSendPacket, SVRCLASS_GAME } from "../core/protocol/CenterProtocol.ts";
import { C2S_LoginPacket, S2C_LoginNoticePacket, S2C_LoginResponsePacket } from "../core/protocol/PacketIDs.ts";
import type { CUser } from "./User.ts";
import { CClientSocket } from "./ClientSocket.ts";
import { CLocalUserTable } from "./LocalUserTable.ts";
import type { CCenterProcess } from "./CenterProcess.ts";
import { RegisterLoginPool } from "./runtime/LoginRuntime.ts";
import { CUserPool } from "./UserPool.ts";

/** "현재 게임을 하고 계시는 곳" (byte_47A458, EUC-KR) — the double-login notice. */
const STR_ALREADY_PLAYING = "\xc7\xf6\xc0\xe7 \xb0\xd4\xc0\xd3\xc0\xbb \xc7\xcf\xb0\xed \xb0\xe8\xbd\xc3\xb4\xc2 \xb0\xf7";
/** aPc (CxLogin.exe.lst: .text:0040F85C push offset aPc ; "PC") */
const STR_PC = "PC";
/** `rand() & 3` at CxLogin 0040EAFF..0040EB08. */
const GAME_ROOM_CODE_MASK = 0x3;

/** CLoginPool extends CUserPool — owns every client socket and the handlers. */
export class CLoginPool extends CUserPool {
  private static m_pInstance: CLoginPool | null = null;

  static get ms_pInstance(): CLoginPool | null {
    return CLoginPool.m_pInstance;
  }

  static set ms_pInstance(pool: CLoginPool | null) {
    CLoginPool.m_pInstance = pool;
    RegisterLoginPool(pool);
  }

  m_localUserTable = new CLocalUserTable();
  m_center: CCenterProcess;
  m_db: CDBMan;
  m_multiServer: CMultiServer;
  m_channelCache = new CChannelCache();

  constructor(
    center: CCenterProcess,
    db: CDBMan,
    multiServer: CMultiServer,
    /** Port logical-worker state corresponding to native CRT TLS. */
    private readonly workerRandom = new CRand(GetUnixTimeSeconds()),
  ) {
    super();
    CLoginPool.ms_pInstance = this;
    this.m_center = center;
    this.m_db = db;
    this.m_multiServer = multiServer;
  }

  /** CLoginPool::OnPacket (CxLogin.exe.c:15254) */
  override OnPacket(n: CReceivedPacket, socket: CClientSocket): void {
    switch (n.Decode1()) {
      case C2S_LoginPacket.OnAskMultiServer:
        this.OnAskMultiServer(n, socket);
        break;
      case C2S_LoginPacket.OnAskFirstInfo:
        this.OnAskFirstInfo(n, socket);
        break;
      case C2S_LoginPacket.OnLogin:
        this.OnLogin(n, socket);
        break;
      case C2S_LoginPacket.OnNewUserConfirmId:
        this.OnNewUserConfirmId(n, socket);
        break;
      case C2S_LoginPacket.OnNewUser:
        this.OnNewUser(n, socket);
        break;
      case C2S_LoginPacket.OnReqConnectToSvr:
        this.OnReqConnectToSvr(n, socket);
        break;
      case C2S_LoginPacket.OnConnEstablished:
        this.OnConnEstablished(socket);
        break;
      case C2S_LoginPacket.OnCrashInfo:
        this.OnCrashInfo(n, socket);
        break;
      case C2S_LoginPacket.OnRequestEnterChannelStage:
        this.OnRequestEnterChannelStage(n, socket);
        break;
      case C2S_LoginPacket.OnRequestDestoryService:
        this.OnRequestDestoryService(n, socket);
        break;
      case C2S_LoginPacket.OnReplyDestoryService:
        n.Decode4();
        this.m_center.DestructCenterSvr();
        break;
      default:
        break;
    }
    n.ResetOffset();
    super.OnPacket(n, socket);
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
    const packet = new CSendPacket(S2C_LoginResponsePacket.OnAskFirstInfoRes, CipherDegree.kPacketEncryptedCRC8);
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
    socket.m_nNoticeHash = n.Decode4();
    if (inited !== 0) {
      const packet = new CSendPacket(S2C_LoginResponsePacket.OnLoginRes, CipherDegree.kPacketEncryptedCRC8);
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
    const packet = new CSendPacket(S2C_LoginResponsePacket.OnNewUserConfirmIdRes, CipherDegree.kPacketEncryptedCRC8);
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
    const packet = new CSendPacket(S2C_LoginResponsePacket.OnNewUserRes, CipherDegree.kPacketEncryptedCRC8);
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
      const packet = new CSendPacket(MC_LoginServerSendPacket.OnReqConnectToSvr); // MC
      packet.Encode1(userCount);
      for (let i = 0; i < userCount; i++) packet.Encode4(socket.GetUser(i)!.GetGlobalSerialNo());
      packet.Encode1(nServerType);
      packet.Encode4(nSvrIdx);
      this.m_center.SendFrPacketToCenter(packet);
    } else {
      const packet = new CSendPacket(S2C_LoginResponsePacket.OnReqConnectToSvrRes, CipherDegree.kPacketEncryptedCRC8);
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
    const p14 = new CSendPacket(S2C_LoginNoticePacket.OnChannelsGameState, CipherDegree.kPacketEncryptedCRC8);
    this.m_center.MakeChannelsGameStatePacket(p14);
    socket.SendPacket(p14);
    const p11 = new CSendPacket(S2C_LoginNoticePacket.OnChannelsExtraInfo, CipherDegree.kPacketEncryptedCRC8);
    this.m_center.MakeChannelsExtraInfoPacket(p11);
    socket.SendPacket(p11);
  }

  /** CLoginPool::OnRequestDestoryService (CxLogin.exe.c:14743) */
  OnRequestDestoryService(n: CReceivedPacket, socket: CClientSocket): void {
    if (socket.m_nHeaderType === n.Decode4()) {
      const packet = new CSendPacket(S2C_LoginResponsePacket.OnRequestDestoryServiceRes, CipherDegree.kPacketEncryptedCRC8);
      const roomCode = this.workerRandom.rand() & GAME_ROOM_CODE_MASK;
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
      const packet = new CSendPacket(S2C_LoginResponsePacket.OnLoginRes, CipherDegree.kPacketEncryptedCRC8);
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
    const packet = new CSendPacket(S2C_LoginResponsePacket.OnLoginRes, CipherDegree.kPacketEncryptedCRC8);
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
      packet.Encode1(SVRCLASS_GAME);
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
    const configDyn = CConfigDyn.ms_pInstance;
    if (configDyn !== null && socket.m_nNoticeHash !== configDyn.GetNoticeHash())
      socket.SendPacket(configDyn.GetNoticePacket());
    void strDes;
    strDes = "";
  }

  /** CLoginPool::OnCenterResConnectToSvr (CxLogin.exe.c:14715) — center p1. */
  OnCenterResConnectToSvr(n: CReceivedPacket): void {
    const count = n.Decode1();
    let user: CUser | null = null;
    let checked = 0;
    if (count !== 0) {
      // walk the serial list; the LAST resolved user's socket gets the reply
      for (;;) {
        const serial = n.Decode4();
        user = this.m_localUserTable.FindUserFromGlobalSerialNo(serial);
        if (user === null) return;
        if (++checked >= count) break;
      }
    }
    const result = n.Decode1();
    const packet = new CSendPacket(S2C_LoginResponsePacket.OnReqConnectToSvrRes, CipherDegree.kPacketEncryptedCRC8);
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

/** CDBMan::RegisterNewUser (0040A700) — 0 on successful SQL execution,
 *  1 on SQL error. prCreateUser's SQLite adapter returns -1 on such errors. */
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
