/**
 * CxShop — the item shop server (FXSS / FxShop.exe).
 *
 * Boot chain (CFxShopApp::SetUp): CServerConfig → CDBMan → CItemMan →
 * CMainPool → CLocalUserTable → CTranxCtrl → CSockRcvMultiplexer →
 * CCenterProcess → CBillingProcess → listeners.
 *
 * Listeners: CListenThread on ServerPort (game clients, CClientSocket,
 * SetCipherDegree(2)) and CListenExThread on ServerPort+1 (the web mall,
 * CWebSocket — first packet is the OnVerifyKey charge handshake).
 */
import { CServerConfig } from "../core/Config.ts";
import { CDBMan } from "../db/DBMan.ts";
import { CReceivedPacket, CSendPacket, enSocket } from "../core/Packet.ts";
import { CPacketSocket, type IPacketSocketHooks } from "../core/CPacketSocket.ts";
import { CLocalSocket } from "../lib/CenterLink.ts";
import {
  BILLING_ReceivedPacket,
  BILLING_SendPacket,
  CLIENTSOCKET_HEADER_CODE_MODIFIER,
  CLIENTSOCKET_HEADER_CODE_RCV,
  CLIENTSOCKET_HEADER_CODE_SND,
  CLIENTSOCKET_SEQ,
  CLIENTSOCKET_SEQ_DELTA,
  SC_SendPacket,
  SS_ReceivedPacket,
} from "../lib/PacketIDs.ts";
import { CM_ReceivedPacket, MC_ReceivedPacket, SVRCLASS_SHOP } from "../lib/S2S.ts";
import { CDynInfoCalculator_GetLevel } from "../login/LevelTable.ts";
import { CItemMan, type ShopItem } from "./CItemMan.ts";

/** The registered cfg keys (the CServerConfig::Init table, .text:0047B520).
 *  Each entry is "key / counter-key" — an empty counter marks a plain key,
 *  a counter marks a family indexed 0..n-1 (the "→歸屬前一 Number" arrows of
 *  the original table). */
const SERVERCONFIG_KEYS: [string, string][] = [
  ["ServerIP", ""],
  ["ServerPort", ""],
  ["ServerName", ""],
  ["ServerIndex", ""],
  ["CenterIP", ""],
  ["CenterPort", ""],
  ["UDBNumber", ""],
  ["UDBIP", "UDBNumber"],
  ["UDBCatalog", "UDBNumber"],
  ["UDBDomain", "UDBNumber"],
  ["UDBIdx", ""],
  ["InventoryDBNumber", ""],
  ["InventoryDBIP", "InventoryDBNumber"],
  ["InventoryDBCatalog", "InventoryDBNumber"],
  ["InventoryDBDomain", "InventoryDBNumber"],
  ["InventoryDBIdx", "InventoryDBNumber"],
  ["ItemDBIP", ""],
  ["ItemDBCatalog", ""],
  ["ConfigDBIP", ""],
  ["ConfigDBCatalog", ""],
];

/** CServerConfig::Init (0041DC30) — every cfg key outside the registered
 *  table logs "! No registered server attribute key: %s"; a missing key
 *  simply reads as "" (no throw). */
export function ValidateShopConfig(cfg: CServerConfig): void {
  const registered = new Set<string>();
  for (const [key, counter] of SERVERCONFIG_KEYS) {
    registered.add(key);
    if (counter !== "") {
      const n = cfg.GetNumAttribute(counter);
      for (let i = 0; i < n; i++) registered.add(`${key}${i}`);
    }
  }
  for (const key of cfg.GetKeys()) {
    if (!registered.has(key)) console.error(`! No registered server attribute key: ${key}`);
  }
}

// ============================ _USERACCOUNT / _USERDYNINFO ============================

/** _USERACCOUNT — the prGetUserInfoShop out-param block (0x84 bytes).
 *  Only the fields that flow onward are materialized; the port keeps them
 *  typed. */
export interface USERACCOUNT {
  SN: number; // @SN
  Name: string; // @Name
  Password: string; // @Password
  Email: string; // @Email
  EmailRcv: number; // @EmailRcv
  Gender: number; // @Gender
  Address: string; // @Address
  Tel: string; // @Tel
  Reveal: number; // @Reveal
  Profile: string; // @Profile
  TotalConn: number; // @TotalConn
  LastConn: string | null; // @LastConn (CTime)
  Permission: number; // @Permission
  money: number; // @money
  win: number; // @win
  draw: number; // @draw
  lose: number; // @lose
  ShopCardNo: number; // @ShopCardNo (byte)
  CommunitySvr: number; // @CommunitySvr (u16)
}

/** _USERDYNINFO — the prGetUserDynamic out-param block (0x20 bytes). */
export interface USERDYNINFO {
  Exp: number;
  Money: number;
  Win: number;
  Draw: number;
  Lose: number;
  PremiumDate: string | null;
}

/** UserInventory — the 0x54 row CUser::MakeUserInventoryPacket encodes:
 *  [E4 +0][E1 +0x24][E4 +0x28][EStr +0x2C][8B GetVariantTime@+0x38]. */
export class UserInventory {
  SN = 0; // +0 the inventory row SN
  Slot = 0; // +0x24 (byte)
  ItemSN = 0; // +0x28
  Verbose = ""; // +0x2C
  dateAcquired: Date | null = null; // +0x38 CTime
}

// ============================ CUser ============================

/** CUser — the shop-side user (0xC30 bytes in the original; only fields the
 *  handlers touch are modeled). */
export class CUser {
  m_strName = ""; // CNamedObject (lowercased index key)
  m_nGlobalSerialNo = 0;
  m_pSocket: CClientSocket | null = null; // +3092
  m_fConnEstablished = 0; // +20 — set once CM 2 confirms the user
  m_nAuthenCode = 0; // +3116 (byte) — the CM 2 authencode (1 → [E1 1][E1 101])
  m_nSID = -1; // +3108 — CUser::GetSID/SetSID (the account SID); the shop never
  // writes it (CUser::SetSID has no callers in FxShop), so MC 3 always carries -1
  m_nBID = -1; // +3112 — CUser::GetBID/SetBID (the SID pair's second dword)
  m_strCoupon = ""; // +3008 — the client 219 coupon (CMainPool::OnRequestUseCoupon)
  m_strCouponId = ""; // +3032 — the client 219 registered id
  m_strTranxInfo = ""; // +2900 — the per-user transaction string (ResetTranxInfo clears it)
  m_nUserAccountHiword = 0; // +152 = _USERACCOUNT+128 — the billing tail E2 (HIWORD)
  m_nCash = 0; // +128 — the cached FxUserDynamic.Money
  m_nSelectedUserIdx = 0; // socket-side selection
  m_nLevel = 0; // +3100 — CUser::SetLevel (CDynInfoCalculator::GetLevel(Exp))
  m_strNexonClubId = ""; // +0xBC — CUser::SetNexonClubId
  m_vecUserInventory: UserInventory[] = []; // +0xC8 — grows with purchases
  m_fModifiedClient = 0;
  m_nConnCount = 0;

  constructor(socket: CClientSocket | null) {
    this.m_pSocket = socket;
  }

  GetName(): string {
    return this.m_strName;
  }

  SetName(name: string): void {
    this.m_strName = name;
  }

  GetGlobalSerialNo(): number {
    return this.m_nGlobalSerialNo;
  }

  SetGlobalSerialNo(n: number): void {
    this.m_nGlobalSerialNo = n;
  }

  /** CUser::SetLevel — CDynInfoCalculator::GetLevel(dyninfo Exp). */
  SetLevel(dyn: USERDYNINFO): void {
    this.m_nLevel = CDynInfoCalculator_GetLevel(dyn.Exp);
  }

  /** CUser::SetNexonClubId — from the account profile prefix (FxShop builds it
   *  from the account SN/CommunitySvr pair; kept verbatim from the account). */
  SetNexonClubId(account: USERACCOUNT): void {
    this.m_strNexonClubId = account.CommunitySvr ? String(account.SN) : "";
  }

  /** CUser::ResetTranxInfo — clears the in-flight purchase state. */
  ResetTranxInfo(): void {
    this.m_nTranxSerial = 0;
  }

  m_fTranxInProgress = 0; // user+20 — the billing-tranx guard (210/214/221/223)
  m_fRemainCashRequested = 0; // user+3048 — set by the 214 handler
  m_fCartProcessing = 0; // user+3056 — set while a cart purchase walks
  m_nChargeKey = 0; // user+2280 — the OnVerifyKey charge key
  m_pChargeSocket: CWebSocket | null = null; // user+12 — bound by OnVerifyKey
  m_pPurchaseTranx: object | null = null; // user+2160 — the in-flight purchase tranx
  m_nTranxSerial = 0; // user+2328 — the billing correlation id
  m_anCart: { stockSN: number; cnt: number }[] = []; // user+2920 (2 dwords per entry)
  m_nCartCount = 0; // user+3052
}

// ============================ CClientSocket ============================

/** CClientSocket — the 9801 client connection (CListenThread accept).
 *  Every accepted socket gets SetCipherDegree(2) (CFxShopApp::SetUp). */
export class CClientSocket extends CPacketSocket {
  static ms_nHeaderTypeCounter = 0;
  static ms_tblSN2Obj = new Map<number, CClientSocket>();

  m_nLocalSerialNo = 0;
  m_dwLastRTT = 0;
  m_dwIdleTime = Date.now() - 5000;
  m_apUser: (CUser | null)[] = []; // +460
  m_nUserCount = 0; // +456
  m_nSelectedUserIdx = 0; // +464 (u16)
  m_strPeerAddress = ""; // CSocket::GetAddressString

  constructor() {
    super(CPacketSocket.dwRcvBufferSize, CPacketSocket.dwSndBufferSize, {
      onPacket: (_sock, packet) => CMainPool.ms_pInstance?.OnPacket(packet, this),
      onClose: () => this.Close(),
    });
    this.m_nLocalSerialNo = CClientSocket.ms_tblSN2Obj.size + 1;
    this.SetHeaderType(CClientSocket.ms_nHeaderTypeCounter % 16);
    CClientSocket.ms_nHeaderTypeCounter++;
    this.SetHeaderCode(CLIENTSOCKET_HEADER_CODE_RCV, CLIENTSOCKET_HEADER_CODE_SND, CLIENTSOCKET_HEADER_CODE_MODIFIER);
    this.SetSequence(CLIENTSOCKET_SEQ_DELTA, CLIENTSOCKET_SEQ_DELTA, CLIENTSOCKET_SEQ, CLIENTSOCKET_SEQ);
    this.SetCipherDegree(2); // CFxShopApp::SetUp — the client sockets are ciphered
    CClientSocket.ms_tblSN2Obj.set(this.m_nLocalSerialNo, this);
  }

  /** CClientSocket::AddNewUsers — the shop is single-user per socket. */
  AddNewUsers(n: number): void {
    this.m_apUser = [];
    for (let i = 0; i < n; i++) this.m_apUser.push(new CUser(this));
    this.m_nUserCount = n;
  }

  GetUser(a2: number): CUser | null {
    return this.m_apUser[a2] ?? null;
  }

  GetUserCount(): number {
    return this.m_nUserCount;
  }

  Close(): void {
    if (!this.m_bConnected) return;
    CMainPool.ms_pInstance?.DeleteSocket(this);
    for (const user of this.m_apUser) {
      if (!user) continue;
      CLocalUserTable.ms_pInstance?.Remove(user);
      user.m_pSocket = null;
    }
    this.m_apUser = [];
    this.m_nUserCount = 0;
    CClientSocket.ms_tblSN2Obj.delete(this.m_nLocalSerialNo);
    super.Close();
  }
}

// ============================ CLocalUserTable ============================

/** CLocalUserTable — the name/serial indexes (name keys lowercased). */
export class CLocalUserTable {
  static ms_pInstance: CLocalUserTable | null = null;

  private byName = new Map<string, CUser>();
  private bySN = new Map<number, CUser>();

  constructor() {
    CLocalUserTable.ms_pInstance = this;
  }

  /** CLocalUserTable::Insert — 1 on success, 0 when the name/serial is taken. */
  Insert(user: CUser): number {
    const key = user.GetName().toLowerCase();
    if (this.byName.has(key) || this.bySN.has(user.GetGlobalSerialNo())) return 0;
    this.byName.set(key, user);
    this.bySN.set(user.GetGlobalSerialNo(), user);
    return 1;
  }

  /** CLocalUserTable::Remove */
  Remove(user: CUser): void {
    this.byName.delete(user.GetName().toLowerCase());
    if (this.bySN.get(user.GetGlobalSerialNo()) === user) this.bySN.delete(user.GetGlobalSerialNo());
  }

  /** CLocalUserTable::FindUser */
  FindUser(name: string): CUser | null {
    return this.byName.get(name.toLowerCase()) ?? null;
  }

  /** CLocalUserTable::FindUserFromGlobalSerialNo */
  FindUserFromGlobalSerialNo(sn: number): CUser | null {
    return this.bySN.get(sn) ?? null;
  }
}

// ============================ CUserPool ============================

/** CUserPool — the socket/user sets plus the 20-RTT fallback dispatch. */
export class CUserPool {
  m_setSocket = new Set<CClientSocket>();
  m_setUser = new Set<CUser>();

  AddSocket(socket: CClientSocket): void {
    this.m_setSocket.add(socket);
  }

  DelSocket(socket: CClientSocket): void {
    this.m_setSocket.delete(socket);
  }

  /** CUserPool::AddNewSocket */
  AddNewSocket(socket: CClientSocket): number {
    for (const user of socket.m_apUser) if (user) this.m_setUser.add(user);
    this.AddSocket(socket);
    this.OnAddNewSocket(socket);
    return 1;
  }

  /** CUserPool::DeleteSocket */
  DeleteSocket(socket: CClientSocket): number {
    for (const user of socket.m_apUser) {
      if (user && !this.m_setUser.has(user)) return 0;
    }
    for (const user of socket.m_apUser) if (user) this.m_setUser.delete(user);
    this.OnDeleteSocket(socket);
    this.DelSocket(socket);
    return 1;
  }

  OnAddNewSocket(_socket: CClientSocket): void {}

  OnDeleteSocket(_socket: CClientSocket): void {}

  /** CUserPool::OnPacket — the default branch: packet 20 RTT echo only.
   *  [E4 t] → client 20 [E4 t][E4 now]. */
  OnPacket(n: CReceivedPacket, socket: CClientSocket): void {
    if (n.Decode1() !== SS_ReceivedPacket.OnEstimateRTT) return;
    const packet = new CSendPacket(SC_SendPacket.OnEstimateRTTRes, 2);
    const t = n.Decode4();
    const now = Date.now() & 0x7fffffff;
    packet.Encode4(t);
    packet.Encode4(now);
    socket.m_dwLastRTT = now;
    socket.SendPacket(packet);
  }

  /** CUserPool::CreateSocketList + SendAll — snapshot then broadcast. */
  static CreateSocketList(pool: CUserPool): CClientSocket[] {
    return [...pool.m_setSocket];
  }

  static SendAll(sockets: CClientSocket[], packet: CSendPacket): void {
    for (const socket of sockets) socket.SendPacket(packet);
  }

  /** CUserPool::OnTimer — disconnect sockets idle past 0x9C40 ms. */
  DisconnectTimeoutSocket(): void {
    const now = Date.now();
    for (const socket of [...this.m_setSocket]) {
      if (now - socket.m_dwIdleTime > 0x9c40) {
        console.error("[Shop] Disconnect timeout socket");
        socket.Close();
      }
    }
  }
}

// ============================ CMainPool ============================

// FxShop.exe @0x47ECA0 — 購買商品時發生錯誤 (Big5, embedded as latin1 so the
// wire bytes are the original ANSI bytes)
const ERR_PURCHASE =
    "\xc1\xca\xb6\x52\xb0\xd3\xab\x7e\xae\xc9\xb5\x6f\xa5\xcd\xbf\xf9\xbb\x7e";

/** CMainPool — the client dispatch (FxShop.exe.c:20547). */
export class CMainPool extends CUserPool {
  static ms_pInstance: CMainPool | null = null;

  billingProcess!: CBillingProcess; // the digicell link (wired by CxShop's ctor)

  constructor(public db: CDBMan) {
    super();
    CMainPool.ms_pInstance = this;
  }

  /** CMainPool::OnPacket — the 20547 switch; unknown ids fall to
   *  CUserPool::OnPacket (the 20 RTT handler). */
  OnPacket(n: CReceivedPacket, socket: CClientSocket): void {
    const type = n.Decode1();
    switch (type) {
      case SS_ReceivedPacket.OnReqConnectToSvr:
        this.OnReqConnectToSvr(n, socket);
        return;
      case SS_ReceivedPacket.OnConnEstablished:
        this.OnConnEstablished(n, socket);
        return;
      case SS_ReceivedPacket.RequestRemainCashTw:
        this.OnRequestRemainCash(n, socket);
        return;
      case SS_ReceivedPacket.OnReqPurchase:
        this.OnReqPurchase(n, socket);
        return;
      case SS_ReceivedPacket.OnRequestDeleteItem:
        this.OnRequestDeleteItem(n, socket);
        return;
      case SS_ReceivedPacket.OnUserSlotInfo:
        this.OnUserSlotInfo(n, socket);
        return;
      case SS_ReceivedPacket.OnRequestModifyItemVerbose:
        this.OnRequestModifyItemVerbose(n, socket);
        return;
      case SS_ReceivedPacket.OnRequestShopItemList:
        CItemMan.ms_pInstance!.SendShopItemList(socket);
        return;
      case SS_ReceivedPacket.OnRequestCharge:
        this.OnRequestCharge(n, socket);
        return;
      case SS_ReceivedPacket.OnRequestStringTable:
        CItemMan.ms_pInstance!.SendStringTable(socket);
        return;
      case SS_ReceivedPacket.OnRequestUserItemList:
        this.OnRequestUserItemList(n, socket);
        return;
      case SS_ReceivedPacket.OnRequestPresent:
        this.OnRequestPresent(n, socket);
        return;
      case SS_ReceivedPacket.OnRequestUseCoupon:
        this.OnRequestUseCoupon(n, socket);
        return;
      case SS_ReceivedPacket.OnRequestPackageMap:
        CItemMan.ms_pInstance!.SendPackageMap(socket);
        return;
      case SS_ReceivedPacket.OnRequestCartList:
        this.OnRequestCartList(n, socket);
        return;
      case SS_ReceivedPacket.OnRequestAddCartList:
        this.OnRequestAddCartList(n, socket);
        return;
      case SS_ReceivedPacket.OnReqPurchaseCartList:
        this.OnReqPurchaseCartList(n, socket);
        return;
      case SS_ReceivedPacket.OnReqDigiQAuthorization:
        this.OnReqDigiQAuthorization(n, socket);
        return;
      case SS_ReceivedPacket.OnRequestTranxData:
        this.OnRequestTranxData(n, socket);
        return;
      case SS_ReceivedPacket.OnRequestShopSvrInfo:
        this.OnRequestShopSvrInfo(n, socket);
        return;
      default: {
        // CUserPool::OnPacket — rewind the type byte first
        n.m_uOffset = 0;
        super.OnPacket(n, socket);
      }
    }
  }

  /** CMainPool::OnConnEstablished — client 7:
   *  [E1 count][count×(EStr name, E4 serial)][E1 selectedIdx].  Registers the
   *  users (CLocalUserTable), stores the selection on the socket (+464), and
   *  answers with center MC 3 — the CShopServer 3-columns-per-user variant
   *  [E1 n][n×(EStr, E4 serial(+3096), E4 flag(+3108))]. */
  OnConnEstablished(n: CReceivedPacket, socket: CClientSocket): void {
    const count = n.Decode1();
    if (count !== 1 && count !== 2) {
      console.error("[Shop] Connect Established UserNo Invalid");
      socket.Close();
      return;
    }
    socket.AddNewUsers(count);
    this.AddNewSocket(socket);
    let i = 0;
    for (; i < count; i++) {
      const user = socket.GetUser(i)!;
      const name = n.DecodeStr();
      const sn = n.Decode4();
      user.SetName(name);
      user.SetGlobalSerialNo(sn);
      if (CLocalUserTable.ms_pInstance!.Insert(user) === 0) break;
    }
    if (i < count) {
      console.error(`[Shop] Cannot insert user to local user table, ${i} th user`);
      for (let j = 0; j < i; j++) CLocalUserTable.ms_pInstance!.Remove(socket.GetUser(j)!);
      socket.Close();
      return;
    }
    socket.m_nSelectedUserIdx = n.Decode1();
    // → center MC 3 with the shop's extra per-user SID column (user+3108)
    const p = new CSendPacket(MC_ReceivedPacket.OnConnEstablished);
    p.Encode1(count);
    for (let j = 0; j < count; j++) {
      const u = socket.GetUser(j)!;
      p.EncodeStr(u.GetName());
      p.Encode4(u.GetGlobalSerialNo());
      p.Encode4(u.m_nSID); // CUser::GetSID — always -1 in the shop
    }
    CCenterProcess.ms_pInstance?.SendPacket(p);
  }

  /** CMainPool::OnReqConnectToSvr — client 6 [E2 svrIdx][E1 x][E4 y]? — the
   *  shop decodes [E2] then forwards center MC 2:
   *  [E1 n][n×E4 serial][E1 type][E4 x]. */
  OnReqConnectToSvr(n: CReceivedPacket, socket: CClientSocket): void {
    const type = n.Decode2();
    const x = n.Decode4();
    const user = socket.GetUser(socket.m_nSelectedUserIdx);
    if (!user) return;
    const p = new CSendPacket(MC_ReceivedPacket.OnReqConnectToSvr);
    const serials: number[] = [];
    for (const u of socket.m_apUser) if (u) serials.push(u.GetGlobalSerialNo());
    p.Encode1(serials.length);
    for (const sn of serials) p.Encode4(sn);
    p.Encode1(type);
    p.Encode4(x);
    CCenterProcess.ms_pInstance?.SendPacket(p);
  }

  /** CMainPool::OnCenterResConnectToSvr — center CM 1:
   *  [E1 n][n×E4 serial][E1 result][==1: E1 svrType, E4 idx, E4 ip, E2 port].
   *  The reply rides client 6 to the first user (in serial order) that is in
   *  the local table and not in a billing tranx (user+20 == 0). */
  OnCenterResConnectToSvr(n: CReceivedPacket): void {
    const count = n.Decode1();
    const serials: number[] = [];
    for (let i = 0; i < count; i++) serials.push(n.Decode4());
    let target: CUser | null = null;
    for (let i = 0; i < count; i++) {
      const u = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(serials[i]!);
      if (u !== null && u.m_fTranxInProgress === 0) {
        target = u;
        break;
      }
    }
    if (!target || !target.m_pSocket) return;
    const result = n.Decode1();
    const p = new CSendPacket(SC_SendPacket.OnResConnectToSvr, 2);
    p.Encode1(result);
    if (result === 1) {
      const svrType = n.Decode1();
      const svrIdx = n.Decode4();
      const ip = n.Decode4();
      const port = n.Decode2();
      p.Encode1(svrType);
      p.Encode4(svrIdx);
      p.Encode4(ip);
      p.Encode2(port);
    }
    target.m_pSocket.SendPacket(p);
  }

  /** CMainPool::OnCenterResConnEstablished — center CM 2, the shop variant:
   *  [E1 n][n×(E4 serial, E1 authencode, E1 billingFlag)][E1 result].
   *  On success each user's account/dyninfo reload and the client 18
   *  initial-info packet go out (+207/201 when anyone owns inventory). */
  OnCenterResConnEstablished(n: CReceivedPacket): void {
    const count = n.Decode1();
    const serials: number[] = [];
    const authencodes: number[] = []; // the v26 byte array
    const billingFlags: number[] = []; // the ptr+24 dword array
    for (let i = 0; i < count; i++) {
      serials.push(n.Decode4());
      authencodes.push(n.Decode1());
      billingFlags.push(n.Decode1());
    }
    const result = n.Decode1();

    // resolve every user + reload the _USERACCOUNT/_USERDYNINFO pair; any
    // miss zeroes the ok flag and the original closes serial[0]'s socket
    let ok = true;
    const users: (CUser | null)[] = [];
    for (let i = 0; i < count; i++) {
      const u = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(serials[i]!);
      if (!u) { ok = false; break; }
      users.push(u);
    }
    const accounts: USERACCOUNT[] = [];
    const dyns: USERDYNINFO[] = [];
    for (let i = 0; ok && i < count; i++) {
      const row = this.db.prGetUserInfoShop(users[i]!.GetName());
      if (!row) { ok = false; break; }
      accounts.push({
        SN: row.SN, Name: row.Name, Password: row.Password, Email: row.Email, EmailRcv: row.EmailRcv,
        Gender: row.Gender, Address: row.Address, Tel: row.Tel, Reveal: row.Reveal, Profile: row.Profile,
        TotalConn: row.TotalConn, LastConn: row.LastConn, Permission: row.Permission, money: row.money,
        win: row.win, draw: row.draw, lose: row.lose, ShopCardNo: row.ShopCardNo, CommunitySvr: row.CommunitySvr,
      });
      dyns.push({
        Exp: (this.db.prGetUserDynamic(users[i]!.GetName()) as { Exp?: number } | undefined)?.Exp ?? 0,
        Money: row.money, Win: row.win, Draw: row.draw, Lose: row.lose, PremiumDate: null,
      });
    }

    // the v27==0 tail: close serial[0]'s socket (no reply anywhere)
    if (!ok) {
      const first = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(serials[0]!);
      first?.m_pSocket?.Close();
      return;
    }

    // the socket comes from serial[0]'s user; the target from ITS SelectedUserIdx
    const first = users[0]!;
    const socket = first.m_pSocket;
    if (!socket) return;
    const sel = socket.m_nSelectedUserIdx;
    if (sel > 2) {
      console.error(`[Shop] Invalid SelectedUserIdx (${sel})`);
      socket.Close();
      return;
    }
    const target = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(serials[sel] ?? serials[0]!);
    if (!target || !this.m_setUser.has(target)) {
      socket.Close();
      return;
    }
    if (result === 0) {
      const name = target.GetName();
      console.error(
        `[Shop] Connection failed from center server(${name}:0x${target.GetGlobalSerialNo().toString(16).padStart(8, "0")})`,
      );
      socket.Close();
      return;
    }

    // _USERACCOUNT::operator= + the dyninfo copy; SetLevel / SetNexonClubId;
    // user+3116 = the authencode of the selected user
    const account = accounts[sel] ?? accounts[0]!;
    const dyn = dyns[sel] ?? dyns[0]!;
    target.m_nCash = dyn.Money;
    target.SetLevel(dyn);
    target.SetNexonClubId(account);
    target.m_nAuthenCode = authencodes[sel] ?? 0;

    // client 18 OnInitialInfo
    const itemMan = CItemMan.ms_pInstance!;
    const system = CxShop.ms_pInstance!;
    const p = new CSendPacket(SC_SendPacket.OnInitialInfo, 2);
    if (target.m_nAuthenCode === 1) {
      p.Encode1(1);
      p.Encode1(101);
    } else {
      p.Encode1(0);
    }
    p.Encode4(itemMan.m_nShopItemHash);
    p.Encode4(itemMan.m_nStringHash);
    p.Encode4(itemMan.m_nPackageMapHash);
    p.EncodeStr(system.m_strChargeUrl);
    p.EncodeStr(system.m_strAuthUrl);
    p.Encode1(1);
    p.Encode1(0);
    p.Encode1(1);
    p.Encode1(billingFlags[sel] ?? 0);
    if ((billingFlags[sel] ?? 0) !== 0) this.billingProcess.RequestRemainCashTw(target);
    itemMan.MakeBonusMap(p);
    target.m_pSocket?.SendPacket(p);

    // 207/201 only when any of the users already owns inventory (the shop
    // never fills the in-memory vectors — purchases go straight to the DB —
    // so in practice this branch stays silent, exactly like the original).
    if (users.some((u) => u && u.m_vecUserInventory.length > 0)) {
      const p207 = new CSendPacket(SC_SendPacket.OnPreInventory, 2);
      p207.Encode1(users.length);
      for (const u of users) this.MakePreInventoryPacket(u!, p207);
      target.m_pSocket?.SendPacket(p207);
      const p201 = new CSendPacket(SC_SendPacket.OnUserInventory, 2);
      p201.Encode1(users.length);
      for (const u of users) this.MakeUserInventoryPacket(u!, p201);
      target.m_pSocket?.SendPacket(p201);
    }
  }

  /** CUser::MakePreInventoryPacket — the 207 shell: [E1 0] (the original body
   *  is `retn 4`, so the list is always empty). */
  MakePreInventoryPacket(_user: CUser, packet: CSendPacket): void {
    packet.Encode1(0);
  }

  /** CUser::MakeUserInventoryPacket — 201: [E1 n][n×(E4 SN, E1 slot, E4 ItemSN,
   *  EStr verbose, 8B CTime)]. */
  MakeUserInventoryPacket(user: CUser, packet: CSendPacket): void {
    packet.Encode1(user.m_vecUserInventory.length);
    for (const inv of user.m_vecUserInventory) {
      packet.Encode4(inv.SN);
      packet.Encode1(inv.Slot);
      packet.Encode4(inv.ItemSN);
      packet.EncodeStr(inv.Verbose);
      packet.EncodeBuffer(variantTime(inv.dateAcquired), 8);
    }
  }

  /** client 205 → CBillingProcess::RequestRemainCashTw (no client reply in
   *  this handler — the answer comes back through billing 302). */
  OnRequestRemainCash(_n: CReceivedPacket, socket: CClientSocket): void {
    const user = socket.GetUser(socket.m_nSelectedUserIdx);
    if (!user) return;
    this.billingProcess.RequestRemainCashTw(user);
  }

  /** CMainPool::OnReqPurchase — client 206 [E2 stockSN]: ignored unless the
   *  stock item exists; then OnReqPurchaseStockItem. */
  OnReqPurchase(n: CReceivedPacket, socket: CClientSocket): void {
    const stockSN = n.Decode2();
    if (CItemMan.ms_pInstance!.GetShopItem(stockSN) === null) return;
    const user = socket.GetUser(socket.m_nSelectedUserIdx);
    if (!user) return;
    this.OnReqPurchaseStockItem(user, stockSN);
  }

  /** CMainPool::OnReqPurchaseStockItem — the purchase state machine.
   *  Replies ride client 204 [E1 code][EStr message]. */
  OnReqPurchaseStockItem(user: CUser, stockSN: number): void {
    const itemMan = CItemMan.ms_pInstance!;
    const shopItem = itemMan.GetShopItem(stockSN);
    if (!shopItem) {
      this.PurchaseError(user, 1, ERR_PURCHASE);
      return;
    }
    // a purchase tranx already in flight (user+2160) → error 1
    if (user.m_pPurchaseTranx !== null) {
      this.PurchaseError(user, 1, ERR_PURCHASE);
      return;
    }
    const id = user.GetName();

    // package sub-items: every FxPackageMap row of this stock SN must pass
    if (itemMan.GetPackageMapList(shopItem.SN).length !== 0) {
      for (const pkg of itemMan.GetPackageMapList(shopItem.SN)) {
        const sub = itemMan.GetShopItem(pkg.StockSN);
        if (!sub) {
          this.PurchaseError(user, 5, ERR_PURCHASE);
          user.ResetTranxInfo();
          return;
        }
        const owned = this.db.prIsValidInventory(id, sub.ItemSN) + this.db.prIsValidPreInventory(id, sub.ItemSN);
        if (owned !== 0 && sub.Category !== 1 && shopItem.Category !== 15 && sub.Category !== 13) {
          this.PurchaseError(user, 4, ERR_PURCHASE);
          user.ResetTranxInfo();
          return;
        }
        const ui = itemMan.GetUserItem(sub.ItemSN);
        if (ui && owned >= ui.nAttr1 && sub.Category === 13) continue;
        if (!ui || owned >= ui.nAttr1) {
          this.PurchaseError(user, 11, formatLimit(ui?.nAttr1 ?? 0));
          user.ResetTranxInfo();
          return;
        }
      }
    } else {
      const owned =
        this.db.prIsValidInventory(id, shopItem.ItemSN) + this.db.prIsValidPreInventory(id, shopItem.ItemSN);
      const ui = itemMan.GetUserItem(shopItem.ItemSN);
      if (!ui) {
        console.error(`[Shop] Invalid item sn (OnReqPurchaseStockItem) = ${shopItem.ItemSN}`);
        this.PurchaseError(user, 1, ERR_PURCHASE);
        user.ResetTranxInfo();
        return;
      }
      if (owned >= ui.nAttr1) {
        this.PurchaseError(user, 11, formatLimit(ui.nAttr1));
        user.ResetTranxInfo();
        return;
      }
      if (owned !== 0 && shopItem.Category !== 1 && shopItem.Category !== 15 && shopItem.Category !== 13) {
        this.PurchaseError(user, 4, ERR_PURCHASE);
        user.ResetTranxInfo();
        return;
      }
    }

    // MoneyType 0 = the digicell billing path (a silent no-op while the
    // billing link is down — the original never replies either).
    if (shopItem.MoneyType === 0) {
      this.billingProcess.RequestPurchaseTw(user, shopItem);
      return;
    }

    // MoneyType != 0 = the cash path against the cached user+124 cash
    if (shopItem.Price > user.m_nCash) {
      this.PurchaseError(user, 1, ERR_PURCHASE);
      return;
    }
    let ok: number;
    if (shopItem.Category === 9) {
      // the premium-ticket stock: prSetPremiumTicket + authencode 1
      ok = this.db.prSetPremiumTicket(id, shopItem.ValidityPeriod);
      if (ok !== 0) CCenterProcess.ms_pInstance?.SendAuthenCode(user.GetGlobalSerialNo(), 1);
    } else {
      ok = this.db.prAddInventoryShop(id, shopItem.ItemSN, shopItem.SN, shopItem.Unit, shopItem.ValidityPeriod, user.m_nLevel);
    }
    if (ok === 0) {
      this.PurchaseError(user, 1, ERR_PURCHASE);
      return;
    }
    this.db.prSetMoney(id, -shopItem.Price);
    user.m_nCash -= shopItem.Price;
    // success: client 204 [E1 0][8B SystemTimeToVariantTime double]
    const p = new CSendPacket(SC_SendPacket.OnPurchaseRes, 2);
    p.Encode1(0);
    p.EncodeBuffer(variantTime(new Date()), 8);
    user.m_pSocket?.SendPacket(p);
  }

  PurchaseError(user: CUser, code: number, msg: string): void {
    const p = new CSendPacket(SC_SendPacket.OnPurchaseRes, 2);
    p.Encode1(code);
    p.EncodeStr(msg);
    user.m_pSocket?.SendPacket(p);
  }

  /** CMainPool::OnRequestDeleteItem — client 207 [E4 itemSN] (>= 0):
   *  CDBMan::DeleteInventory.  No client reply. */
  OnRequestDeleteItem(n: CReceivedPacket, socket: CClientSocket): void {
    const itemSN = n.Decode4();
    if (itemSN < 0) return;
    const user = socket.GetUser(socket.m_nSelectedUserIdx);
    if (!user) return;
    this.db.prDeleteInventory(user.GetName(), itemSN);
  }

  /** CMainPool::OnUserSlotInfo — client 210 [E2 n][n×(E1 slot, E2 itemSN)],
   *  guarded by user+20; CDBMan::UpdateInventorySlot per pair.  No reply. */
  OnUserSlotInfo(n: CReceivedPacket, socket: CClientSocket): void {
    const count = n.Decode2();
    const user = socket.GetUser(socket.m_nSelectedUserIdx);
    if (!user || user.m_fTranxInProgress !== 0) return;
    for (let i = 0; i < count; i++) {
      if (user.m_fTranxInProgress !== 0) break;
      const slot = n.Decode1();
      const itemSN = n.Decode2();
      this.db.prUpdateInventorySlot(user.GetName(), itemSN, slot);
    }
  }

  /** CMainPool::OnRequestModifyItemVerbose — client 212
   *  [E1 slot][E4 itemSN][EStr verbose] → prUpdateInventoryVerbose. */
  OnRequestModifyItemVerbose(n: CReceivedPacket, socket: CClientSocket): void {
    n.Decode1(); // slot
    const itemSN = n.Decode4();
    const verbose = n.DecodeStr();
    const user = socket.GetUser(socket.m_nSelectedUserIdx);
    if (!user) return;
    this.db.prUpdateInventoryVerbose(user.GetName(), itemSN, verbose);
  }

  /** CMainPool::OnRequestCharge — client 214, nothing decoded.  Guards on
   *  user+20 (the in-billing-tranx flag) and answers client 206:
   *  [E1 CMainSystem+4 FX attr][E4 serial][E4 cash]; then flags user+3048. */
  OnRequestCharge(_n: CReceivedPacket, socket: CClientSocket): void {
    const user = socket.GetUser(socket.m_nSelectedUserIdx);
    if (!user || user.m_fTranxInProgress !== 0) return;
    const p = new CSendPacket(SC_SendPacket.OnReqPurchaseRes, 2);
    p.Encode1(CxShop.ms_pInstance!.m_nFXAttr & 0xff);
    p.Encode4(user.GetGlobalSerialNo());
    p.Encode4(user.m_nCash);
    socket.SendPacket(p);
    user.m_fRemainCashRequested = 1;
  }

  /** CMainPool::OnRequestUserItemList — client 217 → 202 PutUserItemList. */
  OnRequestUserItemList(_n: CReceivedPacket, socket: CClientSocket): void {
    const p = new CSendPacket(SC_SendPacket.OnUserItemList, 2);
    CItemMan.ms_pInstance!.PutUserItemList(p);
    socket.SendPacket(p);
  }

  /** CMainPool::OnRequestPresent — client 218 [E2 stockSN][EStr targetId]:
   *  ConfirmRegisteredId, then the billing gift request. */
  OnRequestPresent(n: CReceivedPacket, socket: CClientSocket): void {
    const stockSN = n.Decode2();
    const targetId = n.DecodeStr();
    const user = socket.GetUser(socket.m_nSelectedUserIdx);
    if (!user) return;
    if (this.db.prConfirmUnregisteredId(targetId) === 0) {
      const p = new CSendPacket(SC_SendPacket.OnPurchaseRes, 2);
      p.Encode1(3);
      p.EncodeStr(ERR_PURCHASE);
      socket.SendPacket(p);
      return;
    }
    if (!CBillingProcess.ms_pInstance || !CBillingProcess.ms_pInstance.IsConnected()) {
      const p = new CSendPacket(SC_SendPacket.OnPurchaseRes, 2);
      p.Encode1(5);
      p.EncodeStr(ERR_PURCHASE);
      socket.SendPacket(p);
      return;
    }
    const item = CItemMan.ms_pInstance!.GetShopItem(stockSN);
    CBillingProcess.ms_pInstance.RequestGift(user, targetId, stockSN, item?.Price ?? 0);
  }

  /** CMainPool::OnRequestUseCoupon — client 219 [EStr coupon][EStr id]. */
  OnRequestUseCoupon(n: CReceivedPacket, socket: CClientSocket): void {
    const coupon = n.DecodeStr();
    const id = n.DecodeStr();
    const user = socket.GetUser(socket.m_nSelectedUserIdx);
    if (!user) return;
    if (id.length === 0 || this.db.prConfirmUnregisteredId(id) !== 0) {
      // CMainPool::OnRequestUseCoupon stores the pair on the user (+3008/+3032)
      user.m_strCoupon = coupon;
      user.m_strCouponId = id;
      CBillingProcess.ms_pInstance?.RequestCheckCoupon(user);
      return;
    }
    const p = new CSendPacket(SC_SendPacket.OnUseCouponRes, 2);
    p.Encode1(7);
    socket.SendPacket(p);
  }

  /** CMainPool::OnRequestCartList — client 221, guarded by user+20:
   *  CDBMan::InitUserCart then client 214 [E1 count(user+2868)]
   *  [count != 0: EStr list]. */
  OnRequestCartList(_n: CReceivedPacket, socket: CClientSocket): void {
    const user = socket.GetUser(socket.m_nSelectedUserIdx);
    if (!user || user.m_fTranxInProgress !== 0) return;
    const cart = this.db.prGetUserCartList(user.GetName());
    const list = cart.stockSN;
    const count = list ? list.split(",").filter((x) => x.length > 0).length : 0;
    const p = new CSendPacket(SC_SendPacket.OnCartList, 2);
    p.Encode1(count);
    if (count !== 0) p.EncodeStr(list);
    socket.SendPacket(p);
  }

  /** CMainPool::OnRequestAddCartList — client 222 [EStr list] → prAddUserCartList. */
  OnRequestAddCartList(n: CReceivedPacket, socket: CClientSocket): void {
    const list = n.DecodeStr();
    const user = socket.GetUser(socket.m_nSelectedUserIdx);
    if (!user) return;
    this.db.prAddUserCartList(user.GetName(), list);
  }

  /** CMainPool::OnReqPurchaseCartList — client 223
   *  [E1 count][count×(E2 stockSN, E1 cnt)], guarded by user+20.  The cart
   *  lands on the user (user+2920 pairs), AddBonusCartItem may append one
   *  bonus row, then PurchaseCartList walks it: every cash (MoneyType != 0)
   *  entry is bought cnt times; the first billing (MoneyType == 0) entry
   *  hands the purchase to the billing link and the receipt
   *  [204][0][8B variant time] closes the cart. */
  OnReqPurchaseCartList(n: CReceivedPacket, socket: CClientSocket): void {
    const user = socket.GetUser(socket.m_nSelectedUserIdx);
    if (!user || user.m_fTranxInProgress !== 0) return;
    user.m_fCartProcessing = 1;
    const count = n.Decode1();
    user.m_anCart = [];
    let billingTotal = 0;
    for (let i = 0; i < count; i++) {
      const stockSN = n.Decode2();
      const cnt = n.Decode1();
      user.m_anCart.push({ stockSN, cnt });
      const item = CItemMan.ms_pInstance!.GetShopItem(stockSN);
      if (item && item.MoneyType === 0) billingTotal += item.Price;
    }
    // CItemMan::AddBonusCartItem — the total crossing a FxBonusMap Price
    // appends {StockSN, 1}; a miss drops the slot again
    if (CItemMan.ms_pInstance!.AddBonusCartItem(billingTotal, user, user.m_anCart.length) === 0) {
      // no bonus row appended
    } else {
      // the appended row becomes cart entry `count`
    }
    this.PurchaseCartList(user);
  }

  /** CMainPool::PurchaseCartList — walk the cart from the top. */
  PurchaseCartList(user: CUser): void {
    for (;;) {
      const entry = user.m_anCart[user.m_nCartCount] ?? user.m_anCart[user.m_anCart.length - 1];
      if (!entry) break;
      this.OnReqPurchaseStockItem(user, entry.stockSN);
      const item = CItemMan.ms_pInstance!.GetShopItem(entry.stockSN);
      if (item === null || item.MoneyType === 0) break; // billing items close the cart
      user.ResetTranxInfo();
      const idx = user.m_nCartCount;
      if ((user.m_anCart[idx]?.cnt ?? 0) <= 0) user.m_nCartCount = idx - 1;
      if (user.m_anCart[user.m_nCartCount]) user.m_anCart[user.m_nCartCount]!.cnt--;
    }
    // the cart receipt: client 204 [E1 0][8B variant time]
    const p = new CSendPacket(SC_SendPacket.OnPurchaseRes, 2);
    p.Encode1(0);
    p.EncodeBuffer(variantTime(new Date()), 8);
    user.m_pSocket?.SendPacket(p);
    user.ResetTranxInfo();
  }

  /** CMainPool::OnReqDigiQAuthorization — client 224 [EStr][Estr]. */
  OnReqDigiQAuthorization(n: CReceivedPacket, socket: CClientSocket): void {
    const a = n.DecodeStr();
    const b = n.DecodeStr();
    const user = socket.GetUser(socket.m_nSelectedUserIdx);
    if (!user) return;
    // the third buffer is the user's own name (FxShop.exe.c 19824-19832)
    CBillingProcess.ms_pInstance?.RequestDigiQAuthorization(user, a, b, user.GetName());
  }

  /** CMainPool::OnRequestTranxData — client 225 [E2][E2][E2][E4] → CTranxCtrl
   *  GetData → 211 [E2 len][buf][E4 serial]. */
  OnRequestTranxData(n: CReceivedPacket, socket: CClientSocket): void {
    const a = n.Decode2();
    const b = n.Decode2();
    const c = n.Decode2();
    const serial = n.Decode4();
    const user = socket.GetUser(socket.m_nSelectedUserIdx);
    if (!user) return;
    const buf = new Uint8Array(500);
    const len = CTranxCtrl.ms_pInstance!.GetData(a, b, c, buf, serial);
    const p = new CSendPacket(SC_SendPacket.OnTranxData, 2);
    p.Encode2(len);
    p.EncodeBuffer(buf.subarray(0, len), len);
    p.Encode4(serial);
    socket.SendPacket(p);
  }

  /** CMainPool::OnRequestShopSvrInfo — client 226 → client 212
   *  (CCenterProcess::MakeShopInfoPacket, FxShop.exe.c:3923): 
   *  [E4 count][count×(E4 ip, E4 port)] — the port is READ as the stored u16
   *  but ENCODED as an E4.  The list is what the center pushed as CM 6. */
  OnRequestShopSvrInfo(_n: CReceivedPacket, socket: CClientSocket): void {
    const center = CCenterProcess.ms_pInstance!;
    const p = new CSendPacket(SC_SendPacket.OnShopSvrInfo, 2);
    p.Encode4(center.m_nSvrCount);
    for (let i = 0; i < center.m_nSvrCount; i++) {
      p.Encode4(center.m_anSvrIP[i]!);
      p.Encode4(center.m_anSvrPort[i]!);
    }
    socket.SendPacket(p);
  }

  /** CMainPool::OnVerifyKey — the web mall charge handshake (9802).
   *  [E4 serial][E4 key] → the result int goes back raw: 1 ok, -3 unmatched,
   *  -4 unknown user. */
  OnVerifyKey(n: CReceivedPacket, socket: CWebSocket): void {
    const serial = n.Decode4();
    const key = n.Decode4();
    const user = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(serial);
    let result: number;
    if (!user || user.m_pChargeSocket !== null) {
      result = -4;
      console.log("[Shop] ChargeKey failed..");
    } else if (user.m_nChargeKey === key) {
      result = 1;
      user.m_pChargeSocket = socket;
    } else {
      result = -3;
      console.log(`[Shop] ChargeKey unmatched.. ${user.GetName()}`);
    }
    socket.SendBuffer(Int32Array.of(result).buffer as ArrayBuffer);
  }
}

// FxShop.exe lpszFormat_ @0x47EC48 — 已持有或收到此道具%d個以上，無法再購入
// (Big5, embedded as latin1 so the wire bytes are the original ANSI bytes)
const LIMIT_FORMAT_HEAD =
    "\xa4\x77\xab\xf9\xa6\xb3\xa9\xce\xa6\xac\xa8\xec\xa6\xb9\xb9\x44\xa8\xe3";
const LIMIT_FORMAT_TAIL =
    "\xad\xd3\xa5\x48\xa4\x57\xa1\x41\xb5\x4c\xaa\x6b\xa6\x41\xc1\xca\xa4\x4a";

function formatLimit(limit: number): string {
  return LIMIT_FORMAT_HEAD + String(limit) + LIMIT_FORMAT_TAIL;
}

/** GetLocalTime + SystemTimeToVariantTime → the 8-byte LE double (days
 *  since 1899-12-30) — the CTime::GetVariantTime wire form used by 201 and
 *  the purchase receipts. */
function variantTime(date: Date | null): Uint8Array {
  const buf = new Uint8Array(8);
  const days = date ? date.getTime() / 86400000 + 25569 : 0;
  new DataView(buf.buffer).setFloat64(0, days, true);
  return buf;
}

// ============================ CWebSocket ============================

/** CWebSocket — the ServerPort+1 web-mall listener socket.  The framing is
 *  the standard CPacketSocket one; the first packet is OnVerifyKey. */
export class CWebSocket extends CPacketSocket {
  static ms_tblSerialNo2Socket = new Map<number, CWebSocket>();

  m_nLocalSerialNo = 0;
  m_bVerified = 0;

  constructor() {
    super(CPacketSocket.dwRcvBufferSize, CPacketSocket.dwSndBufferSize, {
      onPacket: (_sock, packet) => {
        const pool = CMainPool.ms_pInstance;
        if (!pool) return;
        if (!this.m_bVerified) {
          pool.OnVerifyKey(packet, this);
          this.m_bVerified = 1;
          return;
        }
        // post-verify web traffic (charge receipts) — logged, no in-game effect
        console.log(`[Shop] web packet type ${packet.m_nPacketType}`);
      },
      onClose: () => this.Close(),
    });
    // CWebSocket::CWebSocket (30541) — the same header/sequence set as the
    // client sockets; the (Web) accept path does NOT raise the cipher degree.
    this.SetHeaderCode(192, 102, 231);
    this.SetSequence(40, 40, 3, 3);
    this.m_nLocalSerialNo = 1 + CWebSocket.ms_tblSerialNo2Socket.size;
    CWebSocket.ms_tblSerialNo2Socket.set(this.m_nLocalSerialNo, this);
  }

  /** the raw verify reply (4 bytes, no packet header) */
  SendBuffer(buf: ArrayBuffer): void {
    this.bunSocket?.write(new Uint8Array(buf));
  }

  Close(): void {
    if (!this.m_bConnected) return;
    for (const [sn, s] of CWebSocket.ms_tblSerialNo2Socket) if (s === this) CWebSocket.ms_tblSerialNo2Socket.delete(sn);
    super.Close();
  }
}

// ============================ CTranxCtrl ============================

/** CTranxCtrl — the purchase-receipt log.  AddTranx appends a record to the
 *  on-disk log (fopen "a+"); GetData hands a record's bytes to client 225. */
export class CTranxCtrl {
  static ms_pInstance: CTranxCtrl | null = null;

  private m_anData: { a: number; b: number; c: number; data: Uint8Array }[] = [];

  constructor() {
    CTranxCtrl.ms_pInstance = this;
  }

  /** CTranxCtrl::Init → CreateNewLog */
  Init(): number {
    this.CreateNewLog();
    return 1;
  }

  /** CTranxCtrl::CreateNewLog — fopen(path, "a+"). */
  CreateNewLog(): void {
    // the log directory is created lazily; Bun writes on demand
  }

  /** CTranxCtrl::AddTranx */
  AddTranx(a: number, b: number, c: number, data: Uint8Array): void {
    this.m_anData.push({ a, b, c, data });
  }

  /** CTranxCtrl::GetData — copies the matching record into pBuf (≤ 500). */
  GetData(a: number, b: number, c: number, pBuf: Uint8Array, _serial: number): number {
    const rec = this.m_anData.find((r) => r.a === a && r.b === b && r.c === c);
    if (!rec) return 0;
    const len = Math.min(rec.data.length, pBuf.length, 500);
    pBuf.set(rec.data.subarray(0, len), 0);
    return len;
  }
}

// ============================ CBillingSocketTw ============================

/** CBillingSocketTw — the digicell billing link socket (CBillingSocket ctor,
 *  FxShop.exe.c:404E70): CServerSocket base + SetHeaderCode(41, 41, 0). */
export class CBillingSocketTw extends CPacketSocket {
  constructor() {
    super(CPacketSocket.dwRcvBufferSize, CPacketSocket.dwSndBufferSize, {
      onPacket: (_sock, packet) => CBillingProcess.ms_pInstance?.OnPacket(packet),
    });
    this.SetHeaderCode(41, 41, 0);
  }
}

// ============================ CBillingProcess ============================

/** _BILLINGSVR — the CRSBillingSvr row. */
interface BILLINGSVR {
  SN: number;
  ip: string;
  port: number;
}

/** CBillingProcess — the digicell billing link.  Loads the BillingSvr list
 *  from CAConfig, connects (retry every 0x28 timer ticks while down), and
 *  speaks the 3x0 Tw protocol.  With an empty BillingSvr table the process
 *  stays disconnected forever — exactly the original server's behavior with
 *  no billing configured. */
export class CBillingProcess {
  static ms_pInstance: CBillingProcess | null = null;

  m_aBillingSvr: BILLINGSVR[] = []; // this+12 (50 × 0x14)
  m_fConnected = 0; // this+1296 (dword 324)
  m_pSocket: CBillingSocketTw | null = null; // this+8
  m_nRetryCount = 0; // dword_498048

  constructor(public db: CDBMan) {
    CBillingProcess.ms_pInstance = this;
  }

  /** CBillingProcess::UpdateBillingSvrList — CRSBillingSvr ("BillingSvr"). */
  UpdateBillingSvrList(): void {
    this.m_aBillingSvr = this.db.GetBillingSvrs();
  }

  /** CBillingProcess::ConnectToSvr — walk the list; 1 on the first connect. */
  async ConnectToSvr(): Promise<number> {
    for (const svr of this.m_aBillingSvr) {
      const socket = new CBillingSocketTw();
      try {
        const conn = await Bun.connect({
          hostname: svr.ip,
          port: svr.port,
          socket: {
            open: (t) => {
              socket.bunSocket = t as Bun.Socket<any>;
              socket.m_bConnected = true;
            },
            data: (_t, data) => socket.OnReceive(new Uint8Array(data as Buffer)),
            close: () => {
              socket.m_bConnected = false;
              this.m_fConnected = 0;
            },
            error: () => {
              this.m_fConnected = 0;
            },
          },
        });
        socket.bunSocket = conn;
        this.m_pSocket = socket;
        this.m_fConnected = 1;
        // CBillingProcess::ConnectToSvr — the 331 hello: [E4 4][E4 GetWorld()]
        const hello = new CSendPacket(BILLING_SendPacket.OnConnEstablished, 4);
        hello.Encode4(4);
        hello.Encode4(this.m_nSvrTag);
        this.Send(hello);
        return 1;
      } catch {
        continue;
      }
    }
    return 0;
  }

  /** CBillingProcess::Init */
  async Init(): Promise<void> {
    this.UpdateBillingSvrList();
    if ((await this.ConnectToSvr()) !== 0) this.m_fConnected = 1;
  }

  /** CBillingProcess::OnTimer — `++tick % 0x28 == 0 && !connected →
   *  ConnectToSvr()`; `% 0x5DC == 0 → TwRequestRTT()`. */
  async OnTimer(): Promise<void> {
    this.m_nRetryCount++;
    if (this.m_nRetryCount % 0x28 === 0 && this.m_fConnected === 0) {
      if ((await this.ConnectToSvr()) !== 0) this.m_fConnected = 1;
    }
    if (this.m_nRetryCount % 0x5dc === 0) this.TwRequestRTT();
  }

  IsConnected(): number {
    return this.m_fConnected;
  }

  /** CBillingProcess::OnPacket (404DB0) — the billing ids are E4 payloads
   *  behind the CPacketSocket framing. */
  OnPacket(n: CReceivedPacket): void {
    switch (n.Decode4()) {
      case BILLING_ReceivedPacket.OnRemainCashTw:
        this.OnRemainCashTw(n);
        break;
      case BILLING_ReceivedPacket.OnPurchaseOKTw:
        this.OnPurchaseOKTw(n);
        break;
      case BILLING_ReceivedPacket.OnPurchaseConfirmTw:
        this.OnPurchaseConfirmTw(n);
        break;
      case BILLING_ReceivedPacket.OnDigiQAuthen:
        this.OnDigiQAuthen(n);
        break;
      case BILLING_ReceivedPacket.OnEstimateRTT:
        console.log("[Shop] Received RTT Response");
        break;
      default:
        return;
    }
  }

  /** CBillingProcess::RequestRemainCashTw — billing 301 (cipher degree 4):
   *  [E4 SID][E4 BID][E4 4][E4 GetWorld()][E1 len][name][E4 serial]
   *  [E1 len][client ip].  Requires the billing link (this+324) and the
   *  user's socket. */
  RequestRemainCashTw(user: CUser): void {
    if (this.m_fConnected === 0) return;
    if (!user.m_pSocket) return;
    const ip = user.m_pSocket.m_strPeerAddress;
    const name = user.GetName();
    const p = new CSendPacket(BILLING_SendPacket.RequestRemainCashTw, 4);
    p.Encode4(user.m_nSID);
    p.Encode4(user.m_nBID);
    p.Encode4(4);
    p.Encode4(this.m_nSvrTag); // GetWorld()
    p.Encode1(name.length);
    p.EncodeBuffer(Buffer.from(name, "latin1"));
    p.Encode4(user.GetGlobalSerialNo());
    p.Encode1(ip.length);
    p.EncodeBuffer(Buffer.from(ip, "latin1"));
    this.Send(p);
  }

  m_nSvrTag = 0; // this+260 = CBillingSocketTw+252 — CBillingSocketTw::GetWorld()
  // (the ctor seeds it from CServerConfig::GetServerIdx()); set by CxShop.Init

  /** CBillingProcess::RequestGift — billing 7:
   *  [E4 serial][E4 0][E4 0][E4 stockSN][E4 price][EStr clubId][EStr name]
   *  [E1 domain][E2 UA+128 HIWORD][EStr +2904 tranx string]. */
  RequestGift(user: CUser, targetId: string, stockSN: number, price: number): void {
    const p = new CSendPacket(BILLING_SendPacket.RequestGift);
    p.Encode4(user.GetGlobalSerialNo());
    p.Encode4(0);
    p.Encode4(0);
    p.Encode4(stockSN);
    p.Encode4(price);
    p.EncodeStr(user.m_strNexonClubId);
    p.EncodeStr(user.GetName());
    p.Encode1(CxShop.ms_pInstance!.m_nFXAttr & 0xff); // CMainSystem+4 GetDomain
    p.Encode2(user.m_nUserAccountHiword);
    p.EncodeStr(user.m_strTranxInfo);
    this.Send(p);
  }

  /** RequestCheckCoupon / RequestUseCoupon — billing 0/1, identical shape:
   *  [E4 serial][EStr +3008 coupon][EStr clubId][EStr name][E1 domain]
   *  [E2 UA+128 HIWORD]. */
  RequestCheckCoupon(user: CUser): void {
    const p = new CSendPacket(BILLING_SendPacket.RequestCheckCoupon);
    this.EncodeCouponBody(p, user);
    this.Send(p);
  }

  RequestUseCoupon(user: CUser): void {
    const p = new CSendPacket(BILLING_SendPacket.RequestUseCoupon);
    this.EncodeCouponBody(p, user);
    this.Send(p);
  }

  private EncodeCouponBody(p: CSendPacket, user: CUser): void {
    p.Encode4(user.GetGlobalSerialNo());
    p.EncodeStr(user.m_strCoupon);
    p.EncodeStr(user.m_strNexonClubId);
    p.EncodeStr(user.GetName());
    p.Encode1(CxShop.ms_pInstance!.m_nFXAttr & 0xff); // CMainSystem+4 GetDomain
    p.Encode2(user.m_nUserAccountHiword);
  }

  /** CBillingProcess::RequestDigiQAuthorization — billing 341:
   *  [E1 len][Ebuf]×3 (three length-prefixed ANSI strings). */
  RequestDigiQAuthorization(_user: CUser, a: string, b: string, c: string): void {
    const p = new CSendPacket(BILLING_SendPacket.RequestDigiQAuthorization);
    for (const s of [a, b, c]) {
      const buf = Buffer.from(s, "latin1");
      p.Encode1(buf.length);
      p.EncodeBuffer(buf);
    }
    this.Send(p);
  }

  /** CBillingProcess::RequestPurchaseTw — billing 311:
   *  [E4 SID][E4 BID][E4 4][E4 GetWorld()][E1 len][name][E4 price][E4 1]
   *  [E4 BID][E4 stockSN][E4 1][E1 len][client ip]. */
  RequestPurchaseTw(user: CUser, item: ShopItem): void {
    if (!user.m_pSocket) return;
    const ip = user.m_pSocket.m_strPeerAddress;
    const name = user.GetName();
    const p = new CSendPacket(BILLING_SendPacket.RequestPurchaseTw, 4);
    p.Encode4(user.m_nSID);
    p.Encode4(user.m_nBID);
    p.Encode4(4);
    p.Encode4(this.m_nSvrTag); // GetWorld()
    p.Encode1(name.length);
    p.EncodeBuffer(Buffer.from(name, "latin1"));
    p.Encode4(item.Price);
    p.Encode4(1);
    p.Encode4(user.m_nBID);
    p.Encode4(item.SN);
    p.Encode4(1);
    p.Encode1(ip.length);
    p.EncodeBuffer(Buffer.from(ip, "latin1"));
    this.Send(p);
  }

  /** CBillingProcess::TwRequestRTT — billing 351: [E1 123]. */
  TwRequestRTT(): void {
    const p = new CSendPacket(BILLING_SendPacket.TwRequestRTT, 4);
    p.Encode1(123);
    this.Send(p);
  }

  /** CBillingProcess::OnRemainCashTw — billing 302:
   *  [E4 ?][E1 len][Ebuf msg][E4 serial][E4 cash][E4 result]
   *  [result==1: E1 len][Ebuf msg2].
   *  fail → client 203 [E1 0][EStr msg]; ok → client 203 [E1 1][E4 cash]. */
  OnRemainCashTw(n: CReceivedPacket): void {
    n.Decode4(); // ?
    const len = n.Decode1();
    const buf = n.DecodeRest();
    const msg = new TextDecoder().decode(buf.subarray(0, Math.min(len, buf.length)));
    const serial = n.Decode4();
    const cash = n.Decode4();
    const result = n.Decode4();
    const user = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(serial);
    if (!user || user.m_fConnEstablished !== 0) return;
    void msg;
    if (result === 1) {
      const len2 = n.Decode1();
      n.DecodeRest();
      const p = new CSendPacket(SC_SendPacket.OnRemainCash, 2);
      p.Encode1(1);
      p.Encode4(cash);
      user.m_pSocket?.SendPacket(p);
    } else {
      const p = new CSendPacket(SC_SendPacket.OnRemainCash, 2);
      p.Encode1(0);
      p.EncodeStr("");
      user.m_pSocket?.SendPacket(p);
    }
  }

  /** CBillingProcess::OnPurchaseOKTw — billing 312 (fail paths verified;
   *  the success path needs a live digicell server). */
  OnPurchaseOKTw(n: CReceivedPacket): void {
    n.Decode4();
    n.Decode4();
    n.Decode4();
    const len = n.Decode1();
    const serial = n.Decode4();
    n.Decode4();
    const result = n.Decode4();
    n.Decode1();
    const user = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(serial);
    if (!user) return;
    if (result !== 1) {
      const p = new CSendPacket(SC_SendPacket.OnPurchaseRes, 2);
      p.Encode1(1);
      p.EncodeStr(ERR_PURCHASE);
      user.m_pSocket?.SendPacket(p);
      user.ResetTranxInfo();
      return;
    }
    // the digicell confirm handshake (billing 321) + the inventory insert —
    // exercised only with a live billing server.
    void len;
  }

  /** CBillingProcess::OnPurchaseConfirmTw — billing 322. */
  OnPurchaseConfirmTw(_n: CReceivedPacket): void {
    // digicell confirm — needs a live billing server
  }

  /** CBillingProcess::OnDigiQAuthen — billing 342. */
  OnDigiQAuthen(_n: CReceivedPacket): void {
    // digicell auth response — needs a live billing server
  }

  /** the CBillingSocketTw IssueSend path (vtbl+108 PutPacket, vtbl+64 Flush). */
  Send(p: CSendPacket): void {
    this.m_pSocket?.SendPacket(p);
  }
}

// ============================ CCenterProcess ============================

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
    for (;;) {
      try {
        await this.m_pSocket.ConnectToCenter(
          cfg.GetAttribute("CenterIP"),
          cfg.GetNumAttribute("CenterPort"),
          SVRCLASS_SHOP,
          cfg.GetNumAttribute("ServerIndex"),
          7,
          3,
        );
        break;
      } catch {
        console.error("[Shop] Connection failed. Try again.");
        await Bun.sleep(3000);
      }
    }
    console.log("[Shop] Connection to Center Server established");
  }

  SendPacket(packet: CSendPacket): void {
    this.m_pSocket.SendToCenter(packet);
  }

  /** CCenterProcess::SendAuthenCode — center MC 9 [E4 serial][E1 code]. */
  SendAuthenCode(serial: number, code: number): void {
    const p = new CSendPacket(MC_ReceivedPacket.OnSetAuthenCode);
    p.Encode4(serial);
    p.Encode1(code);
    this.SendPacket(p);
  }

  /** CCenterProcess::OnPacket — the CM dispatch (1/2/6/8/12/14). */
  OnPacket(n: CReceivedPacket): void {
    switch (n.Decode1()) {
      case CM_ReceivedPacket.OnCenterResConnectToSvr:
        CMainPool.ms_pInstance?.OnCenterResConnectToSvr(n);
        return;
      case CM_ReceivedPacket.OnCenterResConnEstablished:
        CMainPool.ms_pInstance?.OnCenterResConnEstablished(n);
        return;
      case CM_ReceivedPacket.OnShopServerInfo:
        this.OnShopServerInfo(n);
        return;
      case CM_ReceivedPacket.OnAdminNotifyMsg:
        this.OnAdminNotifyMsg(n);
        return;
      case CM_ReceivedPacket.OnInitialSvrAttr:
        this.OnAttr(n);
        return;
      case CM_ReceivedPacket.OnItemDBInit:
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
    const p = new CSendPacket(SC_SendPacket.OnAdminNotifyMsg, 2);
    p.EncodeStr(str);
    CUserPool.SendAll(CUserPool.CreateSocketList(CMainPool.ms_pInstance!), p);
  }

  /** CCenterProcess::OnAttr — CM 12 [E1 attr][E1 ?] → the FX attribute id. */
  OnAttr(n: CReceivedPacket): void {
    const attr = n.Decode1();
    n.Decode1();
    CxShop.ms_pInstance!.m_nFXAttr = attr;
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

// ============================ CMainSystem ============================

/** CMainSystem — the shop's system object; OnConnEstablished pushes the
 *  accept packet (FxShop.exe.c:21041):
 *  0: [E2 3][E2 7][E4 headerType][EStr "ftp://patch.nexon.co.kr/ca"]. */
export class CMainSystem {
  static ms_pInstance: CMainSystem | null = null;

  constructor() {
    CMainSystem.ms_pInstance = this;
  }

  OnConnEstablished(socket: CClientSocket): void {
    const packet = new CSendPacket(0);
    packet.Encode2(3);
    packet.Encode2(7);
    packet.Encode4(socket.m_nHeaderType);
    packet.EncodeStr("ftp://patch.nexon.co.kr/ca");
    socket.SendPacket(packet);
  }
}

// ============================ CxShop ============================

/** CxShop — the assembled shop server (CFxShopApp). */
export class CxShop {
  static ms_pInstance: CxShop | null = null;

  db: CDBMan;
  itemMan = new CItemMan();
  mainPool: CMainPool;
  userTable = new CLocalUserTable();
  center: CCenterProcess;
  billing: CBillingProcess;
  tranxCtrl = new CTranxCtrl();
  mainSystem = new CMainSystem();

  m_strChargeUrl = ""; // CMainSystem+2 (InitChargeUrl)
  m_strAuthUrl = ""; // CMainSystem+5 (InitAuthUrl)
  m_nFXAttr = 0; // the CM 12 attribute

  constructor(public cfg: CServerConfig, dbDir: string) {
    CxShop.ms_pInstance = this;
    this.db = new CDBMan(dbDir);
    this.mainPool = new CMainPool(this.db);
    this.center = new CCenterProcess(this.db);
    this.billing = new CBillingProcess(this.db);
    this.mainPool.billingProcess = this.billing;
    CItemMan.ms_pInstance = this.itemMan;
  }

  /** CFxShopApp::SetUp — the boot order (minus the Windows plumbing). */
  async Init(): Promise<void> {
    ValidateShopConfig(this.cfg);

    // CDBMan::Init — the four key groups (the port maps every family onto the
    // same SQLite directory, mirroring the shipped one-DB-each topology).
    // DataBase Info File: DBInfo.inf = EncodePassword(id \r\n password).

    // CItemMan::Init
    if (this.itemMan.Init(this.db) === 0) throw new Error("! Item DB initialize failed");

    // CTranxCtrl::Init
    this.tranxCtrl.Init();

    // CCenterProcess::Init
    await this.center.Init(this.cfg);

    // CBillingProcess::Init
    // CBillingSocketTw ctor seeds GetWorld() (+252) from CServerConfig::GetServerIdx()
    this.billing.m_nSvrTag = this.cfg.GetNumAttribute("ServerIndex") || 0;
    await this.billing.Init();

    // InitChargeUrl / InitAuthUrl — ConfigDB prGetStringAttr @ChargeUrl/@AuthUrl
    this.m_strChargeUrl = this.db.prGetStringAttr("ChargeUrl").strVal;
    this.m_strAuthUrl = this.db.prGetStringAttr("AuthUrl").strVal;

    // CListenThread — the client listener (ServerPort, cipher 2)
    const port = this.cfg.GetNumAttribute("ServerPort") || 9801;
    const clientSockets = new WeakMap<object, CClientSocket>();
    Bun.listen({
      hostname: "0.0.0.0",
      port,
      socket: {
        open: (t) => {
          try {
            const socket = new CClientSocket();
            clientSockets.set(t, socket);
            socket.bunSocket = t as Bun.Socket<any>;
            socket.m_bConnected = true;
            socket.m_strPeerAddress = t.remoteAddress;
            // CListenThread::Proc — the accept packet, then SetCipherDegree(2) before Read
            this.mainSystem.OnConnEstablished(socket);
            socket.SetCipherDegree(2);
          } catch (e) {
            console.error("[Shop] client accept failed", e);
          }
        },
        data: (t, data) => {
          const s = clientSockets.get(t);
          if (s) {
            s.m_dwIdleTime = Date.now();
            s.OnReceive(new Uint8Array(data as Buffer));
          }
        },
        close: (t) => clientSockets.get(t)?.Close(),
        error: (_t, err) => console.error(`[Shop] ${String(err)}`),
      },
    });
    console.log(`[Shop] listening on :${port}`);

    // CListenExThread — the web mall listener (ServerPort+1)
    const webPort = port + 1;
    const webSockets = new WeakMap<object, CWebSocket>();
    if (!process.env.TC_NOWEB) Bun.listen({
      hostname: "0.0.0.0",
      port: webPort,
      socket: {
        open: (t) => {
          const socket = new CWebSocket();
          webSockets.set(t, socket);
          socket.bunSocket = t as Bun.Socket<any>;
          socket.m_bConnected = true;
        },
        data: (t, data) => {
          webSockets.get(t)?.OnReceive(new Uint8Array(data as Buffer));
        },
        close: (t) => webSockets.get(t)?.Close(),
        error: (_t, err) => console.error(`[Shop web] ${String(err)}`),
      },
    });
    console.log(`[Shop] web listener on :${webPort}`);

    // the timer sweeps (CTimerThread + the billing retry)
    setInterval(() => {
      this.mainPool.DisconnectTimeoutSocket();
      void this.billing.OnTimer();
    }, 1000);
  }
}

// enSocket re-export guard (tree-shaking helper)

// ============================ main ============================

/** the shop entry — mirror of CFxShopApp::SetUp's argv handling: the first
 *  token is the cfg path (missing ".cfg" → + ".cfg"). */
export async function main(cfgPath: string, dbDir: string): Promise<void> {
  const cfg = new CServerConfig();
  cfg.Init(cfgPath);
  CServerConfig.ms_pInstance = cfg;
  const shop = new CxShop(cfg, dbDir);
  await shop.Init();
}
