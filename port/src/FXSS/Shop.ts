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
import { CServerConfig, FXSHOP_STR_KEYS } from "../core/Config.ts";
import { timeGetTime } from "../core/timeGetTime.ts";
import { MakeLower } from "../core/MakeLower.ts";
import { PacketLog } from "../core/PacketLog.ts";
import { CDBMan } from "../db/DBMan.ts";
import { CipherDegree, CReceivedPacket, CSendPacket, enSocket, type enSocket as EnSocket } from "../core/Packet.ts";
import { CPacketSocket, type IPacketSocketHooks } from "../core/CPacketSocket.ts";
import { CLocalSocket } from "../lib/CenterLink.ts";
import {
  BILLING_PACKET_LOG_CONTEXT,
  BILLING_SendPacket,
  COUPON_SendPacket,
  TW_BILLING_ReceivedPacket,
  TW_BILLING_SendPacket,
  CLIENTSOCKET_HEADER_CODE_MODIFIER,
  CLIENTSOCKET_HEADER_CODE_RCV,
  CLIENTSOCKET_HEADER_CODE_SND,
  CLIENTSOCKET_SEQ,
  CLIENTSOCKET_SEQ_DELTA,
  SC_SendPacket,
  SS_ReceivedPacket,
  PACKET_NAME_TABLES,
} from "../lib/PacketIDs.ts";
import { CM_ShopServerPacket, CENTER_VERSION, CONN_HELLO_VERSION, MC_ShopServerSendPacket, SVRCLASS_SHOP, CLIENT_SOCKET_CENSUS_MS } from "../lib/S2S.ts";
import { CDynInfoCalculator_GetLevel } from "../lib/LevelTable.ts";
import { CItemMan, type ShopItem } from "./CItemMan.ts";
import { ItemCategory, IsInventoryAddable } from "../lib/Item.ts";
import { NEXONCLUB_EMAIL_DOMAIN, SHOP_PERMANENT_VALIDITY_DAYS, SHOP_PERMANENT_EXPIRY_LEVEL } from "./Defs.ts";
import { CSendPacket as CBillingSendPacket, DecodeBillingString } from "./Packet.ts";
import { CBillingSocketTw } from "./CBillingSocketTw.ts";
import { usesLocalBilling } from "../Billing/Config.ts";
import { BillingReader, string8 } from "../Billing/Protocol.ts";
import { BILLING_GAME, BILLING_ERROR, LOCAL_BILLING_RETRY_MS, RESERVATION_MS } from "../Billing/Defs.ts";
export { CBillingSocketTw } from "./CBillingSocketTw.ts";

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
  m_nAuthenCode = 0; // +3116 (byte) — the CM 2 authencode (1 → [E1 1][E1 101])
  m_nSID = -1; // +3108 — CUser::GetSID/SetSID (the account SID); set from the
  // client's p7 second dword (FxShop.exe.c:19013) and echoed in MC 3
  m_nBID = -1; // +3112 — CUser::GetBID/SetBID (the SID pair's second dword)
  m_strCoupon = ""; // +3008 — the client 219 coupon (CMainPool::OnRequestUseCoupon)
  m_strCouponId = ""; // +3032 — the client 219 registered id
  m_strTranxInfo = ""; // +2904 — the per-user transaction string (ResetTranxInfo clears it)
  m_nUserAccountHiword = 0; // +152 = _USERACCOUNT+128 — the billing tail E2 (HIWORD)
  m_nCash = 0; // cached FxUserDynamic.Money (game currency, NOT billing cash)
  m_nBillingCash = 0; // +3104 — CUser::SetCash, independent of FxUserDynamic.Money
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

  /** CUser::SetCash (00401460) — signed DWORD at +3104. */
  SetCash(cash: number): void {
    this.m_nBillingCash = cash | 0;
  }

  /** CUser::SetLevel — CDynInfoCalculator::GetLevel(dyninfo Exp). */
  SetLevel(dyn: USERDYNINFO): void {
    this.m_nLevel = CDynInfoCalculator_GetLevel(dyn.Exp);
  }

  /** CUser::SetNexonClubId (0041FC60): range-based byte search in Email,
   * then erase the last pattern-length bytes, NOT the matched substring.
   * Account strings on this path use the port's raw Latin-1 byte mapping.
   */
  SetNexonClubId(account: USERACCOUNT): void {
    const email = account.Email;
    this.m_strNexonClubId = email.includes(NEXONCLUB_EMAIL_DOMAIN)
      ? email.slice(0, -NEXONCLUB_EMAIL_DOMAIN.length)
      : "";
  }

  /** CUser::GetNexonClubId (0041F000) returns const char*. Its billing
   * callers construct a string from that C pointer, stopping at the first
   * NUL. Preserve the full stored value; expose its C-string view here.
   */
  GetNexonClubId(): string {
    const end = this.m_strNexonClubId.indexOf("\0");
    return end < 0 ? this.m_strNexonClubId : this.m_strNexonClubId.slice(0, end);
  }

  /** CUser::ResetTranxInfo (0041F170), the native fields modeled here.
   * Cart/connection guards and the separate local settlement marker are NOT
   * reset by this native routine. Native transaction lists remain unmodeled. */
  ResetTranxInfo(): void {
    this.m_strTranxInfo = "";
    this.m_strCoupon = "";
    this.m_strCouponId = "";
  }

  m_fTranxInProgress = 0; // user+20 — the billing-tranx guard (210/214/221/223)
  m_fRemainCashRequested = 0; // user+3048 — set by the 214 handler
  m_fCartProcessing = 0; // user+3056 — set while a cart purchase walks
  m_nChargeKey = 0; // user+2280 — the OnVerifyKey charge key
  m_pChargeSocket: CWebSocket | null = null; // user+12 — bound by OnVerifyKey
  m_pPurchaseTranx: object | null = null; // port-side pending-purchase marker, not a native pointer offset
  m_anCart: { stockSN: number; cnt: number }[] = []; // user+2920 (2 dwords per entry)
  m_nCartCount = 0; // user+3052
}

// ============================ CClientSocket ============================

/** CClientSocket — the 9801 client connection (CListenThread accept).
 *  Every accepted socket gets SetCipherDegree(2) (CFxShopApp::SetUp). */
export class CClientSocket extends CPacketSocket {
  /** CClientSocket::OnReceiveCompletionPacket guards the client links only
   *  (FxShop.exe.c:5890). */
  m_fReceiveFloodGuard = true;

  protected ReportReceiveOverflow(): void {
    console.error(`Socket receive buffer overflow(${this.bunSocket?.remoteAddress ?? ""}), disconnected.`);
  }

  protected ReportSendOverflow(): void {
    console.error(`Socket send buffer overflow, close connection: (${this.bunSocket?.remoteAddress ?? ""})`);
  }

  /** CClientSocket::PutPacket's wrapper switch (FxShop.exe.c:5705). */
  protected ReportPutError(err: EnSocket): void {
    if (err === enSocket.kioNotConnected) console.error("Not-connected client socket tried to put packet.");
    else if (err === enSocket.kioInvalidPacket) console.error("tried to send invalid( =\tNULL ) packet");
  }
  static ms_nHeaderTypeCounter = 0;
  static ms_tblSN2Obj = new Map<number, CClientSocket>();

  m_nLocalSerialNo = 0;
  m_dwLastRTT = 0;
  m_dwIdleTime = timeGetTime() - 5000;
  m_apUser: (CUser | null)[] = []; // +460
  m_nUserCount = 0; // +456
  m_nSelectedUserIdx = 0; // +464 (u16)
  m_strPeerAddress = ""; // CSocket::GetAddressString

  constructor() {
    super(CPacketSocket.dwRcvBufferSize, CPacketSocket.dwSndBufferSize, {
      onPacket: (_sock, packet) => CMainPool.ms_pInstance?.OnPacket(packet, this),
    });
    this.m_szLogTag = "Shop";
    this.m_fClientLink = true;
    this.m_nLocalSerialNo = CClientSocket.ms_tblSN2Obj.size + 1;
    this.SetHeaderType(CClientSocket.ms_nHeaderTypeCounter % 16);
    CClientSocket.ms_nHeaderTypeCounter++;
    this.SetHeaderCode(CLIENTSOCKET_HEADER_CODE_RCV, CLIENTSOCKET_HEADER_CODE_SND, CLIENTSOCKET_HEADER_CODE_MODIFIER);
    this.SetSequence(CLIENTSOCKET_SEQ, CLIENTSOCKET_SEQ, CLIENTSOCKET_SEQ_DELTA, CLIENTSOCKET_SEQ_DELTA);
    this.SetCipherDegree(CipherDegree.kPacketEncryptedCRC8); // CFxShopApp::SetUp — the client sockets are ciphered
    CClientSocket.ms_tblSN2Obj.set(this.m_nLocalSerialNo, this);
  }

  /** CClientSocket::AddNewUsers — the shop is single-user per socket. */
  AddNewUsers(n: number): void {
    this.m_apUser = [];
    for (let i = 0; i < n; i++) this.m_apUser.push(new CUser(this));
    this.m_nUserCount = n;
  }

  GetUser(i: number): CUser | null {
    return this.m_apUser[i] ?? null;
  }

  GetUserCount(): number {
    return this.m_nUserCount;
  }

  protected OnClose(): void {
    CMainPool.ms_pInstance?.DeleteSocket(this);
    for (const user of this.m_apUser) {
      if (!user) continue;
      CLocalUserTable.ms_pInstance?.Remove(user);
      user.m_pSocket = null;
    }
    this.m_apUser = [];
    this.m_nUserCount = 0;
    CClientSocket.ms_tblSN2Obj.delete(this.m_nLocalSerialNo);
    super.OnClose();
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
    const key = MakeLower(user.GetName());
    if (this.byName.has(key) || this.bySN.has(user.GetGlobalSerialNo())) return 0;
    this.byName.set(key, user);
    this.bySN.set(user.GetGlobalSerialNo(), user);
    return 1;
  }

  /** CLocalUserTable::Remove */
  Remove(user: CUser): void {
    this.byName.delete(MakeLower(user.GetName()));
    if (this.bySN.get(user.GetGlobalSerialNo()) === user) this.bySN.delete(user.GetGlobalSerialNo());
  }

  /** CLocalUserTable::FindUser */
  FindUser(name: string): CUser | null {
    return this.byName.get(MakeLower(name)) ?? null;
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

  /** CUserPool::AddSocket (:421630) — a duplicate insert reports. */
  AddSocket(socket: CClientSocket): void {
    if (this.m_setSocket.has(socket)) console.error(`[Shop] Try to insert already resident socket in userpool`);
    this.m_setSocket.add(socket);
  }

  DelSocket(socket: CClientSocket): void {
    this.m_setSocket.delete(socket);
  }

  /** CUserPool::AddNewSocket (:29679 shop twin of the GS guard) — a user
   *  already resident aborts the seat: report, roll back the users seated
   *  so far, refuse the socket. */
  AddNewSocket(socket: CClientSocket): number {
    const added: CUser[] = [];
    for (const user of socket.m_apUser) {
      if (!user) continue;
      if (this.m_setUser.has(user)) {
        console.error(`[Shop] Try to insert already resident user in user room`);
        for (const u of added) this.m_setUser.delete(u);
        return 0;
      }
      this.m_setUser.add(user);
      added.push(user);
    }
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
    const packet = new CSendPacket(SC_SendPacket.OnEstimateRTTRes, CipherDegree.kPacketEncryptedCRC8);
    const t = n.Decode4();
    const now = timeGetTime();
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

  /** CUserPool::OnTimer (:421030) — every pool bumps the shared BSS counter
   *  (dword_498368) and the sweep fires at %0x4B: 75 ticks × 400 ms = 30 s.
   *  DisconnectTimeoutSocket (:29065) kicks sockets idle past 0x7530 ms —
   *  the Shop's idle gate is 30 s, not the GS's 0x9C40. */
  OnTimer(count: number): void {
    if (count % 0x4b === 0) this.DisconnectTimeoutSocket();
  }

  /** CUserPool::DisconnectTimeoutSocket (:29065) — 0x7530 ms without RTT. */
  DisconnectTimeoutSocket(): void {
    const now = timeGetTime();
    for (const socket of [...this.m_setSocket]) {
      if (((now - socket.m_dwIdleTime) >>> 0) > 0x7530) {
        console.error(`[Shop] Disconnect Timeout Socket [${socket.m_apUser[0]?.GetName() ?? "NULL"}]`);
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
        this.OnRequestRemainCashTw(n, socket);
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

  /** CMainPool::OnConnEstablished (00415980) — client 7.
   * [E1 count][count × (EStr name, E4 serial, E4 SID, E4 BID)][E1 selected].
   * Cross-check .lst 00415A52/00415A5C/00415A68: +3112/+3108/+3096.
   * The second DWORD is NOT cash (+3104). CM 3 echoes serial and SID.
   */
  OnConnEstablished(n: CReceivedPacket, socket: CClientSocket): void {
    const count = n.Decode1();
    socket.AddNewUsers(count);
    this.AddNewSocket(socket);
    let i = 0;
    for (; i < count; i++) {
      const user = socket.GetUser(i)!;
      const name = n.DecodeStr();
      const sn = n.Decode4();
      const sid = n.Decode4(); // +3108
      const bid = n.Decode4(); // +3112
      user.SetName(name);
      user.SetGlobalSerialNo(sn);
      user.m_nSID = sid;
      user.m_nBID = bid;
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
    const p = new CSendPacket(MC_ShopServerSendPacket.OnConnEstablished);
    p.Encode1(count);
    for (let j = 0; j < count; j++) {
      const u = socket.GetUser(j)!;
      p.EncodeStr(u.GetName());
      p.Encode4(u.GetGlobalSerialNo());
      p.Encode4(u.m_nSID); // CUser::GetSID — the client-supplied billing SID
    }
    CCenterProcess.ms_pInstance?.SendPacket(p);
  }

  /** CMainPool::OnReqConnectToSvr (00415210) — client 6:
   * [E1 serverType][E4 target], with no version word. The native 00415232
   * calls Decode1, NOT Decode2. Forward all socket users to Center MC 2;
   * SelectedUserIdx is not involved in this request.
   */
  OnReqConnectToSvr(n: CReceivedPacket, socket: CClientSocket): void {
    const type = n.Decode1();
    const target = n.Decode4();
    const p = new CSendPacket(MC_ShopServerSendPacket.OnReqConnectToSvr);
    const count = socket.GetUserCount();
    p.Encode1(count);
    for (let i = 0; i < count; i++) p.Encode4(socket.GetUser(i)!.GetGlobalSerialNo());
    p.Encode1(type);
    p.Encode4(target);
    CCenterProcess.ms_pInstance?.SendPacket(p);
  }

  /** CMainPool::OnCenterResConnectToSvr (004152E0) — Center CM 1:
   * [E1 n][n×E4 serial][E1 result][==1: E1 type, E4 idx, E4 ip, E2 port].
   * Every user must exist and have no billing transaction in progress.
   * Abort on the first failure; otherwise send client 6 to the LAST user.
   */
  OnCenterResConnectToSvr(n: CReceivedPacket): void {
    const count = n.Decode1();
    let target: CUser | null = null;
    for (let i = 0; i < count; i++) {
      target = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(n.Decode4());
      if (!target || target.m_fTranxInProgress !== 0) return;
    }
    // Zero-count native code uses an invalid target; keep the port safe.
    if (!target || !target.m_pSocket) return;
    const result = n.Decode1();
    const p = new CSendPacket(SC_SendPacket.OnResConnectToSvr, CipherDegree.kPacketEncryptedCRC8);
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
    const authencodes: number[] = []; // the per-user authencode bytes
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

    // the failure tail (result flag 0): close serial[0]'s socket (no reply anywhere)
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
    const p = new CSendPacket(SC_SendPacket.OnInitialInfo, CipherDegree.kPacketEncryptedCRC8);
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
      const p207 = new CSendPacket(SC_SendPacket.OnPreInventory, CipherDegree.kPacketEncryptedCRC8);
      p207.Encode1(users.length);
      for (const u of users) this.MakePreInventoryPacket(u!, p207);
      target.m_pSocket?.SendPacket(p207);
      const p201 = new CSendPacket(SC_SendPacket.OnUserInventory, CipherDegree.kPacketEncryptedCRC8);
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

  /** CUser::MakeUserInventoryPacket — 201 per-user body:
   *  [E4 n][n×(E4 SN, E1 slot, E4 ItemSN, EStr verbose, 8B CTime)].
   *  FxShop.exe.c:27145 calls the send-packet vtable at +28 (Encode4) for
   *  both this vector count and each SN/ItemSN. */
  MakeUserInventoryPacket(user: CUser, packet: CSendPacket): void {
    packet.Encode4(user.m_vecUserInventory.length);
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
  OnRequestRemainCashTw(_n: CReceivedPacket, socket: CClientSocket): void {
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
    if (user.m_fTranxInProgress !== 0) return; // native 00415EA0, user+20
    const itemMan = CItemMan.ms_pInstance!;
    const shopItem = itemMan.GetShopItem(stockSN);
    if (!shopItem) {
      this.PurchaseError(user, 1, ERR_PURCHASE);
      return;
    }
    if (this.billingProcess.m_fLocalBilling && shopItem.MoneyType === 0) {
      this.billingProcess.RequestPurchaseTw(user, shopItem);
      return;
    }
    // A port-side purchase is already in flight → error 1.
    if (user.m_pPurchaseTranx !== null) {
      this.PurchaseError(user, 1, ERR_PURCHASE);
      return;
    }
    const id = user.GetName();

    // FxShop 00415EA0 switches on the STOCK category. nAttr1 is an owned
    // quantity limit only for category 13, not a universal maximum.
    const packages = shopItem.Category === ItemCategory.Package ? itemMan.GetPackageMapList(shopItem.SN) : [];
    if (shopItem.Category === ItemCategory.Package) {
      for (const pkg of packages) {
        const sub = itemMan.GetShopItem(pkg.StockSN);
        if (!sub) {
          this.PurchaseError(user, 5, ERR_PURCHASE);
          user.ResetTranxInfo();
          return;
        }
        const owned = (this.db.prIsValidInventory(id, sub.ItemSN) + this.db.prIsValidPreInventory(id, sub.ItemSN)) | 0;
        // Native's category-15 exemption tests the PARENT, which is 11 in
        // this branch. A category-15 CHILD is therefore not exempt.
        if (owned !== 0 && sub.Category !== ItemCategory.Consumable && sub.Category !== ItemCategory.LimitedItem) {
          this.PurchaseError(user, 4, ERR_PURCHASE);
          user.ResetTranxInfo();
          return;
        }
        const ui = itemMan.GetUserItem(sub.ItemSN);
        if (ui && sub.Category === ItemCategory.LimitedItem && owned >= ui.nAttr1) {
          this.PurchaseError(user, 11, ERR_PURCHASE); // package branch has no formatted limit text
          user.ResetTranxInfo();
          return;
        }
      }
    } else if (shopItem.Category === ItemCategory.LimitedItem) {
      const ui = itemMan.GetUserItem(shopItem.ItemSN);
      if (!ui) {
        console.error(`[Shop] Invalid item sn (OnReqPurchaseStockItem) = ${shopItem.ItemSN}`);
        this.PurchaseError(user, 1, ERR_PURCHASE);
        user.ResetTranxInfo();
        return;
      }
      const owned = (this.db.prIsValidInventory(id, shopItem.ItemSN) + this.db.prIsValidPreInventory(id, shopItem.ItemSN)) | 0;
      if (owned >= ui.nAttr1) {
        this.PurchaseError(user, 11, formatLimit(ui.nAttr1));
        user.ResetTranxInfo();
        return;
      }
    } else if (!IsInventoryAddable(shopItem.Category)) {
      const owned = (this.db.prIsValidInventory(id, shopItem.ItemSN) + this.db.prIsValidPreInventory(id, shopItem.ItemSN)) | 0;
      if (owned !== 0) {
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

    // MoneyType != 0 uses game Money. Native flat packages grant each
    // child's ItemSN and Units*Unit, but retain the PARENT StockSN/validity.
    // Native also keeps earlier grants on failure; the last result wins.
    // This is deliberately distinct from the local billing atomic settlement.
    let ok = 1;
    const grants = shopItem.Category === ItemCategory.Package
      ? packages.map(pkg => {
          const sub = itemMan.GetShopItem(pkg.StockSN)!;
          return { itemSN: sub.ItemSN, units: Math.imul(pkg.Units, sub.Unit) };
        })
      : [{ itemSN: shopItem.ItemSN, units: shopItem.Unit }];
    for (const grant of grants) {
      if (shopItem.Price > user.m_nCash) ok = 0;
      else if (shopItem.Category === ItemCategory.PremiumTicket) {
        ok = this.db.prSetPremiumTicket(id, shopItem.ValidityPeriod);
        if (ok !== 0) CCenterProcess.ms_pInstance?.SendAuthenCode(user.GetGlobalSerialNo(), 1);
      } else {
        const item = itemMan.GetUserItem(grant.itemSN);
        const days = shopItem.ValidityPeriod || SHOP_PERMANENT_VALIDITY_DAYS;
        const expiryLevel = shopItem.ValidityLevel === 0 ? SHOP_PERMANENT_EXPIRY_LEVEL : (user.m_nLevel + shopItem.ValidityLevel) | 0;
        ok = item ? this.db.prAddInventoryShop(id, grant.itemSN, shopItem.SN, grant.units, days, expiryLevel, IsInventoryAddable(item.Category)) : 0;
      }
    }
    if (ok !== 0) {
      // Native ignores SetMoney's failure result: this is NOT an atomic
      // cross-shard settlement. Do not confuse it with the local points path.
      this.db.prSetMoney(id, -shopItem.Price);
      user.m_nCash -= shopItem.Price;
      if (user.m_fCartProcessing === 0) {
        // success: client 204 [E1 0][8B SystemTimeToVariantTime double]
        const p = new CSendPacket(SC_SendPacket.OnPurchaseRes, CipherDegree.kPacketEncryptedCRC8);
        p.Encode1(0);
        p.EncodeBuffer(variantTime(new Date()), 8);
        user.m_pSocket?.SendPacket(p);
      }
    } else if (user.m_fCartProcessing === 0) {
      this.PurchaseError(user, 1, ERR_PURCHASE);
    }
    user.ResetTranxInfo();
  }

  PurchaseError(user: CUser, code: number, msg: string): void {
    const p = new CSendPacket(SC_SendPacket.OnPurchaseRes, CipherDegree.kPacketEncryptedCRC8);
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
    const p = new CSendPacket(SC_SendPacket.OnReqPurchaseRes, CipherDegree.kPacketEncryptedCRC8);
    p.Encode1(CxShop.ms_pInstance!.m_nFXAttr & 0xff);
    p.Encode4(user.GetGlobalSerialNo());
    p.Encode4(user.m_nCash);
    socket.SendPacket(p);
    user.m_fRemainCashRequested = 1;
  }

  /** CMainPool::OnRequestUserItemList — client 217 → 202 PutUserItemList. */
  OnRequestUserItemList(_n: CReceivedPacket, socket: CClientSocket): void {
    const p = new CSendPacket(SC_SendPacket.OnUserItemList, CipherDegree.kPacketEncryptedCRC8);
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
    if (this.billingProcess.m_fLocalBilling) { this.PurchaseError(user, 1, BILLING_ERROR.unsupported); return; }
    if (this.db.prConfirmUnregisteredId(targetId) === 0) {
      const p = new CSendPacket(SC_SendPacket.OnPurchaseRes, CipherDegree.kPacketEncryptedCRC8);
      p.Encode1(3);
      p.EncodeStr(ERR_PURCHASE);
      socket.SendPacket(p);
      return;
    }
    if (!CBillingProcess.ms_pInstance || !CBillingProcess.ms_pInstance.IsConnected()) {
      const p = new CSendPacket(SC_SendPacket.OnPurchaseRes, CipherDegree.kPacketEncryptedCRC8);
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
    if (this.billingProcess.m_fLocalBilling) {
      const p = new CSendPacket(SC_SendPacket.OnUseCouponRes, CipherDegree.kPacketEncryptedCRC8);
      p.Encode1(7); // existing client-visible coupon refusal, no claim that it was redeemed
      socket.SendPacket(p);
      return;
    }
    if (id.length === 0 || this.db.prConfirmUnregisteredId(id) !== 0) {
      // CMainPool::OnRequestUseCoupon stores the pair on the user (+3008/+3032)
      user.m_strCoupon = coupon;
      user.m_strCouponId = id;
      CBillingProcess.ms_pInstance?.RequestCheckCoupon(user);
      return;
    }
    const p = new CSendPacket(SC_SendPacket.OnUseCouponRes, CipherDegree.kPacketEncryptedCRC8);
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
    const p = new CSendPacket(SC_SendPacket.OnCartList, CipherDegree.kPacketEncryptedCRC8);
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
    if (this.billingProcess.m_fLocalBilling) { this.PurchaseError(user, 1, BILLING_ERROR.unsupported); return; }
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
      if (item === null || item.MoneyType === 0) break; // billing items leave the tranx open, no receipt
      user.ResetTranxInfo();
      const idx = user.m_nCartCount;
      if ((user.m_anCart[idx]?.cnt ?? 0) <= 0) user.m_nCartCount = idx - 1;
      if (user.m_nCartCount < 0) {
        // the cart receipt: client 215 [E1 9][E1 0][EBuffer 8 variant time]
        // (CMainPool::PurchaseCartList tail, FxShop.exe.c 00416CF0)
        if (user.m_pSocket) {
          const p = new CSendPacket(SC_SendPacket.OnPurchaseCartListRes, CipherDegree.kPacketEncryptedCRC8);
          p.Encode1(9);
          p.Encode1(0);
          p.EncodeBuffer(variantTime(new Date()), 8);
          user.m_pSocket.SendPacket(p);
        }
        user.ResetTranxInfo();
        return;
      }
      user.m_anCart[user.m_nCartCount]!.cnt--;
    }
  }

  /** CMainPool::OnReqDigiQAuthorization (00416B80) — client 224.
   * Check selected user/+20 BEFORE reading the two client EStr fields.
   * The third billing string is copied from the character's C-string name.
   */
  OnReqDigiQAuthorization(n: CReceivedPacket, socket: CClientSocket): void {
    const user = socket.GetUser(socket.m_nSelectedUserIdx);
    if (!user || user.m_fTranxInProgress !== 0) return;
    const account = n.DecodeStr();
    const password = n.DecodeStr();
    const name = user.GetName().split("\0", 1)[0]!;
    CBillingProcess.ms_pInstance?.RequestDigiQAuthorization(account, password, name);
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
    const p = new CSendPacket(SC_SendPacket.OnTranxData, CipherDegree.kPacketEncryptedCRC8);
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
    const p = new CSendPacket(SC_SendPacket.OnShopSvrInfo, CipherDegree.kPacketEncryptedCRC8);
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
  /** CWebSocket::OnReceiveCompletionPacket runs the same 50-stamp receive
   *  flood ring and the "(%s), disconnected." overflow report as the client
   *  sockets (FxShop.exe.c:30457); its PutPacket reports the send-side
   *  overflow with the same "(%s)" shape (:30301). */
  m_fReceiveFloodGuard = true;

  protected ReportReceiveOverflow(): void {
    console.error(`Socket receive buffer overflow(${this.bunSocket?.remoteAddress ?? ""}), disconnected.`);
  }

  protected ReportSendOverflow(): void {
    console.error(`Socket send buffer overflow, close connection: (${this.bunSocket?.remoteAddress ?? ""})`);
  }

  /** CWebSocket::PutPacket's wrapper switch (FxShop.exe.c:30290) — the
   *  client shapes. */
  protected ReportPutError(err: EnSocket): void {
    if (err === enSocket.kioNotConnected) console.error("Not-connected client socket tried to put packet.");
    else if (err === enSocket.kioInvalidPacket) console.error("tried to send invalid( =\tNULL ) packet");
  }
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
    });
    this.m_szLogTag = "Shop";
    this.m_fClientLink = true;
    // CWebSocket::CWebSocket (30541) — the same header/sequence set as the
    // client sockets; the (Web) accept path does NOT raise the cipher degree.
    this.SetHeaderCode(
      CLIENTSOCKET_HEADER_CODE_RCV,
      CLIENTSOCKET_HEADER_CODE_SND,
      CLIENTSOCKET_HEADER_CODE_MODIFIER,
    );
    this.SetSequence(CLIENTSOCKET_SEQ, CLIENTSOCKET_SEQ, CLIENTSOCKET_SEQ_DELTA, CLIENTSOCKET_SEQ_DELTA);
    this.m_nLocalSerialNo = 1 + CWebSocket.ms_tblSerialNo2Socket.size;
    CWebSocket.ms_tblSerialNo2Socket.set(this.m_nLocalSerialNo, this);
  }

  /** the raw verify reply (4 bytes, no packet header) */
  SendBuffer(buf: ArrayBuffer | Uint8Array): EnSocket {
    return super.SendBuffer(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
  }

  protected OnClose(): void {
    for (const [sn, s] of CWebSocket.ms_tblSerialNo2Socket) if (s === this) CWebSocket.ms_tblSerialNo2Socket.delete(sn);
    super.OnClose();
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

// ============================ CBillingProcess ============================

/** _BILLINGSVR — the CRSBillingSvr row. */
interface BILLINGSVR {
  SN: number;
  ip: string;
  port: number;
}

interface LocalPurchase {
  user: CUser;
  stock: number;
  request: CSendPacket;
  reference: string | null;
  lastSend: number;
  started: number;
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
  m_fLocalBilling = false;
  private localPurchases = new Map<number, LocalPurchase>();

  constructor(public db: CDBMan) {
    CBillingProcess.ms_pInstance = this;
  }

  /** CBillingProcess::UpdateBillingSvrList — CRSBillingSvr ("BillingSvr"). */
  UpdateBillingSvrList(): void {
    this.m_aBillingSvr = this.db.GetBillingSvrs();
  }

  /** CBillingProcess::ConnectToSvr (FxShop.exe.c:505) — rotate the server
   *  list; every refused attempt reports, 10000 of them terminate. */
  m_nConnectAttempts = 0; // dword_498040

  async ConnectToSvr(): Promise<number> {
    if (this.m_aBillingSvr.length === 0) {
      console.log("[Shop] No billing server information!");
      return 0;
    }
    for (const svr of this.m_aBillingSvr) {
      const socket = new CBillingSocketTw(true, {
        onPacket: (_socket, packet) => this.OnPacket(packet),
      });
      socket.hooks.onClose = () => {
        console.error("[Shop] BillingSocket Connected closed... "); // :30937
        if (this.m_pSocket === socket) {
          this.m_pSocket = null;
          this.m_fConnected = 0;
        }
      };
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
            drain: () => socket.Flush(),
            close: () => socket.Close(),
            error: () => socket.Close(),
          },
        });
        if (!socket.m_bConnected) continue;
        socket.bunSocket = conn;
        this.m_pSocket = socket;
        this.m_fConnected = 1;
        console.log("[Shop] Connection to Billing Server established"); // :521
        // CBillingProcess::ConnectToSvr — the 331 hello: [E4 4][E4 GetWorld()]
        const hello = new CBillingSendPacket(TW_BILLING_SendPacket.OnConnEstablished);
        hello.Encode4(BILLING_GAME);
        hello.Encode4(this.m_nSvrTag);
        this.Send(hello);
        return this.m_fConnected;
      } catch {
        console.log("[Shop] Connection to Billing Server failed."); // :513
        if (++this.m_nConnectAttempts > 10000) {
          console.error("[Shop] CMainSystem:TerminateProcess() called, ExitProcess();");
          process.exit(1);
        }
        continue;
      }
    }
    return 0;
  }

  /** CBillingProcess::Init */
  async Init(): Promise<void> {
    this.m_fLocalBilling = usesLocalBilling(this.db);
    this.UpdateBillingSvrList();
    if ((await this.ConnectToSvr()) !== 0) this.m_fConnected = 1;
  }

  /** CBillingProcess::OnTimer — `++tick % 0x28 == 0 && !connected →
   *  ConnectToSvr()`; `% 0x5DC == 0 → TwRequestRTT()`. */
  async OnTimer(): Promise<void> {
    this.m_nRetryCount++;
    this.RetryLocalPurchases();
    if (this.m_nRetryCount % 0x28 === 0 && this.m_fConnected === 0) {
      if ((await this.ConnectToSvr()) !== 0) this.m_fConnected = 1;
    }
    if (this.m_nRetryCount % 0x5dc === 0) this.TwRequestRTT();
  }

  IsConnected(): number {
    return this.m_fConnected;
  }

  /** CBillingProcess::OnPacket (404DB0) — the billing ids are E4 payloads
   *  behind the dedicated 8-byte Tw frame. */
  OnPacket(n: CReceivedPacket): void {
    switch (n.Decode4()) {
      case TW_BILLING_ReceivedPacket.OnRemainCashTw:
        this.OnRemainCashTw(n);
        break;
      case TW_BILLING_ReceivedPacket.OnPurchaseOKTw:
        this.OnPurchaseOKTw(n);
        break;
      case TW_BILLING_ReceivedPacket.OnPurchaseConfirmTw:
        this.OnPurchaseConfirmTw(n);
        break;
      case TW_BILLING_ReceivedPacket.OnDigiQAuthen:
        this.OnDigiQAuthen(n);
        break;
      case TW_BILLING_ReceivedPacket.OnTwRTT:
        console.log("[Shop] Received RTT Response");
        break;
      default:
        return;
    }
  }

  /** CBillingProcess::RequestRemainCashTw — billing 301 (4-byte opcode, raw degree):
   *  [E4 SID][E4 BID][E4 4][E4 GetWorld()][E1 len][name][E4 serial]
   *  [E1 len][client ip].  Requires the billing link (this+324) and the
   *  user's socket. */
  RequestRemainCashTw(user: CUser): void {
    if (this.m_fConnected === 0) return;
    if (!user.m_pSocket) return;
    const ip = user.m_pSocket.m_strPeerAddress;
    const name = user.GetName().split("\0", 1)[0]!;
    const p = new CBillingSendPacket(TW_BILLING_SendPacket.RequestRemainCashTw);
    p.Encode4(user.m_nSID);
    p.Encode4(user.m_nBID);
    p.Encode4(BILLING_GAME);
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
    const p = CBillingSendPacket.FromBillingPacket(BILLING_SendPacket.RequestGift);
    p.Encode4(user.GetGlobalSerialNo());
    p.Encode4(0);
    p.Encode4(0);
    p.Encode4(stockSN);
    p.Encode4(price);
    p.EncodeStr(user.GetNexonClubId());
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
    const p = CBillingSendPacket.FromCouponPacket(COUPON_SendPacket.RequestCheckCoupon);
    this.EncodeCouponBody(p, user);
    this.Send(p);
  }

  RequestUseCoupon(user: CUser): void {
    const p = CBillingSendPacket.FromCouponPacket(COUPON_SendPacket.RequestUseCoupon);
    this.EncodeCouponBody(p, user);
    this.Send(p);
  }

  private EncodeCouponBody(p: CSendPacket, user: CUser): void {
    p.Encode4(user.GetGlobalSerialNo());
    p.EncodeStr(user.m_strCoupon);
    p.EncodeStr(user.GetNexonClubId());
    p.EncodeStr(user.GetName());
    p.Encode1(CxShop.ms_pInstance!.m_nFXAttr & 0xff); // CMainSystem+4 GetDomain
    p.Encode2(user.m_nUserAccountHiword);
  }

  /** CBillingProcess::RequestDigiQAuthorization — billing 341:
   *  [E1 len][Ebuf]×3 (three length-prefixed ANSI strings). */
  RequestDigiQAuthorization(account: string, password: string, name: string): void {
    const p = new CBillingSendPacket(TW_BILLING_SendPacket.RequestDigiQAuthorization);
    for (const s of [account, password, name]) {
      const buf = Buffer.from(s, "latin1");
      p.Encode1(buf.length);
      p.EncodeBuffer(buf);
    }
    if (!this.m_pSocket?.m_bConnected) {
      console.warn("[Shop] DigiQ authorization: billing link is unavailable; check CAConfig BillingSvr and connection logs.");
    }
    // Native still attempts PutPacket/Flush while disconnected. Never invent
    // an authorization result or log these credential-bearing strings here.
    this.Send(p);
  }

  /** CBillingProcess::RequestPurchaseTw — billing 311:
   *  [E4 SID][E4 BID][E4 4][E4 GetWorld()][E1 len][name][E4 price][E4 1]
   *  [E4 globalSerialNo][E4 stockSN][E4 1][E1 len][client ip]. */
  RequestPurchaseTw(user: CUser, item: ShopItem): void {
    if (!user.m_pSocket) return;
    if (this.m_fLocalBilling) {
      if (this.localPurchases.has(user.GetGlobalSerialNo())) {
        this.LocalPurchaseError(user, BILLING_ERROR.pending);
        return;
      }
      if (!this.IsConnected()) {
        this.LocalPurchaseError(user, BILLING_ERROR.unavailable);
        return;
      }
    }
    const ip = user.m_pSocket.m_strPeerAddress;
    const name = user.GetName().split("\0", 1)[0]!;
    const p = new CBillingSendPacket(TW_BILLING_SendPacket.RequestPurchaseTw);
    p.Encode4(user.m_nSID);
    p.Encode4(user.m_nBID);
    p.Encode4(BILLING_GAME);
    p.Encode4(this.m_nSvrTag);
    string8(p, name);
    p.Encode4(item.Price);
    p.Encode4(1);
    p.Encode4(user.GetGlobalSerialNo()); // 00402975..00402980: +3096 serial, NOT BID
    p.Encode4(item.SN);
    p.Encode4(1);
    string8(p, ip);
    if (this.m_fLocalBilling) {
      const now = Date.now();
      const purchase: LocalPurchase = { user, stock: item.SN, request: p, reference: null, lastSend: now, started: now };
      this.localPurchases.set(user.GetGlobalSerialNo(), purchase);
      user.m_pPurchaseTranx = purchase;
    }
    this.Send(p);
  }

  private LocalPurchaseError(user: CUser, message: string): void {
    if (user.m_fTranxInProgress !== 0) return;
    const p = new CSendPacket(SC_SendPacket.OnPurchaseRes, CipherDegree.kPacketEncryptedCRC8);
    p.Encode1(1); p.EncodeStr(message);
    user.m_pSocket?.SendPacket(p);
  }

  private FinishLocalPurchase(serial: number): void {
    const purchase = this.localPurchases.get(serial);
    if (purchase) purchase.user.m_pPurchaseTranx = null;
    this.localPurchases.delete(serial);
  }

  private MakePurchaseConfirmTw(reference: string, serial: number, stock: number, result: number): CSendPacket {
    const p = new CBillingSendPacket(TW_BILLING_SendPacket.PurchaseConfirmTw);
    string8(p, reference); p.Encode4(serial); p.Encode4(stock); p.Encode4(result);
    return p;
  }

  /** Resend only the current phase. A lost 322 retries the SAME durable
   * reference, never a fresh debit. A pending confirmation has no guessed
   * failure timeout: storage may already have committed its inventory/points.
   */
  RetryLocalPurchases(): void {
    const now = Date.now();
    for (const [serial, purchase] of this.localPurchases) {
      if (purchase.reference === null && now - purchase.started > RESERVATION_MS) {
        this.LocalPurchaseError(purchase.user, BILLING_ERROR.expired);
        this.FinishLocalPurchase(serial);
      } else if (this.IsConnected() && now - purchase.lastSend >= LOCAL_BILLING_RETRY_MS) {
        purchase.lastSend = now;
        this.Send(purchase.request);
      }
    }
  }

  /** CBillingProcess::TwRequestRTT — billing 351: [E1 123]. */
  TwRequestRTT(): void {
    const p = new CBillingSendPacket(TW_BILLING_SendPacket.TwRequestRTT);
    p.Encode1(123);
    this.Send(p);
  }

  /** CBillingProcess::OnRemainCashTw (004039F0) — billing 302.
   * [E4 ignored][E1 length + name bytes][E4 serial][E4 cash][E4 result].
   * ONLY result 1 is an error, followed by an E1-length message; every
   * other result updates user+3104 and returns client 203 [E1 1][E4 cash].
   */
  OnRemainCashTw(n: CReceivedPacket): void {
    if (n.m_uLength - n.m_uOffset < 4) return;
    n.Decode4();
    if (DecodeBillingString(n) === null || n.m_uLength - n.m_uOffset < 12) return;
    const serial = n.Decode4();
    const cash = n.Decode4();
    const result = n.Decode4();
    const user = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(serial);
    if (!user || user.m_fTranxInProgress !== 0) return;
    const p = new CSendPacket(SC_SendPacket.OnRemainCashTw, CipherDegree.kPacketEncryptedCRC8);
    if (result === 1) {
      const message = DecodeBillingString(n);
      if (message === null) return;
      p.Encode1(0);
      p.EncodeStr(message);
    } else {
      user.SetCash(cash);
      p.Encode1(1);
      p.Encode4(cash);
    }
    user.m_pSocket?.SendPacket(p);
  }

  /** 00403C80: 312 [E4]x3 [E1 len + reference] [E4 serial,stock,result].
   * Local billing performs atomic delivery on 321, so Shop must NOT insert
   * a second inventory row here. External settlement remains unsupported and
   * is cancelled using the native orphan-user 321/result=2 path.
   */
  OnPurchaseOKTw(n: CReceivedPacket): void {
    const r = new BillingReader(n.m_pBlock.subarray(n.m_uOffset, n.m_uLength));
    try {
      r.u32(); r.u32(); r.u32();
      const reference = r.string(), serial = r.u32(), stock = r.u32(), result = r.u32();
      const message = result === 1 ? r.string() : "";
      r.end();
      const purchase = this.localPurchases.get(serial);
      if (!purchase || !this.m_fLocalBilling) {
        if (result === 0) this.Send(this.MakePurchaseConfirmTw(reference, serial, 0xffffffff, 2));
        if (!this.m_fLocalBilling) {
          const user = CLocalUserTable.ms_pInstance?.FindUserFromGlobalSerialNo(serial);
          if (user && user.m_fTranxInProgress === 0) this.LocalPurchaseError(user, result ? message : BILLING_ERROR.unsupported);
        }
        return;
      }
      if (purchase.stock !== stock) return;
      if (purchase.reference !== null) {
        if (reference === purchase.reference && result === 0) this.Send(purchase.request);
        return; // never let a late 312 failure overwrite a confirming purchase
      }
      if (result !== 0) {
        this.LocalPurchaseError(purchase.user, message);
        this.FinishLocalPurchase(serial);
        return;
      }
      if (!/^[a-f0-9]{32}$/.test(reference)) return;
      purchase.reference = reference;
      purchase.request = this.MakePurchaseConfirmTw(reference, serial, stock,
        purchase.user.m_pSocket && purchase.user.m_fTranxInProgress === 0 ? 0 : 2);
      purchase.lastSend = Date.now();
      this.Send(purchase.request);
    } catch {
      console.warn("[Shop] Invalid billing 312; purchase remains pending for retry.");
    }
  }

  /** 004047B0: 322 [E1 len + reference][E4 serial,result][error: string8]. */
  OnPurchaseConfirmTw(n: CReceivedPacket): void {
    const r = new BillingReader(n.m_pBlock.subarray(n.m_uOffset, n.m_uLength));
    try {
      const reference = r.string(), serial = r.u32(), result = r.u32();
      const message = result !== 0 ? r.string() : "";
      r.end();
      const purchase = this.localPurchases.get(serial);
      if (!this.m_fLocalBilling || !purchase || purchase.reference !== reference) return;
      if (result !== 0) this.LocalPurchaseError(purchase.user, message);
      else {
        const p = new CSendPacket(SC_SendPacket.OnPurchaseRes, CipherDegree.kPacketEncryptedCRC8);
        p.Encode1(0); p.EncodeBuffer(variantTime(new Date()), 8);
        if (purchase.user.m_fTranxInProgress === 0) purchase.user.m_pSocket?.SendPacket(p);
      }
      this.FinishLocalPurchase(serial);
    } catch {
      console.warn("[Shop] Invalid billing 322; purchase remains pending for retry.");
    }
  }

  /** CBillingProcess::OnDigiQAuthen (004044C0) — billing 342.
   * [E4 SID][E4 BID][E1 length + character name][E4 result].
   * Zero succeeds: client 209/12, then query cash using the EXISTING user
   * SID/BID (native does not assign the returned pair to the user).
   * Nonzero fails: client 209/13 with the following E1-length message.
   */
  OnDigiQAuthen(n: CReceivedPacket): void {
    if (n.m_uLength - n.m_uOffset < 8) return;
    const sid = n.Decode4();
    const bid = n.Decode4();
    const name = DecodeBillingString(n);
    if (name === null || n.m_uLength - n.m_uOffset < 4) return;
    const result = n.Decode4();
    const user = CLocalUserTable.ms_pInstance!.FindUser(name);
    if (!user || user.m_fTranxInProgress !== 0) return;
    const p = new CSendPacket(SC_SendPacket.OnDigiQAuthenRes, CipherDegree.kPacketEncryptedCRC8);
    if (result !== 0) {
      const message = DecodeBillingString(n);
      if (message === null) return;
      p.Encode1(13);
      p.EncodeStr(message);
      user.m_pSocket?.SendPacket(p);
    } else {
      p.Encode1(12);
      p.Encode4(sid);
      p.Encode4(bid);
      user.m_pSocket?.SendPacket(p);
      this.RequestRemainCashTw(user);
    }
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
    // the 3 s retry loop lives in CLocalSocket.ConnectToCenter (FxShop.exe.c:4247)
    await this.m_pSocket.ConnectToCenter(
      cfg.GetAttribute("CenterIP"),
      cfg.GetNumAttribute("CenterPort"),
      SVRCLASS_SHOP,
      cfg.GetNumAttribute("ServerIndex"),
      // gameVersion/clientVersion default from S2S GAME_VERSION/CLIENT_VERSION
      // (FxShop.exe.c:4276 — [E2 7][E2 3])
    );
    console.log("[Shop] Connection to Center Server established");
  }

  SendPacket(packet: CSendPacket): void {
    this.m_pSocket.SendToCenter(packet);
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
        CMainPool.ms_pInstance?.OnCenterResConnectToSvr(n);
        return;
      case CM_ShopServerPacket.OnCenterResConnEstablished:
        CMainPool.ms_pInstance?.OnCenterResConnEstablished(n);
        return;
      case CM_ShopServerPacket.OnShopServerInfo:
        this.OnShopServerInfo(n);
        return;
      case CM_ShopServerPacket.OnAdminNotifyMsg:
        this.OnAdminNotifyMsg(n);
        return;
      case CM_ShopServerPacket.OnInitialSvrAttr:
        this.OnInitialSvrAttr(n);
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
    CUserPool.SendAll(CUserPool.CreateSocketList(CMainPool.ms_pInstance!), p);
  }

  /** CMainSystem::OnInitialSvrAttr — CM 12 [E1 attr][E1 ?] → the FX
   *  attribute id (the dispatch's case 12 callee). */
  OnInitialSvrAttr(n: CReceivedPacket): void {
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

/** CMainSystem::OnConnEstablished (FxShop.exe.c:21056) — the client patch URL. */
const CONN_PATCH_URL = "ftp://patch.nexon.co.kr/ca";

/** CMainSystem — the shop's system object; OnConnEstablished pushes the
 *  accept packet (FxShop.exe.c:21041):
 *  0: [E2 CENTER_VERSION][E2 CONN_HELLO_VERSION[class]][E4 headerType][EStr url]. */
export class CMainSystem {
  static ms_pInstance: CMainSystem | null = null;

  constructor() {
    CMainSystem.ms_pInstance = this;
  }

  OnConnEstablished(socket: CClientSocket): void {
    const packet = new CSendPacket(SC_SendPacket.OnConnect);
    packet.Encode2(CENTER_VERSION);
    packet.Encode2(CONN_HELLO_VERSION[SVRCLASS_SHOP]);
    packet.Encode4(socket.m_nHeaderType);
    packet.EncodeStr(CONN_PATCH_URL);
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
            socket.SetCipherDegree(CipherDegree.kPacketEncryptedCRC8);
          } catch (e) {
            console.error("[Shop] client accept failed", e);
          }
        },
        data: (t, data) => {
          const s = clientSockets.get(t);
          if (s) {
            s.m_dwIdleTime = timeGetTime();
            s.OnReceive(new Uint8Array(data as Buffer));
          }
        },
        drain: (t) => clientSockets.get(t)?.Flush(),
        close: (t) => clientSockets.get(t)?.Close(),
        error: (_t, err) => console.error(`[Shop] ${String(err)}`),
      },
    });
    console.log(`[Shop] listening on :${port}`);

    // CListenExThread — the web mall listener (ServerPort+1)
    const webPort = port + 1;
    const webSockets = new WeakMap<object, CWebSocket>();
    let webAcceptCount = 0; // CListenExThread::Proc's v2
    if (!process.env.TC_NOWEB) Bun.listen({
      hostname: "0.0.0.0",
      port: webPort,
      socket: {
        open: (t) => {
          const socket = new CWebSocket();
          webSockets.set(t, socket);
          socket.bunSocket = t as Bun.Socket<any>;
          socket.m_bConnected = true;
          console.log(`[Shop] (Web) Connection establish[${t.remoteAddress ?? ""}]`); // FxShop.exe.c:16774
          if (++webAcceptCount % 100 === 0) console.log(`[Shop] VerifyKey Connection Count:${webAcceptCount}`);
        },
        data: (t, data) => {
          webSockets.get(t)?.OnReceive(new Uint8Array(data as Buffer));
        },
        drain: (t) => webSockets.get(t)?.Flush(),
        close: (t) => {
          const s = webSockets.get(t);
          if (s) {
            console.log(`[Shop] (WebSocket)End of file, close connection(${s.bunSocket?.remoteAddress ?? ""})`); // :30950
            s.Close();
          }
        },
        error: (_t, err) => console.error(`[Shop web] ${String(err)}`),
      },
    });
    console.log(`[Shop] web listener on :${webPort}`);

    // CTimerThread::Proc — one Sleep(0x190) tick: the billing retry rides
    // every tick (its own mod gates set the cadence), the idle sweep is
    // CUserPool::OnTimer's %0x4B gate.
    let poolOnTimerCount = 0; // dword_498368
    let censusTime = 0; // the static ::Time of FlushClientSocketSndBuffer
    setInterval(() => {
      this.mainPool.OnTimer(++poolOnTimerCount);
      void this.billing.OnTimer();
      // CClientSocket::FlushClientSocketSndBuffer — the flush writes
      // through; the 5-minute census line stays (FxShop.exe.c:5278)
      const now = Date.now() & 0x7fffffff;
      if (censusTime === 0) censusTime = now;
      if (now - censusTime > CLIENT_SOCKET_CENSUS_MS) {
        let sockets = 0;
        let users = 0;
        for (const s of CClientSocket.ms_tblSN2Obj.values()) {
          const c = s.GetUserCount();
          if (c !== 0) {
            sockets++;
            users += c;
          }
        }
        if (sockets !== 0 && users !== 0) console.log(`[Shop] Socket count(${sockets}), UserCount(${users})`);
        censusTime = now;
      }
    }, 0x190);
  }
}

// enSocket re-export guard (tree-shaking helper)

// ============================ main ============================

/** the shop entry — mirror of CFxShopApp::SetUp's argv handling: the first
 *  token is the cfg path (missing ".cfg" → + ".cfg"). */
export async function main(cfgPath: string, dbDir: string): Promise<void> {
  const cfg = new CServerConfig(FXSHOP_STR_KEYS);
  cfg.Init(cfgPath);
  CServerConfig.ms_pInstance = cfg;

  PacketLog.Configure("Shop");
  PacketLog.Register("Shop", "recv", ...PACKET_NAME_TABLES.Shop.recv);
  PacketLog.Register("Shop", "send", ...PACKET_NAME_TABLES.Shop.send);
  PacketLog.Register(BILLING_PACKET_LOG_CONTEXT.Taiwan, "recv", ...PACKET_NAME_TABLES.BILL.recv);
  PacketLog.Register(BILLING_PACKET_LOG_CONTEXT.Taiwan, "send", ...PACKET_NAME_TABLES.BILL.send);
  PacketLog.Register(BILLING_PACKET_LOG_CONTEXT.Billing, "send", ...PACKET_NAME_TABLES.BILLING.send);
  PacketLog.Register(BILLING_PACKET_LOG_CONTEXT.Coupon, "send", ...PACKET_NAME_TABLES.COUPON.send);

  const shop = new CxShop(cfg, dbDir);
  await shop.Init();
}
