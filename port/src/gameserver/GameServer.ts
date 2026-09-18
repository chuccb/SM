/**
 * FXGS — the game server (FxServer.exe).
 *
 * This unit covers everything from process boot through the lobby:
 *   boot          CFxServerApp::SetUp — config, DB, pools, listeners
 *   center link   CCenterProcess::Init (greeting + identification
 *                 [class=10][idx^0x77][u16 7][u16 3]) and its OnPacket
 *                 dispatch (2 ResConnEstablished, 3 LocalServerInfo,
 *                 4 LocalServerState, 5 LocalGameState, 7 SvrReservedMsg,
 *                 8 AdminNotifyMsg, 10 UserChannelResult, 11 DeleteUser,
 *                 12 InitialSvrAttr, 13 SystemMsg, 14 ItemDBInit)
 *   client entry  CMainSystem::OnConnEstablished pushes packet 0
 *                 [E2 3][E2 7][E4 headerType] at once; CConnectPool::OnPacket
 *                 handles 7 (ConnEstablished) and 20 (RTT), and
 *                 OnCenterResConnEstablished performs the DB login
 *                 (prGetUserInfo + InitUserInventory + guilds) and answers
 *                 210 / 202 / 207 / 201 before moving the socket into the
 *                 channel pool
 *   lobby         CChannelPool::OnPacket — 6 ReqConnectToSvr, 15
 *                 ReqChannelsState, 16 EnterChannelStage, 20 RTT (via
 *                 CUserPool), 28 InviteUser, 38 GuildMarkRevision,
 *                 64/65/66/67/68/69/70 user+guild info, 80/81/82 session
 *                 create/join/join-free (via CGameSessionTable), 83
 *                 EnterLobbyStage, 85 GuildMemberInfo, 209 UserInventory
 *                 and 208 → CChatPool (25/26/27/28/30/31/71/74/216)
 *
 * The socket stage tag (+468) mirrors the original exactly: 0 = the connect
 * pool, 3 = channel-select stage (after 16), 1 = lobby stage (after 83),
 * 2 = seated in a room, 4 = playing, 6 = practice.  The room stage itself
 * (CListSession::OnPacket 96.., the strategies and the in-play game) is the
 * next unit; CGameSession here carries exactly the fields the room-list
 * (83/85/86/87) and join (80/81) packets expose.
 */
import { CServerConfig } from "../core/Config.ts";
import { CPacketSocket } from "../core/CPacketSocket.ts";
import { CReceivedPacket, CSendPacket } from "../core/Packet.ts";
import { CDBMan } from "../db/DBMan.ts";
import { CLocalSocket } from "../lib/CenterLink.ts";
import { CM_ReceivedPacket, MC_ReceivedPacket, SVRCLASS_GAME } from "../lib/S2S.ts";
import {
  CLIENTSOCKET_HEADER_CODE_MODIFIER,
  CLIENTSOCKET_HEADER_CODE_RCV,
  CLIENTSOCKET_HEADER_CODE_SND,
  CLIENTSOCKET_SEQ,
  CLIENTSOCKET_SEQ_DELTA,
  GS_ReceivedPacket,
} from "../lib/PacketIDs.ts";
import { CDynInfoCalculator_GetLevel, kLevelTableSize } from "../login/LevelTable.ts";

/** Client-facing packet ids only the game server sends. */
export const GS_ClientSend = {
  OnConnect: 0, // CMainSystem::OnConnEstablished [E2 3][E2 7][E4 headerType]
  OnEstimateRTTRes: 20, // CUserPool::OnEstimateRTT
  OnReqConnectToSvrRes: 2, // CM 1 success path: [E1 1][E1 type][E4 idx][E4 ip][E2 port]
  OnReqConnectToSvrFail: 6, // CheckEnterGame failure code
  OnChannelAnnounce: 15, // the empty lobby announce (OnAddNewSocket / 83)
  OnChannelsState: 13, // CCenterProcess::MakeChannelsStatePacket
  OnChannelsGameState: 14, // CCenterProcess::MakeChannelsGameStatePacket
  OnSvrReservedMsg: 16, // CCenterProcess::OnSvrReservedMsg
  OnAdminNotifyMsg: 26,
  OnChatMsg: 25, // lobby/in-session chat
  OnWhisperRes: 27, // CChatPool::OnWhisper (to the receiver)
  OnWhisperFail: 28, // target absent: [E1 0][EStr name]
  OnItemMsg: 25, // CChatPool::OnItemMsg shares the chat id
  OnSystemMsg: 30,
  OnInviteUser: 29,
  OnShoutMsg: 74,
  OnKickoffUser: 26, // CGameSessionTable::KickImp "abnormal state…"
  OnGuildBanRes: 17, // guild-table overflow on entry
  OnRequestUserSimpleInfoRes: 70, // CChannelPool::PutUserSimpleInfoPacket
  OnRequestMyInfoRes: 64, // CChannelPool::OnRequestMyInfo
  OnGuildMemberListRes: 67, // CChannelPool::PutGuildMemberListPacket
  OnRequestUserInfoDetailRes: 71,
  OnRequestUserLocationRes: 72,
  OnRequestGuildInfoRes: 66,
  OnUserItemList: 202, // the whole FxItem table
  OnPreInventory: 207, // [E1 n][per-user pre-inventory]
  OnUserInventory: 201, // [E1 n][per-user inventory]
  OnEnterGame: 210, // [E1 attr] — the entry-accepted packet
  OnSessionSimpleInfo: 83, // CListSession::MakeSimpleInfoPacket (room list)
  OnSessionCreated: 85, // CListSession::MakeCreatedPacket
  OnSessionModified: 86, // CListSession::MakeModifiedPacket
  OnSessionDestroyed: 87, // CListSession::MakeDestroyedPacket
  OnCreateSessionRes: 80, // [E1 result][E2 idx][E4 serial][E1 gameType]
  OnJoinSessionRes: 81, // [E1 result]
  OnSetPlayer: 105, // CBaseSession::MakeSetPlayerPacket
  OnSessionCurPlayer: 112, // CGameSession::SendSessionInfoPacket tail
} as const;

/** p7 client-check constants (CConnectPool::OnConnEstablished). */
const FxCLIENT_HASH_A = 0xf1164b8b;
const FxCLIENT_HASH_B = 0x11221122;
/** CUserPool::OnEstimateRTT — no second RTT within 0x1374 ms, else SpeedHack. */
const RTT_MIN_INTERVAL = 0x1374;
/** …and the memory-check magic pair (DF1A2E51 = ~11221122). */
const RTT_HASH = 0x11221122;
const RTT_HASH_INV = 0xdf1a2e51;
/** CUserPool::DisconnectTimeoutSocket — 0x9C40 ms without RTT. */
const SOCKET_TIMEOUT = 0x9c40;
/** CUser::DeferFlushModifiedInfo — burst flush threshold (0x19). */
const DYN_FLUSH_BURST = 0x19;

/** CTime::GetVariantTime — the OLE automation date double. */
function GetVariantTime(date: Date | null): number {
  if (!date) return 0;
  return date.getTime() / 86400_000 + 25569;
}

// ============================ item tables ============================

/** UserItem — the value of CUserItemMan's map (the SN lives in the key). */
export interface UserItem {
  Type: number;
  strAttr: string;
  nAttr1: number;
  nAttr2: number;
  nAttr3: number;
  strName: string;
}

/** ShopItem — a row of FxStock (CRSShopItem::OnReceiveRow). */
export interface ShopItem {
  SN: number;
  Category: number;
  Name: string;
  Description: string;
  ItemSN: number;
  Unit: number;
  DataFile: string;
  Price: number;
  LimitLevel: number;
  LimitEx: number;
  ValidityPeriod: number;
  ValidityLevel: number;
}

/** CUserItemMan — the FxItem/FxStock cache (CUserItemMan::Init). */
export class CUserItemMan {
  static ms_pInstance: CUserItemMan | null = null;

  m_vtUserItem = new Map<number, UserItem>();
  m_vtShopItem = new Map<number, ShopItem>();

  constructor() {
    CUserItemMan.ms_pInstance = this;
  }

  /** CUserItemMan::Init (also re-run on center packet 14). */
  Init(db: CDBMan): boolean {
    const a = this.UpdateUserItemTable(db);
    const b = this.UpdateShopItemTable(db);
    return a && b;
  }

  /** CUserItemMan::UpdateUserItemTable — "SN, Category, strAttr, nAttr1, nAttr2, nAttr3, strName". */
  UpdateUserItemTable(db: CDBMan): boolean {
    this.m_vtUserItem.clear();
    for (const r of db.GetItemInfo()) {
      this.m_vtUserItem.set(r.SN, {
        Type: r.Category,
        strAttr: r.strAttr,
        nAttr1: r.nAttr1,
        nAttr2: r.nAttr2,
        nAttr3: r.nAttr3,
        strName: r.strName,
      });
    }
    return true;
  }

  /** CUserItemMan::UpdateShopItemTable — "SN, Category, Name, Description, ItemSN, Unit, DataFile, Price, …". */
  UpdateShopItemTable(db: CDBMan): boolean {
    this.m_vtShopItem.clear();
    for (const r of db.GetShopStock()) this.m_vtShopItem.set(r.SN, { ...r });
    return true;
  }

  /** CUserItemMan::GetUserItem */
  GetUserItem(SN: number): UserItem | null {
    return this.m_vtUserItem.get(SN) ?? null;
  }

  /** CUserItemMan::GetShopItem */
  GetShopItem(SN: number): ShopItem | null {
    return this.m_vtShopItem.get(SN) ?? null;
  }

  /** CUserItemMan::PutUserItemList — packet 202 body. */
  PutUserItemList(packet: CSendPacket): void {
    packet.Encode2(this.m_vtUserItem.size);
    for (const [sn, item] of this.m_vtUserItem) {
      packet.Encode4(sn);
      packet.Encode1(item.Type);
      packet.EncodeStr(item.strAttr);
      packet.Encode4(item.nAttr1);
      packet.Encode4(item.nAttr2);
      packet.Encode4(item.nAttr3);
      packet.EncodeStr(item.strName);
    }
  }
}

// ============================ account rows ============================

/** _USERACCOUNT — the prGetUserInfo out-block (172 bytes in the original). */
export interface _USERACCOUNT {
  SN: number;
  strID: string;
  strName: string;
  Password: string;
  Email: string;
  EmailRcv: number;
  Gender: number;
  Address: string;
  Tel: string;
  Reveal: number;
  Profile: string;
  TotalConn: number;
  LastConn: string;
  Permission: number;
  ShopCardNo: number;
  CommunitySvr: number;
  Birthday: string;
  GuildSn: number;
}

/** _USERDYNINFO — money/exp/win/draw/lose (+ the id). */
export interface _USERDYNINFO {
  strID: string;
  money: number;
  exp: number;
  win: number;
  draw: number;
  lose: number;
}

/** UserInventory — one owned item (84 bytes in the original). */
export class UserInventory {
  ItemSN = 0; // +0
  StockSn = 0; // +4
  Type = 0; // +8 (the FxItem category)
  strName = ""; // +12
  strAttr = "";
  nAttr1 = 0;
  nAttr2 = 0;
  nAttr3 = 0;
  Slot = -1; // +28 (i32 view; equipped decoration slot)
  SlotByte = 0xff; // +36 (the DB Slot byte; 0xFF = not equipped)
  Amount = 0; // +40
  Verbose = ""; // +44
  DateCreated: Date | null = null; // +56
  LevelCreated = 0;
  fModified = 0; // +80
}

/** PreInventory — one claimable purchase (m_apPreInventory entry). */
export class PreInventory {
  SN = 0;
  Type = 0;
  ItemSn = 0;
  StockSn = 0;
  Slot = 0;
  Amount = 0;
  strAttr = "";
  ValidityPeriod = 0;
  ValidityLevel = 0;
  Description = "";
}

// ============================ CUser ============================

/** CUser — one logged-in player (0x7DC bytes in the original). */
export class CUser {
  strName: string;
  account: _USERACCOUNT;
  dyn: _USERDYNINFO;
  m_pSocket: CClientSocket | null;
  m_nSlotIdx = -1; // +490
  m_nGlobalSerialNo = 0; // +491 (CUser::SetGlobalSerialNo)
  m_nGuildSN = 0; // +493 (CUser::SetGuildSerialNo; filled from the p7 tail)
  m_fMoneyModified = 0; // +494
  m_fExpModified = 0; // +495
  m_nLevel = 0; // +496
  m_nBonusLevel = 0; // +497
  m_nPremiumSvrId = 0; // +498
  m_nPremiumSvrIdx = 0; // +499
  m_nFlushCount = 0; // +500 (DeferFlushModifiedInfo burst counter)
  m_fPremiumTicket = 0; // +2004 byte
  m_fModifiedClient = 0; // +2008 (the p7 tail byte)
  m_vtInventory: UserInventory[] = [];
  m_apPreInventory: (PreInventory | null)[] = new Array(30).fill(null);
  m_nPreInventoryCount = 0; // +1920

  constructor(socket: CClientSocket) {
    this.strName = "";
    this.m_pSocket = socket;
    this.account = {
      SN: 0,
      strID: "",
      strName: "",
      Password: "",
      Email: "",
      EmailRcv: 0,
      Gender: 0,
      Address: "",
      Tel: "",
      Reveal: 0,
      Profile: "",
      TotalConn: 0,
      LastConn: "",
      Permission: 0,
      ShopCardNo: 0,
      CommunitySvr: 0,
      Birthday: "",
      GuildSn: 0,
    };
    this.dyn = { strID: "", money: 0, exp: 0, win: 0, draw: 0, lose: 0 };
  }

  GetName(): string {
    return this.strName;
  }

  SetName(a2: string): void {
    this.strName = a2;
  }

  /** CUser::SetGlobalSerialNo */
  SetGlobalSerialNo(a2: number): void {
    this.m_nGlobalSerialNo = a2 >>> 0;
  }

  GetGlobalSerialNo(): number {
    return this.m_nGlobalSerialNo;
  }

  /** CUser::SetGuildSerialNo */
  SetGuildSerialNo(a2: number): void {
    this.m_nGuildSN = a2;
  }

  GetGuildSerialNo(): number {
    return this.m_nGuildSN;
  }

  /** CUser::SetSessionIdx — through the owning socket (+500). */
  SetSessionIdx(a2: number): void {
    if (this.m_pSocket) this.m_pSocket.m_nSessionIdx = a2;
  }

  /** CUser::GetSessionIdx */
  GetSessionIdx(): number {
    return this.m_pSocket ? this.m_pSocket.m_nSessionIdx : -1;
  }

  /** CUser::SetSessionSerialNo — through the owning socket (+504). */
  SetSessionSerialNo(a2: number): void {
    if (this.m_pSocket) this.m_pSocket.m_nSessionSerialNo = a2 >>> 0;
  }

  GetSessionSerialNo(): number {
    return this.m_pSocket ? this.m_pSocket.m_nSessionSerialNo : 0;
  }

  /** CUser::SetPoolType / GetPoolType — the owning socket's stage tag (+468). */
  SetPoolType(a2: number): void {
    if (this.m_pSocket) this.m_pSocket.m_nPoolType = a2;
  }

  GetPoolType(): number {
    return this.m_pSocket ? this.m_pSocket.m_nPoolType : -1;
  }

  /** CUser::SetLevel — CDynInfoCalculator::GetLevel(exp). */
  SetLevel(): void {
    this.m_nLevel = CDynInfoCalculator_GetLevel(this.dyn.exp);
  }

  /** CUser::GetLookLevel — level + bonus clamped to 1..450. */
  GetLookLevel(): number {
    const n = this.m_nLevel + this.m_nBonusLevel;
    if (n < 1) return 1;
    if (n > kLevelTableSize - 1) return kLevelTableSize - 1;
    return n;
  }

  /** CUser::IncDecMoney — clamps into 0..1000000 and marks the flush flag. */
  IncDecMoney(value: number): void {
    this.dyn.money += value;
    this.dyn.money = Math.max(0, Math.min(1000000, this.dyn.money));
    this.m_fMoneyModified = 1;
  }

  /** CUser::IncDecExp — returns +1 levelup / -1 leveldown / 0. */
  IncDecExp(value: number): number {
    const old = this.m_nLevel;
    this.dyn.exp = Math.max(0, this.dyn.exp + value);
    this.m_fMoneyModified = 1;
    this.SetLevel();
    if (this.m_nLevel !== old) {
      this.m_fExpModified = 1;
      return this.m_nLevel > old ? 1 : -1;
    }
    return 0;
  }

  /** CUser::DeferFlushModifiedInfo — prUpdateUserDynamic when forced or bursty. */
  DeferFlushModifiedInfo(db: CDBMan, a2: number): void {
    if (a2 !== 0 || this.m_nFlushCount >= DYN_FLUSH_BURST) {
      this.m_nFlushCount = 0;
      if (this.m_fMoneyModified !== 0) {
        db.prUpdateUserDynamic(this.dyn.strID, this.dyn.money, this.dyn.exp, this.dyn.win, this.dyn.draw, this.dyn.lose);
        this.m_fMoneyModified = 0;
      }
      this.m_fExpModified = 0;
    } else {
      this.m_nFlushCount++;
    }
  }

  /** CUser::AddInventory */
  AddInventory(inv: UserInventory): void {
    this.m_vtInventory.push(inv);
  }

  /** CUser::GetUserInventory */
  GetUserInventory(ItemSN: number): UserInventory | null {
    return this.m_vtInventory.find((i) => i.ItemSN === ItemSN) ?? null;
  }

  /** CUser::GetUserInventoryFromAll — by item id string. */
  GetUserInventoryFromAll(name: string): UserInventory | null {
    return this.m_vtInventory.find((i) => i.strName === name) ?? null;
  }

  /** CUser::HasFunctionalItem (category 2). */
  HasFunctionalItem(name: string): boolean {
    return this.m_vtInventory.some((i) => i.Type === 2 && i.strName === name);
  }

  /** CUser::GetInventoryLoaded — equipped (SlotByte != 0xFF) of a category. */
  GetInventoryLoaded(n: number): UserInventory | null {
    return this.m_vtInventory.find((i) => i.Type === n && i.SlotByte !== 0xff) ?? null;
  }

  /** CUser::GetSlotDecorationLoaded (category 10). */
  GetSlotDecorationLoaded(i: number): UserInventory | null {
    return this.m_vtInventory.find((x) => x.Type === 10 && x.Slot === i && x.SlotByte !== 0xff) ?? null;
  }

  /** CUser::GetCharDecoLoaded (category 12). */
  GetCharDecoLoaded(i: number): UserInventory | null {
    return this.m_vtInventory.find((x) => x.Type === 12 && x.Slot === i && x.SlotByte !== 0xff) ?? null;
  }

  /** CUser::AppendSimpleInfoPacket — the shared rank/guild/list entry. */
  AppendSimpleInfoPacket(packet: CSendPacket): void {
    packet.EncodeStr(this.strName);
    packet.Encode1(this.account.Gender);
    packet.Encode4(this.GetLookLevel());
    if (this.m_nPremiumSvrId !== 0) packet.Encode4(this.m_nPremiumSvrIdx);
    else packet.Encode4(0);
    packet.Encode4(this.m_nGuildSN);
    if (CMainSystem.ms_pInstance!.m_nChannelType === 77) {
      const guild = CGuildTable.ms_pInstance?.FindGuildFromSerialNo(this.m_nGuildSN);
      if (guild) {
        packet.Encode2(guild.m_nMarkRevision);
        return;
      }
    }
    packet.Encode2(0);
  }

  /** CUser::MakeUserInventoryPacket — packet 201 per-user body. */
  MakeUserInventoryPacket(packet: CSendPacket): void {
    packet.Encode2(this.m_vtInventory.length);
    for (const inv of this.m_vtInventory) {
      packet.Encode4(inv.ItemSN);
      packet.Encode1(inv.SlotByte);
      packet.Encode4(inv.Amount);
      packet.EncodeStr(inv.Verbose);
      // CTime::GetVariantTime — an 8-byte OLE date
      packet.EncodeBuffer(new Uint8Array(new Float64Array([GetVariantTime(inv.DateCreated)]).buffer));
    }
  }

  /** CUser::MakePreInventoryPacket — packet 207 per-user body. */
  MakePreInventoryPacket(packet: CSendPacket): void {
    packet.Encode1(this.m_nPreInventoryCount);
    for (const pre of this.m_apPreInventory) {
      if (!pre) continue;
      const item = CUserItemMan.ms_pInstance?.GetUserItem(pre.ItemSn);
      if (!item) continue;
      packet.Encode1(item.Type);
      packet.Encode4(pre.ItemSn);
      packet.Encode2(Math.min(pre.Amount, 0xffff));
      packet.Encode2(item.Type === 101 ? this.m_nLevel & 0xffff : 0);
      packet.Encode2(Math.min(pre.ValidityPeriod, 100000) & 0xffff);
      packet.EncodeStr(pre.Description);
      packet.EncodeStr(pre.strAttr);
    }
  }

  /** CUser::MakeInventoryPacket — the E2 ItemSNs of a category. */
  MakeInventoryPacket(packet: CSendPacket, n: number): void {
    const list = this.m_vtInventory.filter((i) => i.Type === n);
    packet.Encode2(list.length);
    for (const inv of list) packet.Encode2(inv.ItemSN);
  }
}

// ============================ CClientSocket ============================

/** CClientSocket — one connected game client (FxServer.exe.c:9818). */
export class CClientSocket extends CPacketSocket {
  static ms_nHeaderTypeCounter = 0; // dword_4AF338
  static ms_tblSN2Obj = new Map<number, CClientSocket>();

  m_nLocalSerialNo = 0; // CSerialObject SN
  m_nPoolType = 0; // +468 stage tag (0 connect, 3 channels, 1 lobby, 2 room, 4 playing, 6 practice)
  m_nSessionIdx = -1; // +500 (u16)
  m_nSessionSerialNo = 0; // +504 (CUser::SetSessionSerialNo)
  m_fImpPoint = 0; // +472 (CClientSocket::SetImpPoint — modified client)
  m_dwLastRTT = 0; // the socket's last RTT reply time
  m_apUser: (CUser | null)[] = []; // +460
  m_nUserCount = 0; // +456
  m_anBeforeJoinSession: number[] = []; // +476..+496 (5-deep ring)
  m_dwIdleTime = Date.now() - 5000;

  constructor() {
    super(CPacketSocket.dwRcvBufferSize, CPacketSocket.dwSndBufferSize, {
      onPacket: (_sock, packet) => CMainSystem.ms_pInstance?.DispatchClient(packet, this),
    });
    this.m_nLocalSerialNo = CClientSocket.ms_tblSN2Obj.size + 1;
    const nHeaderType = CClientSocket.ms_nHeaderTypeCounter % 16;
    CClientSocket.ms_nHeaderTypeCounter++;
    this.SetHeaderType(nHeaderType);
    this.SetHeaderCode(CLIENTSOCKET_HEADER_CODE_RCV, CLIENTSOCKET_HEADER_CODE_SND, CLIENTSOCKET_HEADER_CODE_MODIFIER);
    this.SetSequence(CLIENTSOCKET_SEQ_DELTA, CLIENTSOCKET_SEQ_DELTA, CLIENTSOCKET_SEQ, CLIENTSOCKET_SEQ);
    CClientSocket.ms_tblSN2Obj.set(this.m_nLocalSerialNo, this);
  }

  /** CClientSocket::GetSocketFromLocalSerialNo */
  static GetSocketFromLocalSerialNo(n: number): CClientSocket | null {
    return CClientSocket.ms_tblSN2Obj.get(n) ?? null;
  }

  /** CClientSocket::AddNewUsers */
  AddNewUsers(n: number): void {
    this.m_apUser = [];
    for (let i = 0; i < n; i++) this.m_apUser.push(new CUser(this));
    this.m_nUserCount = n;
  }

  /** CClientSocket::SetUser / GetUser / GetUserCount */
  SetUser(a2: number, user: CUser): void {
    this.m_apUser[a2] = user;
  }

  GetUser(a2: number): CUser | null {
    return this.m_apUser[a2] ?? null;
  }

  GetUserCount(): number {
    return this.m_nUserCount;
  }

  /** CClientSocket::GetMaxLevelUser */
  GetMaxLevelUser(): CUser | null {
    let best: CUser | null = null;
    for (const u of this.m_apUser) {
      if (u && (!best || u.m_nLevel > best.m_nLevel)) best = u;
    }
    return best;
  }

  /** CClientSocket::CheckInBeforeJoinSession */
  CheckInBeforeJoinSession(a2: number): boolean {
    return this.m_anBeforeJoinSession.includes(a2);
  }

  /** CClientSocket::AddBeforeJoinSession */
  AddBeforeJoinSession(a2: number): void {
    if (this.CheckInBeforeJoinSession(a2)) return;
    if (this.m_anBeforeJoinSession.length >= 5) this.m_anBeforeJoinSession.shift();
    this.m_anBeforeJoinSession.push(a2);
  }

  /** CClientSocket::GetSelfidxFromSerialNo */
  GetSelfidxFromSerialNo(n: number): number {
    return this.m_apUser.findIndex((u) => u && u.m_nGlobalSerialNo === n);
  }

  /** CClientSocket::HasAuthority — always 0 without the operator link. */
  static HasAuthority(_a1: number): number {
    return 0;
  }

  PostClosePacket(): void {
    this.Close();
  }

  /** CClientSocket::SafeFree — session teardown, pool removal, user frees. */
  Close(): void {
    if (!this.m_bConnected) return;
    this.m_bConnected = false;
    const db = CCenterProcess.ms_pInstance?.db ?? null;
    // CGameSessionTable::DestroyPlayer when seated
    CGameSessionTable.ms_pInstance?.DestroyPlayer(this, 0);
    // pool removal (connect pool before entry, channel pool afterwards)
    const pool = this.m_nPoolType === 0 ? CConnectPool.ms_pInstance : CChannelPool.ms_pInstance;
    pool?.DeleteSocket(this);
    // per-user cleanup: table removal, dyn/inventory flush, center p1
    for (const user of this.m_apUser) {
      if (!user) continue;
      CLocalUserTable.ms_pInstance?.Remove(user);
      user.DeferFlushModifiedInfo(db!, 1);
      if ((CMainSystem.ms_pInstance!.m_fInventoryDB & 1) !== 0) {
        for (const inv of user.m_vtInventory) {
          if (inv.fModified === 0) continue;
          inv.fModified = 0;
          db!.prUpdateInventoryAmount(user.dyn.strID, inv.ItemSN, inv.Amount);
        }
      }
      if (user.m_nGlobalSerialNo !== 0) CCenterProcess.ms_pInstance?.UnregisterConnection(user.m_nGlobalSerialNo);
      user.m_pSocket = null;
    }
    this.m_apUser = [];
    this.m_nUserCount = 0;
    CClientSocket.ms_tblSN2Obj.delete(this.m_nLocalSerialNo);
    super.Close();
  }
}

// ============================ CLocalUserTable ============================

/** CLocalUserTable — name (lowercased) and global-serial indexes. */
export class CLocalUserTable {
  static ms_pInstance: CLocalUserTable | null = null;

  private byName = new Map<string, CUser>();
  private bySN = new Map<number, CUser>();

  constructor() {
    CLocalUserTable.ms_pInstance = this;
  }

  /** CLocalUserTable::Insert — 1 on success (name keys are MakeLower'd). */
  Insert(user: CUser): number {
    const key = user.GetName().toLowerCase();
    if (this.byName.has(key)) return 0;
    if (this.bySN.has(user.m_nGlobalSerialNo)) return 0;
    this.byName.set(key, user);
    this.bySN.set(user.m_nGlobalSerialNo, user);
    return 1;
  }

  /** CLocalUserTable::Remove */
  Remove(user: CUser): void {
    const key = user.GetName().toLowerCase();
    if (this.byName.get(key) === user) this.byName.delete(key);
    if (this.bySN.get(user.m_nGlobalSerialNo) === user) this.bySN.delete(user.m_nGlobalSerialNo);
  }

  /** CLocalUserTable::FindUserFromId */
  FindUserFromId(name: string): CUser | null {
    return this.byName.get(name.toLowerCase()) ?? null;
  }

  /** CLocalUserTable::FindUserFromGlobalSerialNo */
  FindUserFromGlobalSerialNo(sn: number): CUser | null {
    return this.bySN.get(sn >>> 0) ?? null;
  }
}

// ============================ CGuild / CGuildTable ============================

/** CGuild — FxGuildAccount as seen by the game server. */
export class CGuild {
  m_nGuildSN = 0;
  strName = "";
  strMasterID = "";
  m_nMarkRevision = 0;
}

/** CGuildTable — lazily-loaded guilds. */
export class CGuildTable {
  static ms_pInstance: CGuildTable | null = null;

  private m_vtGuild = new Map<number, CGuild>();

  constructor(private db: CDBMan) {
    CGuildTable.ms_pInstance = this;
  }

  /** CGuildTable::Insert — prGetGuildSimpleInfo2; 0 when the row is absent. */
  Insert(value: number): number {
    if (this.m_vtGuild.has(value)) return 1;
    const r = this.db.prGetGuildSimpleInfo2(value);
    if (r.retval !== 0) {
      console.error("[GS] Fatal error: InitGuild failed from DB");
      return 0;
    }
    const g = new CGuild();
    g.m_nGuildSN = value;
    g.strName = r.Name;
    g.strMasterID = r.MasterID;
    g.m_nMarkRevision = r.MarkRevision;
    this.m_vtGuild.set(value, g);
    return 1;
  }

  /** CGuildTable::Remove */
  Remove(value: number): void {
    this.m_vtGuild.delete(value);
  }

  /** CGuildTable::FindGuildFromSerialNo */
  FindGuildFromSerialNo(value: number): CGuild | null {
    return this.m_vtGuild.get(value) ?? null;
  }
}

// ============================ CUserPool (base) ============================

/** CUserPool — the socket/user set shared by the connect and channel pools. */
export class CUserPool {
  m_setSocket = new Set<CClientSocket>();
  m_setUser = new Set<CUser>();

  /** CUserPool::AddSocket */
  AddSocket(socket: CClientSocket): void {
    this.m_setSocket.add(socket);
  }

  /** CUserPool::DelSocket */
  DelSocket(socket: CClientSocket): void {
    this.m_setSocket.delete(socket);
  }

  /** CUserPool::AddNewSocket — seat the users, then OnAddNewSocket. */
  AddNewSocket(socket: CClientSocket): number {
    for (const user of socket.m_apUser) {
      if (user) this.m_setUser.add(user);
    }
    this.AddSocket(socket);
    this.OnAddNewSocket(socket);
    return 1;
  }

  /** CUserPool::DeleteSocket — 0 when a user was not resident. */
  DeleteSocket(socket: CClientSocket): number {
    for (const user of socket.m_apUser) {
      if (user && !this.m_setUser.has(user)) return 0;
    }
    for (const user of socket.m_apUser) {
      if (user) this.m_setUser.delete(user);
    }
    this.OnDeleteSocket(socket);
    this.DelSocket(socket);
    return 1;
  }

  /** CUserPool::OnAddNewSocket — a no-op in the base. */
  OnAddNewSocket(_socket: CClientSocket): void {}

  /** CUserPool::OnDeleteSocket — a no-op in the base. */
  OnDeleteSocket(_socket: CClientSocket): void {}

  /** CUserPool::OnPacket — the 20 RTT fallback with the GS anti-cheat checks. */
  OnPacket(n: CReceivedPacket, socket: CClientSocket): void {
    if (n.Decode1() !== GS_ReceivedPacket.OnEstimateRTT) return;
    const packet = new CSendPacket(GS_ClientSend.OnEstimateRTTRes);
    const v3 = n.Decode4();
    const hash = n.Decode4();
    const now = Date.now() & 0x7fffffff;
    packet.Encode4(v3);
    packet.Encode4(now);
    const last = socket.m_dwLastRTT;
    socket.m_dwLastRTT = now;
    socket.SendPacket(packet);
    if (last !== 0 && now - last < RTT_MIN_INTERVAL) {
      const name = socket.GetUser(0)?.GetName() ?? "NULL";
      console.error(`[GS] Hacking Suspected [${name}] : SpeedHack. Disconnect.`);
      socket.PostClosePacket();
      return;
    }
    if (hash !== RTT_HASH && hash !== RTT_HASH_INV) {
      const name = socket.GetUser(0)?.GetName() ?? "NULL";
      console.error(`[GS] Hacking Suspected [${name}] : Memory Modification. Disconnect. Received Hash Value : [${hash.toString(16)}]`);
      socket.PostClosePacket();
    }
  }

  /** CUserPool::OnTimer → DisconnectTimeoutSocket (0x9C40 ms without RTT). */
  DisconnectTimeoutSocket(): void {
    const now = Date.now();
    for (const socket of [...this.m_setSocket]) {
      if (now - socket.m_dwIdleTime > SOCKET_TIMEOUT) {
        console.error(`[GS] Disconnect timeout socket [${socket.GetUser(0)?.GetName() ?? "NULL"}]`);
        socket.PostClosePacket();
      }
    }
  }
}

// ============================ CConnectPool ============================

/** CConnectPool — sockets between TCP accept and the channel move. */
export class CConnectPool extends CUserPool {
  static ms_pInstance: CConnectPool | null = null;

  constructor(public db: CDBMan) {
    super();
    CConnectPool.ms_pInstance = this;
  }

  /** CConnectPool::OnPacket — 7 ConnEstablished, else the RTT fallback. */
  OnPacket(n: CReceivedPacket, socket: CClientSocket): void {
    if (n.Decode1() === GS_ReceivedPacket.OnConnEstablished) this.OnConnEstablished(n, socket);
    else {
      n.m_uOffset = 0;
      this.OnPacketFallback(n, socket);
    }
  }

  /** the CUserPool::OnPacket tail of CConnectPool::OnPacket */
  private OnPacketFallback(n: CReceivedPacket, socket: CClientSocket): void {
    super.OnPacket(n, socket);
  }

  /**
   * CConnectPool::OnConnEstablished — packet 7:
   * [E1 n=1|2][n×(EStr name, E4 gSN, E4 guildSN)][E4 x][E4 y][E1 z];
   * x^y must be one of the two client hashes or the client is flagged.
   */
  OnConnEstablished(n: CReceivedPacket, socket: CClientSocket): void {
    const count = n.Decode1();
    if (count !== 1 && count !== 2) {
      console.error("[GS] Connect Established UserNo Invalid");
      socket.PostClosePacket();
      return;
    }
    socket.AddNewUsers(count);
    this.AddNewSocket(socket);
    let i = 0;
    for (; i < count; i++) {
      const user = socket.GetUser(i)!;
      const name = n.DecodeStr();
      const gSN = n.Decode4();
      const guildSN = n.Decode4();
      user.SetName(name);
      user.SetGlobalSerialNo(gSN);
      user.SetGuildSerialNo(guildSN);
      if (CLocalUserTable.ms_pInstance!.Insert(user) === 0) break;
    }
    if (i < count) {
      console.error(`[GS] Cannot insert user to local user table, ${i} th user`);
      for (let j = 0; j < i; j++) CLocalUserTable.ms_pInstance!.Remove(socket.GetUser(j)!);
      socket.PostClosePacket();
      return;
    }
    const x = n.Decode4();
    const y = n.Decode4();
    const hash = (x ^ y) >>> 0;
    if (hash !== FxCLIENT_HASH_A && hash !== FxCLIENT_HASH_B) {
      console.error(`[GS] Red Alert: Modified FxClient (${socket.GetUser(0)!.GetName()}: 0x${hash.toString(16).padStart(8, "0")})!`);
      socket.m_fImpPoint = 1;
    }
    socket.GetUser(0)!.m_fModifiedClient = n.Decode1() === 0 ? 1 : 0;

    // → center p3 OnConnEstablished [E1 n][n×(EStr, E4 gSN)]
    const p = new CSendPacket(MC_ReceivedPacket.OnConnEstablished);
    p.Encode1(count);
    for (let j = 0; j < count; j++) {
      const u = socket.GetUser(j)!;
      p.EncodeStr(u.GetName());
      p.Encode4(u.GetGlobalSerialNo());
    }
    CCenterProcess.ms_pInstance?.SendPacket(p);
  }

  /**
   * CConnectPool::OnCenterResConnEstablished — center packet 2:
   * [E1 n][n×(E4 gSN, E1 authencode)][E1 flag].  On success the users get
   * their DB rows, 210/202(/207)/201 go out and the socket joins the lobby.
   */
  OnCenterResConnEstablished(n: CReceivedPacket): void {
    const count = n.Decode1();
    const serials: number[] = [];
    for (let i = 0; i < count; i++) serials.push(n.Decode4());
    const flags: number[] = [];
    for (let i = 0; i < count; i++) flags.push(n.Decode1());
    const flag = n.Decode1();

    // resolve the users (they must still be in this pool)
    const users: (CUser | null)[] = [];
    let ok = true;
    for (let i = 0; i < count; i++) {
      const u = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(serials[i]);
      users.push(u);
      if (!u || !this.m_setUser.has(u)) {
        ok = false;
        break;
      }
    }
    if (ok && flag === 0) ok = false;

    if (ok) {
      for (let i = 0; i < count; i++) {
        const u = users[i]!;
        const info = this.db.prGetUserInfo(u.GetName());
        if (info.retval !== 0) {
          ok = false;
          break;
        }
        u.account.SN = info.SN;
        u.account.strID = u.GetName();
        u.account.strName = info.Name;
        u.account.Password = info.Password;
        u.account.Email = info.Email;
        u.account.EmailRcv = info.EmailRcv;
        u.account.Gender = info.Gender;
        u.account.Address = info.Address;
        u.account.Tel = info.Tel;
        u.account.Reveal = info.Reveal;
        u.account.Profile = info.Profile;
        u.account.TotalConn = info.TotalConn;
        u.account.Permission = info.Permission;
        u.account.ShopCardNo = info.ShopCardNo;
        u.account.CommunitySvr = info.CommunitySvr;
        u.account.Birthday = info.Birthday;
        u.account.GuildSn = info.GuildSn;
        u.dyn.strID = u.GetName();
        u.dyn.money = info.money;
        u.dyn.exp = info.exp;
        u.dyn.win = info.win;
        u.dyn.draw = info.draw;
        u.dyn.lose = info.lose;
        u.SetLevel();
        u.m_nPremiumSvrId = flags[i];
        if ((CMainSystem.ms_pInstance!.m_fInventoryDB & 1) !== 0 && !this.InitUserInventory(u)) {
          console.error("[GS] Fatal error: InitUserInventory failed from DB");
          ok = false;
          break;
        }
        if (u.GetGuildSerialNo() > 0) {
          const inserted = CGuildTable.ms_pInstance!.Insert(u.GetGuildSerialNo());
          if (inserted === 0 && CMainSystem.ms_pInstance!.m_nChannelType === 77) {
            const p = new CSendPacket(GS_ClientSend.OnGuildBanRes);
            users[0]!.m_pSocket?.SendPacket(p);
            for (const u2 of users) if (u2) u2.m_pSocket?.PostClosePacket();
            return;
          }
        }
      }
    }
    if (!ok) {
      const u = users[0];
      if (u) {
        console.error(`[GS] Connection failed from center server(${u.GetName()}:0x${u.m_nGlobalSerialNo.toString(16)})`);
        u.m_pSocket?.PostClosePacket();
      }
      return;
    }

    // → client 210 [E1 attr]; move the socket into the channel pool.
    const p210 = new CSendPacket(GS_ClientSend.OnEnterGame);
    p210.Encode1(CMainSystem.ms_pInstance!.m_fInventoryDB);
    const socket = users[0]!.m_pSocket!;
    socket.SendPacket(p210);
    if (this.DeleteSocket(socket) !== 0 && CChannelPool.ms_pInstance!.AddNewSocket(socket) !== 0) {
      let sent = false;
      if (users[0]!.m_nFlushCount === 0) {
        const p202 = new CSendPacket(GS_ClientSend.OnUserItemList);
        CUserItemMan.ms_pInstance!.PutUserItemList(p202);
        socket.SendPacket(p202);
        sent = true;
      }
      if (users.some((u) => u && u.m_nPreInventoryCount > 0)) {
        const p207 = new CSendPacket(GS_ClientSend.OnPreInventory);
        p207.Encode1(count);
        for (const u of users) u!.MakePreInventoryPacket(p207);
        socket.SendPacket(p207);
        sent = true;
      }
      if (sent) {
        const p201 = new CSendPacket(GS_ClientSend.OnUserInventory);
        p201.Encode1(count);
        for (const u of users) u!.MakeUserInventoryPacket(p201);
        socket.SendPacket(p201);
      }
      // CConnectPool::OnCenterResConnEstablished tail (0x408A57): the entry
      // leaves the socket at the lobby stage (+468 = 1)
      socket.m_nPoolType = 1;
      CGameSessionTable.ms_pInstance!.PutAllSessionInfo(socket);
    } else {
      console.error("[GS] Failed in transferring user to channel pool, close connection");
      socket.PostClosePacket();
    }
  }

  /** CDBMan::InitUserInventory — pre-inventory claims + the live rows. */
  private InitUserInventory(user: CUser): boolean {
    if (!this.InitPreInventory(user)) return false;
    const id = user.GetName();
    const rows = this.db.GetUserInventoryRows(id);
    const now = Date.now();
    for (const row of rows) {
      const item = CUserItemMan.ms_pInstance!.GetUserItem(row.ItemSN);
      if (!item) {
        console.error("[GS] Mismatch: Shop Item Data");
        return false;
      }
      const expired =
        user.m_nLevel >= row.LevelCreated || !row.DateCreated || Number.isNaN(Date.parse(row.DateCreated)) || Date.parse(row.DateCreated) < now;
      if (expired) {
        this.db.prDeleteInventory(id, row.ItemSN);
        continue;
      }
      const inv = new UserInventory();
      inv.ItemSN = row.ItemSN;
      inv.StockSn = row.StockSN;
      inv.Type = item.Type;
      inv.strName = item.strName;
      inv.strAttr = item.strAttr;
      inv.nAttr1 = item.nAttr1;
      inv.nAttr2 = item.nAttr2;
      inv.nAttr3 = item.nAttr3;
      inv.SlotByte = row.Slot;
      inv.Amount = row.Amount;
      inv.Verbose = row.Verbose;
      inv.DateCreated = row.DateCreated ? new Date(row.DateCreated) : null;
      inv.LevelCreated = row.LevelCreated;
      user.AddInventory(inv);
      if (item.Type === 5 && inv.SlotByte !== 0xff) {
        user.m_fPremiumTicket = 1;
        user.m_nPremiumSvrIdx = row.ItemSN;
      }
      if (item.Type === 6 && inv.SlotByte !== 0xff) user.m_nPremiumSvrId = inv.nAttr1;
    }
    return true;
  }

  /** CDBMan::InitPreInventory — the 30 pre-inventory slots. */
  private InitPreInventory(user: CUser): boolean {
    const rows = this.db.GetPreInventoryRows(user.GetName());
    let n = 0;
    for (const row of rows) {
      if (n >= 30) break;
      const item = CUserItemMan.ms_pInstance!.GetUserItem(row.ItemSN);
      if (!item) continue;
      let truncate = 0;
      if (item.Type === 9) {
        this.db.prSetPremiumTicket(user.GetName(), row.ValidityPeriod);
        if (user.m_fPremiumTicket !== 1) {
          CCenterProcess.ms_pInstance?.SendAuthenCode(user.GetGlobalSerialNo(), 1);
        }
        truncate = 1;
      }
      if (item.Type === 101) {
        user.IncDecExp(row.Amount);
        user.SetLevel();
        truncate = 1;
      }
      if (item.Type === 100) {
        user.IncDecMoney(row.Amount);
        truncate = 1;
      }
      if (item.Type === 100 || item.Type === 101) user.DeferFlushModifiedInfo(this.db, 1);
      if (
        this.db.prLoadInventory(row.SN, user.GetName(), row.ItemSN, row.StockSN, row.Slot, row.Amount, row.ValidityPeriod, user.m_nLevel, truncate) !== 0
      ) {
        continue;
      }
      const pre = new PreInventory();
      pre.SN = row.SN;
      pre.Type = row.Type;
      pre.ItemSn = row.ItemSN;
      pre.StockSn = row.StockSN;
      pre.Slot = row.Slot;
      pre.Amount = row.Amount;
      pre.strAttr = row.strAttr;
      pre.ValidityPeriod = row.ValidityPeriod;
      pre.ValidityLevel = row.ValidityLevel;
      pre.Description = row.Description;
      user.m_apPreInventory[user.m_nPreInventoryCount] = pre;
      user.m_nPreInventoryCount++;
      n++;
    }
    return true;
  }
}

// ============================ CGameSession ============================

/** CGameSession — one room (lobby-stage fidelity; the in-play stage is the
 *  next unit).  Fields are named after the original's accessors. */
export class CGameSession {
  m_nIdx = 0; // +144 (GetIdx)
  m_nSerialNo = 0; // +148 (GetSerialNo — rand() at create)
  fValid = 0; // +140
  m_nGameType = 0; // +844 (game type byte)
  m_nMapIdx = 0; // +852
  m_nCurPlayerNum = -1; // +850 (u16, -1 until the first join)
  m_nMaxPlayerNum = 8; // +833
  m_nTeamPlayerNum = 0; // +832 (cur players byte)
  m_fModified = 0; // +856 (MakeModifiedPacket flag bits)
  m_fPlaying = 0; // +852
  m_strPassword = ""; // +834
  m_nOwnerSocketSerial = 0;
  m_rgPlayer: (CUser | null)[] = new Array(8).fill(null);
  m_nPlayerCount = 0;

  /** CListSession::MakeSimpleInfoPacket (packet 83 body). */
  MakeSimpleInfoPacket(packet: CSendPacket): void {
    packet.Encode2(this.m_nIdx);
    packet.Encode4(this.m_nSerialNo);
    packet.EncodeStr(this.strTitle());
    packet.Encode1(this.m_nGameType);
    packet.Encode1(this.hasPassword() ? 1 : 0);
    packet.Encode1(this.m_fPlaying);
    packet.Encode2(this.m_nCurPlayerNum === -1 ? 0 : this.m_nCurPlayerNum);
    packet.Encode1(this.m_nTeamPlayerNum);
    packet.Encode1(this.m_nMaxPlayerNum);
  }

  strTitle(): string {
    return `Room ${this.m_nIdx + 1}`;
  }

  hasPassword(): boolean {
    return this.m_strPassword.length > 0;
  }

  /** CBaseSession::GetEmptySlotCount */
  GetEmptySlotCount(): number {
    return this.m_rgPlayer.filter((p) => p === null).length;
  }

  /** CBaseSession::GetEmptySlot — the first empty slot. */
  GetEmptySlot(): number {
    return this.m_rgPlayer.findIndex((p) => p === null);
  }

  /** CBaseSession::AddUser — the slot bookkeeping of a join. */
  AddUser(slot: number, user: CUser): void {
    if (this.m_rgPlayer[slot]) {
      console.error("[GS] m_rgPlayer[slotidx], CBaseSession::AddUser(int slotidx, CUser* pUser), not return");
      return;
    }
    this.m_rgPlayer[slot] = user;
    user.SetSessionIdx(this.m_nIdx);
    user.SetSessionSerialNo(this.m_nSerialNo);
    user.SetPoolType(2);
    this.m_nPlayerCount++;
    this.m_nTeamPlayerNum = this.m_nPlayerCount;
    this.m_nCurPlayerNum = this.m_nPlayerCount;
    this.m_fModified |= 4;
  }

  /** CListSession::DestroyPlayer — the leave path. */
  DestroyPlayer(socket: CClientSocket): void {
    let removed = false;
    for (const user of socket.m_apUser) {
      if (!user) continue;
      const slot = this.m_rgPlayer.indexOf(user);
      if (slot < 0) continue;
      this.m_rgPlayer[slot] = null;
      this.m_nPlayerCount--;
      this.m_nTeamPlayerNum = this.m_nPlayerCount;
      this.m_nCurPlayerNum = this.m_nPlayerCount;
      user.SetSessionIdx(-1);
      user.SetSessionSerialNo(0);
      this.m_fModified |= 4;
      removed = true;
    }
    if (removed && this.m_nPlayerCount <= 0) {
      this.fValid = 0;
      const p = new CSendPacket(GS_ClientSend.OnSessionDestroyed);
      p.Encode2(this.m_nIdx);
      p.Encode4(this.m_nSerialNo);
      CChannelPool.ms_pInstance?.SendAll(p, 1);
    }
  }
}

// ============================ CGameSessionTable ============================

/** CGameSessionTable — the 255 game-room slots (8 lock groups in the original). */
export class CGameSessionTable {
  static ms_pInstance: CGameSessionTable | null = null;

  m_apGameSession: (CGameSession | null)[] = new Array(255).fill(null);

  constructor() {
    CGameSessionTable.ms_pInstance = this;
  }

  /** CGameSessionTable::PutAllSessionInfo — packet 83 per valid room. */
  PutAllSessionInfo(socket: CClientSocket): void {
    const packet = new CSendPacket(GS_ClientSend.OnSessionSimpleInfo);
    for (const session of this.m_apGameSession) {
      if (!session || session.fValid === 0) continue;
      session.MakeSimpleInfoPacket(packet);
      socket.SendPacket(packet);
      packet.InitPacket(GS_ClientSend.OnSessionSimpleInfo);
    }
  }

  /** CBaseSessionTable::SendPacketIntoSession — to one session's members. */
  SendPacketIntoSession(idx: number, serial: number, packet: CSendPacket): void {
    const session = this.m_apGameSession[idx];
    if (!session || session.fValid === 0 || session.m_nSerialNo !== serial) return;
    for (const user of session.m_rgPlayer) {
      if (user && user.GetSessionSerialNo() === serial) user.m_pSocket?.SendPacket(packet);
    }
  }

  /** CGameSessionTable::OnPacket — the in-session dispatch (96..189). */
  OnPacket(n: CReceivedPacket, socket: CClientSocket): void {
    const idx = socket.m_nSessionIdx;
    if (idx >= 255) {
      if (socket.m_nPoolType !== 4 && n.m_pBlock[n.m_uOffset] !== 104) {
        if (idx === -1) console.log("[GS] Lobby player sent session packet (OnPacket). Don't Disconnect.");
        else if (idx === -2) console.error("[GS] Connecting player sent session packet (OnPacket). Don't Disconnect.");
        else console.error("[GS] Invalid game session slot index (OnPacket). Don't Disconnect.");
      }
      return;
    }
    const session = this.m_apGameSession[idx];
    if (!session || session.fValid === 0 || session.m_nSerialNo !== socket.m_nSessionSerialNo) {
      if (socket.m_nPoolType !== 4) {
        console.error(`[GS] Illegal game session (${idx}). Disconnect [${socket.GetUser(0)?.GetName() ?? "NULL"}].`);
        socket.PostClosePacket();
      }
      return;
    }
    n.m_uOffset = 0;
    // The room-stage dispatch (CListSession::OnPacket) is the next unit.
    void session;
  }

  /** CGameSessionTable::DestroyPlayer — vtbl+48, on socket close/leave. */
  DestroyPlayer(socket: CClientSocket, _a3: number): void {
    const idx = socket.m_nSessionIdx;
    if (idx >= 0 && idx < 255) {
      const session = this.m_apGameSession[idx];
      if (session && session.fValid !== 0 && session.m_nSerialNo === socket.m_nSessionSerialNo) {
        session.DestroyPlayer(socket);
      }
    }
  }

  /** CGameSessionTable::KickImp — "Fatal Revenge". */
  KickImp(socket: CClientSocket): number {
    if (socket.m_fImpPoint === 0) return 0;
    console.error(`[GS] Fatal Revenge: Kick imp's ass [${socket.GetUser(0)?.GetName() ?? "NULL"}] !`);
    const p = new CSendPacket(GS_ClientSend.OnKickoffUser);
    p.EncodeStr("abnormal state, disconnect user.");
    socket.SendPacket(p);
    socket.PostClosePacket();
    return 1;
  }

  /** CGameSessionTable::CreateSession — packet 80 body. */
  CreateSession(n: CReceivedPacket, socket: CClientSocket): void {
    const title = n.DecodeStr();
    const password = n.DecodeStr();
    const gameType = n.Decode1();
    const count = n.Decode1();
    const selects: number[] = [];
    for (let i = 0; i < count; i++) selects.push(n.Decode1());
    if (count !== socket.GetUserCount()) {
      console.error("[GS] CChannelPool::OnRequestCreateSession, player count not matched!");
      socket.PostClosePacket();
      return;
    }
    this.DoCreateSession(socket, title, password, selects, gameType);
  }

  /** CGameSessionTable::DoCreateSession — the create control flow. */
  DoCreateSession(socket: CClientSocket, _title: string, _password: string, _selects: number[], gameType: number): void {
    if (this.KickImp(socket) !== 0) return;
    const res = new CSendPacket(GS_ClientSend.OnCreateSessionRes);
    for (let i = 0; i < socket.GetUserCount(); i++) {
      const user = socket.GetUser(i);
      if (user && user.GetSessionIdx() !== -1 && user.GetSessionIdx() !== 0xffff) {
        console.error(`[GS] User joined a session already request for creating session. Disconnect[${user.GetName()}]`);
        socket.PostClosePacket();
        res.Encode1(3);
        socket.SendPacket(res);
        return;
      }
    }
    let nb = 0;
    while (nb < 255 && this.m_apGameSession[nb] && this.m_apGameSession[nb]!.fValid !== 0) nb++;
    if (nb >= 255) {
      res.Encode1(2);
      socket.SendPacket(res);
      return;
    }
    const session = new CGameSession();
    session.m_nIdx = nb;
    session.m_nSerialNo = Math.floor(Math.random() * 0x7fffffff);
    session.m_nGameType = gameType;
    session.fValid = 1;
    session.m_nOwnerSocketSerial = socket.m_nLocalSerialNo;
    this.m_apGameSession[nb] = session;
    res.Encode1(0);
    res.Encode2(nb);
    res.Encode4(session.m_nSerialNo);
    res.Encode1(gameType);
    socket.SendPacket(res);
    // seat the users (CBaseSession::AddAllUser → AddUser)
    for (const user of socket.m_apUser) {
      if (!user) continue;
      const slot = session.GetEmptySlot();
      if (slot < 0) break;
      session.AddUser(slot, user);
    }
    // the room-list broadcast (CListSession::MakeCreatedPacket)
    const created = new CSendPacket(GS_ClientSend.OnSessionCreated);
    created.Encode2(session.m_nIdx);
    created.Encode4(session.m_nSerialNo);
    created.EncodeStr(session.strTitle());
    created.Encode1(session.m_nGameType);
    created.Encode1(session.hasPassword() ? 1 : 0);
    created.Encode1(session.m_nTeamPlayerNum);
    created.Encode1(session.m_nMaxPlayerNum);
    CChannelPool.ms_pInstance?.SendAll(created, 1);
  }

  /** CGameSessionTable::JoinSession — packet 81 body. */
  JoinSession(n: CReceivedPacket, socket: CClientSocket): void {
    const idx = n.Decode2();
    const serial = n.Decode4();
    const password = n.DecodeStr();
    const count = n.Decode1();
    const selects: number[] = [];
    for (let i = 0; i < count; i++) selects.push(n.Decode1());
    if (count !== socket.GetUserCount()) {
      console.error("[GS] CChannelPool::OnRequestJoinSession, player count not matched!");
      socket.PostClosePacket();
      return;
    }
    this.DoJoinSession(socket, idx, serial, password, selects);
  }

  /** CGameSessionTable::DoJoinSession. */
  DoJoinSession(socket: CClientSocket, idx: number, serial: number, password: string, _selects: number[]): void {
    if (this.KickImp(socket) !== 0) return;
    const res = new CSendPacket(GS_ClientSend.OnJoinSessionRes);
    const session = idx < 255 ? this.m_apGameSession[idx] : null;
    const seated = socket.m_apUser.some((u) => u && u.GetSessionIdx() !== -1 && u.GetSessionIdx() !== 0xffff);
    if (session && session.fValid !== 0 && session.m_fPlaying === 0 && session.m_nSerialNo === serial && !seated) {
      if (session.hasPassword() && session.m_strPassword !== password) {
        res.Encode1(1);
        socket.SendPacket(res);
        return;
      }
      if (session.GetEmptySlotCount() >= socket.GetUserCount()) {
        res.Encode1(0);
        socket.SendPacket(res);
        // seat every user of the socket
        const joined: CUser[] = [];
        for (const user of socket.m_apUser) {
          if (!user) continue;
          const slot = session.GetEmptySlot();
          if (slot < 0) break;
          session.AddUser(slot, user);
          joined.push(user);
        }
        // SendSessionInfoPacket → the joiner sees everyone; the room sees them
        for (let slot = 0; slot < 8; slot++) {
          const user = session.m_rgPlayer[slot];
          if (!user) continue;
          this.MakeSetPlayerPacket(session, slot, socket, user.m_pSocket === socket);
        }
        const cur = new CSendPacket(GS_ClientSend.OnSessionCurPlayer);
        cur.Encode2(session.m_nCurPlayerNum);
        socket.SendPacket(cur);
        // SendJoinPacket — the newcomers' P105 to the existing members
        for (const member of session.m_rgPlayer) {
          if (!member || joined.includes(member)) continue;
          for (const nj of joined) {
            const slot = session.m_rgPlayer.indexOf(nj);
            this.MakeSetPlayerPacket(session, slot, member.m_pSocket!, false);
          }
        }
        session.m_fModified |= 0x10;
        this.BroadcastModified(session);
        return;
      }
    }
    res.Encode1(2);
    socket.SendPacket(res);
  }

  /** CBaseSession::MakeSetPlayerPacket — packet 105 to one receiver. */
  private MakeSetPlayerPacket(session: CGameSession, slot: number, receiver: CClientSocket, fSelf: number | boolean): void {
    const user = session.m_rgPlayer[slot];
    if (!user) return;
    const p = new CSendPacket(GS_ClientSend.OnSetPlayer);
    p.Encode1(slot);
    p.Encode4(user.GetGlobalSerialNo());
    p.Encode1(fSelf ? 1 : 0);
    p.Encode1(user.account.CommunitySvr);
    const deco = user.GetInventoryLoaded(4);
    p.Encode1(deco ? deco.SlotByte : 255);
    p.EncodeStr(user.strName);
    p.Encode1(user.account.Gender);
    p.Encode4(user.GetLookLevel());
    p.Encode4(user.m_nPremiumSvrId !== 0 ? user.m_nPremiumSvrIdx : 0);
    p.Encode4(user.m_nGuildSN);
    if (CMainSystem.ms_pInstance!.m_nChannelType === 77) {
      const guild = CGuildTable.ms_pInstance?.FindGuildFromSerialNo(user.m_nGuildSN);
      p.Encode2(guild ? guild.m_nMarkRevision : 0);
    } else {
      p.Encode2(0);
    }
    receiver.SendPacket(p);
  }

  /** CGameSessionTable::FlushModifiedTableInfo — the 86 broadcasts. */
  private BroadcastModified(session: CGameSession): void {
    if (session.m_fModified === 0) return;
    const p = new CSendPacket(GS_ClientSend.OnSessionModified);
    p.Encode2(session.m_nIdx);
    p.Encode4(session.m_nSerialNo);
    p.Encode1(session.m_fModified);
    if ((session.m_fModified & 1) !== 0) p.Encode1(session.m_fPlaying);
    if ((session.m_fModified & 2) !== 0) p.Encode2(session.m_nCurPlayerNum);
    if ((session.m_fModified & 4) !== 0) p.Encode1(session.m_nTeamPlayerNum);
    if ((session.m_fModified & 8) !== 0) p.Encode1(session.m_nMaxPlayerNum);
    if ((session.m_fModified & 0x10) !== 0) p.EncodeStr(session.strTitle());
    session.m_fModified = 0;
    CChannelPool.ms_pInstance?.SendAll(p, 1);
  }

  /** CGameSessionTable::JoinFreeSession — packet 82 body. */
  JoinFreeSession(n: CReceivedPacket, socket: CClientSocket): void {
    const count = n.Decode1();
    const selects: number[] = [];
    for (let i = 0; i < count; i++) selects.push(n.Decode1());
    if (count !== socket.GetUserCount()) {
      console.error("[GS] CCChannelPool::OnRequestAutoJoinSession, player count not matched!");
      socket.PostClosePacket();
      return;
    }
    // DoJoinFreeSession: the first open, non-playing room wins.
    for (const session of this.m_apGameSession) {
      if (!session || session.fValid === 0 || session.m_fPlaying !== 0) continue;
      if (session.GetEmptySlotCount() < socket.GetUserCount()) continue;
      this.DoJoinSession(socket, session.m_nIdx, session.m_nSerialNo, session.m_strPassword, selects);
      return;
    }
    const res = new CSendPacket(GS_ClientSend.OnJoinSessionRes);
    res.Encode1(2);
    socket.SendPacket(res);
  }
}

// ============================ CChatPool ============================

/** CChatPool — the chat handlers (CChannelPool's base). */
export class CChatPool extends CUserPool {
  /** CChatPool::SendAll — a3 selects the lobby-stage sockets only. */
  SendAll(packet: CSendPacket, a3: number): void {
    for (const socket of [...this.m_setSocket]) {
      if (!socket.m_bConnected) {
        console.error(`[GS] CChatPool::FlushAll:: Not connected socket. Post Close Packet.`);
        socket.PostClosePacket();
        this.m_setSocket.delete(socket);
        continue;
      }
      if (a3 !== 0 && socket.m_nPoolType !== 1) continue;
      socket.SendPacket(packet);
    }
  }

  /** CChatPool::OnPacket — 25/26/27/28/30/31/71/74/216, then the RTT tail. */
  OnPacket(n: CReceivedPacket, socket: CClientSocket): void {
    const id = n.Decode1();
    switch (id) {
      case 25:
        this.OnChatMsg(n, socket);
        break;
      case 26:
        this.OnSpecialCommand(n, socket);
        break;
      case 27:
        this.OnWhisper(n, socket);
        break;
      case 28:
        this.OnItemMsg(n, socket);
        break;
      case 30:
        this.OnSystemMsg(n, socket);
        break;
      case 31:
        this.OnAdminNotifyMsg(n, socket);
        break;
      case 71:
        this.OnSystemCmd(n, socket);
        break;
      case 74:
        this.OnShoutMsg(n, socket);
        break;
      case 216:
        this.OnKickoffUser(n, socket);
        break;
      default:
        break;
    }
    n.m_uOffset = 0;
    super.OnPacket(n, socket);
  }

  /** CChatPool::OnChatMsg — packet 25 [EStr msg]; '/' = a special command. */
  OnChatMsg(n: CReceivedPacket, socket: CClientSocket): void {
    const msg = n.DecodeStr();
    if (msg.startsWith("/")) {
      this.OnSpecialCommand(n, socket);
      return;
    }
    if (msg.length === 0) {
      const p = new CSendPacket(GS_ClientSend.OnSystemMsg);
      p.EncodeStr(" ");
      socket.SendPacket(p);
      return;
    }
    const senders = socket.m_apUser.filter((u): u is CUser => u !== null).map((u) => u.GetName());
    if (senders.join(", ").length + msg.length + 3 > 0x400) {
      console.error("[GS] User send too long chat msg. Disconnect connection");
      socket.PostClosePacket();
      return;
    }
    const text = `${senders.join(", ")} : ${msg}`;
    const p = new CSendPacket(GS_ClientSend.OnChatMsg);
    if (socket.GetUser(0)!.GetSessionIdx() === -1 || socket.GetUser(0)!.GetSessionIdx() === 0xffff) p.EncodeStr("//");
    p.EncodeStr(text);
    const idx = socket.GetUser(0)!.GetSessionIdx();
    if (idx === -1 || idx === 0xffff) this.SendAll(p, 1);
    else CGameSessionTable.ms_pInstance!.SendPacketIntoSession(idx, socket.GetUser(0)!.GetSessionSerialNo(), p);
  }

  /** CChatPool::OnSpecialCommand — a stub in the original (`retn 8`). */
  OnSpecialCommand(_n: CReceivedPacket, _socket: CClientSocket): void {}

  /** CChatPool::OnWhisper — packet 27/28 [EStr to][EStr msg]. */
  OnWhisper(n: CReceivedPacket, socket: CClientSocket): void {
    const to = n.DecodeStr();
    const msg = n.DecodeStr();
    const target = CLocalUserTable.ms_pInstance!.FindUserFromId(to);
    if (!target) {
      const p = new CSendPacket(GS_ClientSend.OnWhisperFail);
      p.Encode1(0);
      p.EncodeStr(to);
      socket.SendPacket(p);
      return;
    }
    const senders = socket.m_apUser.filter((u): u is CUser => u !== null).map((u) => u.GetName());
    if (senders.join(", ").length + msg.length + 2 > 0x400) {
      console.error("[GS] User send too long chat msg. Disconnect connection");
      socket.PostClosePacket();
      return;
    }
    const p = new CSendPacket(GS_ClientSend.OnWhisperRes);
    p.EncodeStr(`${senders.join(", ")} : ${msg}`);
    target.m_pSocket?.SendPacket(p);
  }

  /** CChatPool::OnItemMsg — packet 28 [E1 bomber][EStr msg] (in-session). */
  OnItemMsg(n: CReceivedPacket, socket: CClientSocket): void {
    const bomber = n.Decode1();
    const msg = n.DecodeStr();
    const user = socket.GetUser(bomber);
    if (bomber >= socket.GetUserCount() || !user) {
      console.error("[GS] Invalid item msg: from invalid bomber");
      return;
    }
    if (msg.length + user.GetName().length + 10 > 0x400) {
      console.error("[GS] Too long item msg. Disconnect connection");
      socket.PostClosePacket();
      return;
    }
    const p = new CSendPacket(GS_ClientSend.OnItemMsg);
    p.EncodeStr(`${user.GetName()} : ${msg}`);
    const idx = socket.GetUser(0)!.GetSessionIdx();
    if (idx === -1 || idx === 0xffff) {
      console.error("[GS] Invalid item msg: tried to send to all in the session");
      return;
    }
    CGameSessionTable.ms_pInstance!.SendPacketIntoSession(idx, socket.GetUser(0)!.GetSessionSerialNo(), p);
  }

  /** CChatPool::OnSystemMsg — packet 30 to the session or the lobby. */
  OnSystemMsg(n: CReceivedPacket, socket: CClientSocket): void {
    const msg = n.DecodeStr();
    const p = new CSendPacket(GS_ClientSend.OnSystemMsg);
    p.EncodeStr(msg);
    const idx = socket.GetUser(0)?.GetSessionIdx() ?? -1;
    if (idx === -1 || idx === 0xffff) this.SendAll(p, 1);
    else CGameSessionTable.ms_pInstance!.SendPacketIntoSession(idx, socket.GetUser(0)!.GetSessionSerialNo(), p);
  }

  /** CChatPool::OnAdminNotifyMsg — packet 31 from an operator client. */
  OnAdminNotifyMsg(n: CReceivedPacket, socket: CClientSocket): void {
    if (socket.GetUserCount() === 1 && (socket.GetUser(0)!.GetSessionIdx() === -1 || socket.GetUser(0)!.GetSessionIdx() === 0xffff)) {
      this.SendAdminMsg(n.DecodeStr());
    }
  }

  /** CChatPool::OnSystemCmd — packet 71 from an operator client. */
  OnSystemCmd(n: CReceivedPacket, socket: CClientSocket): void {
    if (socket.GetUserCount() === 1 && (socket.GetUser(0)!.GetSessionIdx() === -1 || socket.GetUser(0)!.GetSessionIdx() === 0xffff)) {
      this.SendSystemCmd(n.DecodeStr());
    }
  }

  /** CChatPool::SendAdminMsg — to the center (MC 4). */
  SendAdminMsg(msg: string): void {
    const p = new CSendPacket(MC_ReceivedPacket.OnAdminNotifyMsg);
    p.EncodeStr(msg);
    CCenterProcess.ms_pInstance?.SendPacket(p);
  }

  /** CChatPool::SendSystemCmd — to the center (MC 11). */
  SendSystemCmd(msg: string): void {
    const p = new CSendPacket(MC_ReceivedPacket.OnSystemCmd);
    p.EncodeStr(msg);
    CCenterProcess.ms_pInstance?.SendPacket(p);
  }

  /** CChatPool::OnShoutMsg — packet 74; costs an Item/ItemSpeaker. */
  OnShoutMsg(n: CReceivedPacket, socket: CClientSocket): void {
    const idx = n.Decode1();
    let msg = n.DecodeStr();
    if (Buffer.byteLength(msg, "latin1") > 64) msg = msg.slice(0, 64);
    if (idx < 0 || idx >= socket.GetUserCount()) {
      console.error("[GS] KIN shout e sir~ self idx jal mot doit er yo!");
      return;
    }
    const user = socket.GetUser(idx)!;
    if (msg.length + user.GetName().length + 10 > 0x400) {
      console.error("[GS] User send too long chat msg. Disconnect connection");
      socket.PostClosePacket();
      return;
    }
    const speaker = user.GetUserInventoryFromAll("Item/ItemSpeaker");
    if (!speaker) {
      console.error("[GS] Tried to use nonresident Item..Disconnect user");
      socket.PostClosePacket();
      return;
    }
    speaker.Amount--;
    speaker.fModified = 1;
    if (speaker.Amount < 0) {
      speaker.Amount = 0;
      console.error("[GS] Tried to use nonresident Item..Disconnect user");
      socket.PostClosePacket();
      return;
    }
    const p = new CSendPacket(GS_ClientSend.OnShoutMsg);
    p.EncodeStr(`${user.GetName()} : ${msg}`);
    this.SendAll(p, 0);
  }

  /** CChatPool::OnKickoffUser — packet 216; authority-gated (always fails). */
  OnKickoffUser(n: CReceivedPacket, socket: CClientSocket): void {
    if (socket.GetUserCount() !== 1) return;
    n.DecodeStr(); // the target name
    if (CClientSocket.HasAuthority(7) === 0) return;
    // unreachable without the operator link
  }
}

// ============================ CChannelPool ============================

/** CChannelPool — the lobby (CChannelPool::OnPacket, FxServer.exe.c:6942). */
export class CChannelPool extends CChatPool {
  static ms_pInstance: CChannelPool | null = null;

  m_vtRankList: CUser[] = []; // +76 (the level-sorted lobby list)
  m_vtGuildMember = new Map<number, CUser[]>(); // +120

  constructor(public db: CDBMan) {
    super();
    CChannelPool.ms_pInstance = this;
    CMainSystem.ms_pInstance!.m_nPremiumSvrReward = db.GetPremiumSvrReward();
    CMainSystem.ms_pInstance!.m_nPremiumSvrLuckPro = db.GetPremiumSvrLuckPro();
  }

  /** CChannelPool::OnPacket — the lobby dispatch. */
  OnPacket(n: CReceivedPacket, socket: CClientSocket): void {
    const id = n.Decode1();
    switch (id) {
      case GS_ReceivedPacket.OnReqConnectToSvr:
        this.OnReqConnectToSvr(n, socket);
        return;
      case GS_ReceivedPacket.OnReqChannelsState:
        this.OnReqChannelsState(socket);
        return;
      case GS_ReceivedPacket.OnEnterChannelStage:
        this.OnEnterChannelStage(socket);
        return;
      case GS_ReceivedPacket.OnInviteUser:
        this.OnInviteUser(n, socket);
        return;
      case GS_ReceivedPacket.OnGuildMarkRevision:
        this.OnGuildMarkRevision(n);
        return;
      case GS_ReceivedPacket.OnEstimateRTT:
        n.m_uOffset = 0;
        super.OnPacket(n, socket);
        return;
      case GS_ReceivedPacket.OnRequestUserSimpleInfo:
        this.OnRequestUserSimpleInfo(n, socket);
        return;
      case GS_ReceivedPacket.OnRequestMyInfo:
        this.OnRequestMyInfo(n, socket);
        return;
      case GS_ReceivedPacket.OnRequestModifyUserInfo:
        this.OnRequestModifyUserInfo(n, socket);
        return;
      case GS_ReceivedPacket.OnRequestUserInfoDetail:
        this.OnRequestUserInfoDetail(n, socket);
        return;
      case GS_ReceivedPacket.OnRequestSessionInfoDetail:
        n.Decode2();
        n.Decode4();
        CGameSessionTable.ms_pInstance!.OnPacket(n, socket);
        return;
      case GS_ReceivedPacket.OnRequestUserLocation:
        this.OnRequestUserLocation(n, socket);
        return;
      case GS_ReceivedPacket.OnRequestGuildInfo:
        this.OnRequestGuildInfo(n, socket);
        return;
      case GS_ReceivedPacket.OnCreateSession:
        CGameSessionTable.ms_pInstance!.CreateSession(n, socket);
        return;
      case GS_ReceivedPacket.OnEnterSession:
        CGameSessionTable.ms_pInstance!.JoinSession(n, socket);
        return;
      case GS_ReceivedPacket.OnJoinFreeSession:
        CGameSessionTable.ms_pInstance!.JoinFreeSession(n, socket);
        return;
      case GS_ReceivedPacket.OnEnterLobbyStage:
        this.OnEnterLobbyStage(socket);
        return;
      case GS_ReceivedPacket.OnRequestGuildMemberInfo:
        this.OnRequestGuildMemberInfo(n, socket);
        return;
      case GS_ReceivedPacket.OnJoinSession:
        // vtbl+60 = CreateSessionPractice (packet 86) — the practice unit
        return;
      case GS_ReceivedPacket.OnRequestUserInventory:
        this.OnRequestUserItemList(socket);
        return;
      case GS_ReceivedPacket.Chat:
        n.m_uOffset = 0;
        super.OnPacket(n, socket);
        return;
      default:
        if (id > 95 && id < 190) {
          n.m_uOffset = 0;
          CGameSessionTable.ms_pInstance!.OnPacket(n, socket);
          return;
        }
        n.m_uOffset = 0;
        super.OnPacket(n, socket);
        return;
    }
  }

  /** CChannelPool::OnAddNewSocket — packet 15 + the rank/guild lists. */
  OnAddNewSocket(socket: CClientSocket): void {
    const p = new CSendPacket(GS_ClientSend.OnChannelAnnounce);
    socket.SendPacket(p);
    this.InsertRankList(socket);
    this.PutUserSimpleInfoPacket(socket, 0);
    this.InsertGuildMember(socket);
    this.PutGuildMemberListPacket(socket, 0);
  }

  /** CChannelPool::OnDeleteSocket */
  OnDeleteSocket(socket: CClientSocket): void {
    this.DeleteRankList(socket);
    this.DeleteGuildMember(socket);
  }

  /** CChannelPool::InsertRankList — level desc, gSN asc tiebreak. */
  InsertRankList(socket: CClientSocket): void {
    for (const user of socket.m_apUser) {
      if (!user) continue;
      let at = this.m_vtRankList.length;
      for (let i = 0; i < this.m_vtRankList.length; i++) {
        const other = this.m_vtRankList[i]!;
        if (user.m_nLevel > other.m_nLevel || (user.m_nLevel === other.m_nLevel && user.GetGlobalSerialNo() < other.GetGlobalSerialNo())) {
          at = i;
          break;
        }
      }
      this.m_vtRankList.splice(at, 0, user);
    }
  }

  /** CChannelPool::DeleteRankList */
  DeleteRankList(socket: CClientSocket): void {
    for (const user of socket.m_apUser) {
      if (!user) continue;
      const i = this.m_vtRankList.indexOf(user);
      if (i >= 0) this.m_vtRankList.splice(i, 1);
    }
  }

  /** CChannelPool::InsertGuildMember */
  InsertGuildMember(socket: CClientSocket): void {
    for (const user of socket.m_apUser) {
      if (!user || user.m_nGuildSN === 0) continue;
      const list = this.m_vtGuildMember.get(user.m_nGuildSN) ?? [];
      list.push(user);
      this.m_vtGuildMember.set(user.m_nGuildSN, list);
    }
  }

  /** CChannelPool::DeleteGuildMember */
  DeleteGuildMember(socket: CClientSocket): void {
    for (const user of socket.m_apUser) {
      if (!user || user.m_nGuildSN === 0) continue;
      const list = this.m_vtGuildMember.get(user.m_nGuildSN);
      if (!list) continue;
      const i = list.indexOf(user);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) CGuildTable.ms_pInstance?.Remove(user.m_nGuildSN);
    }
  }

  /** CChannelPool::PutUserSimpleInfoPacket — packet 70 (9 per page). */
  PutUserSimpleInfoPacket(socket: CClientSocket, n: number): void {
    const packet = new CSendPacket(GS_ClientSend.OnRequestUserSimpleInfoRes);
    const total = this.m_vtRankList.length;
    const pages = total <= 0 ? 0 : Math.floor((total - 1) / 9) + 1;
    let page = n < 0 ? 0 : n;
    if (page > pages - 1) page = pages - 1;
    if (page < 0) page = 0;
    packet.Encode2(page);
    const from = 9 * page;
    const to = Math.min(from + 9, total);
    packet.Encode1(to - from);
    for (let i = from; i < to; i++) this.m_vtRankList[i]!.AppendSimpleInfoPacket(packet);
    socket.SendPacket(packet);
  }

  /** CChannelPool::PutGuildMemberListPacket — packet 67 for a guild page. */
  PutGuildMemberListPacket(socket: CClientSocket, n: number): void {
    const user = socket.GetUser(0);
    if (!user || user.m_nGuildSN === 0) return;
    const list = this.m_vtGuildMember.get(user.m_nGuildSN) ?? [];
    const packet = new CSendPacket(GS_ClientSend.OnGuildMemberListRes);
    const pages = list.length <= 0 ? 0 : Math.floor((list.length - 1) / 9) + 1;
    let page = n < 0 ? 0 : n;
    if (page > pages - 1) page = pages - 1;
    if (page < 0) page = 0;
    packet.Encode2(page);
    const from = 9 * page;
    const to = Math.min(from + 9, list.length);
    packet.Encode1(to - from);
    for (let i = from; i < to; i++) list[i]!.AppendSimpleInfoPacket(packet);
    socket.SendPacket(packet);
  }

  /** the MakeChannelsStatePacket/MakeChannelsGameStatePacket carrier pair */
  private SendChannelsState(socket: CClientSocket): void {
    const packet = new CSendPacket();
    CCenterProcess.ms_pInstance!.MakeChannelsStatePacket(packet);
    socket.SendPacket(packet);
    CCenterProcess.ms_pInstance!.MakeChannelsGameStatePacket(packet);
    socket.SendPacket(packet);
  }

  /** CChannelPool::OnEnterLobbyStage — packet 83; back to the lobby. */
  OnEnterLobbyStage(socket: CClientSocket): void {
    CGameSessionTable.ms_pInstance!.DestroyPlayer(socket, 0);
    socket.m_nPoolType = 1;
    const p = new CSendPacket(GS_ClientSend.OnChannelAnnounce);
    socket.SendPacket(p);
    CGameSessionTable.ms_pInstance!.PutAllSessionInfo(socket);
  }

  /** CChannelPool::OnEnterChannelStage — packet 16. */
  OnEnterChannelStage(socket: CClientSocket): void {
    if (socket.m_nPoolType === 3) {
      console.error(
        `[GS] Front-stage user want to enter channel stage. Disconnect. CurrentPoolType=${socket.m_nPoolType} [${socket.GetUser(0)?.GetName() ?? "NULL"}]`,
      );
      socket.PostClosePacket();
      return;
    }
    if (socket.m_nPoolType !== 1) CGameSessionTable.ms_pInstance!.DestroyPlayer(socket, 0);
    socket.m_nPoolType = 3;
    this.SendChannelsState(socket);
  }

  /** CChannelPool::OnReqChannelsState — packet 15 (channel stage only). */
  OnReqChannelsState(socket: CClientSocket): void {
    if (socket.m_nPoolType !== 3) return;
    this.SendChannelsState(socket);
  }

  /**
   * CChannelPool::OnReqConnectToSvr — packet 6:
   * [E1 type][E4 target][E2 version]; ok → center p2, else client 6 with the
   * CCenterProcess::CheckEnterGame code.
   */
  OnReqConnectToSvr(n: CReceivedPacket, socket: CClientSocket): void {
    const type = n.Decode1();
    if (type !== 11 && socket.m_nPoolType !== 3) {
      console.error("[GS] Non-front user try to connect server. Disconnect");
      socket.PostClosePacket();
      return;
    }
    const target = n.Decode4();
    if (type !== 11) {
      const version = n.Decode2();
      const r = CCenterProcess.ms_pInstance!.CheckEnterGame(type, target, version);
      if (r !== 1) {
        const p = new CSendPacket(GS_ClientSend.OnReqConnectToSvrFail);
        p.Encode1(r);
        socket.SendPacket(p);
        return;
      }
    }
    // ok → center p2 [E1 n][n×E4 serial][E1 type][E4 target]
    const p = new CSendPacket(MC_ReceivedPacket.OnReqConnectToSvr);
    p.Encode1(socket.GetUserCount());
    for (const u of socket.m_apUser) p.Encode4(u!.GetGlobalSerialNo());
    p.Encode1(type);
    p.Encode4(target);
    CCenterProcess.ms_pInstance?.SendPacket(p);
  }

  /** CChannelPool::OnCenterResConnectToSvr — CM 1 → client 6. */
  OnCenterResConnectToSvr(n: CReceivedPacket): void {
    const count = n.Decode1();
    let user: CUser | null = null;
    for (let i = 0; i < count; i++) {
      user = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(n.Decode4());
      if (!user) break;
    }
    const result = n.Decode1();
    const p = new CSendPacket(GS_ClientSend.OnReqConnectToSvrRes);
    p.Encode1(result);
    if (result === 1) {
      p.Encode1(n.Decode1()); // the target server class
      p.Encode4(n.Decode4()); // the target server idx
      p.Encode4(n.Decode4()); // ip
      p.Encode2(n.Decode2()); // port
    }
    user?.m_pSocket?.SendPacket(p);
  }

  /** CChannelPool::OnRequestUserSimpleInfo — packet 64. */
  OnRequestUserSimpleInfo(n: CReceivedPacket, socket: CClientSocket): void {
    const page = n.Decode2();
    this.PutUserSimpleInfoPacket(socket, page);
  }

  /** CChannelPool::OnRequestMyInfo — packet 65. */
  OnRequestMyInfo(n: CReceivedPacket, socket: CClientSocket): void {
    const idx = n.Decode1();
    if (idx >= socket.GetUserCount()) return;
    const user = socket.GetUser(idx)!;
    const packet = new CSendPacket(GS_ClientSend.OnRequestMyInfoRes);
    packet.Encode1(idx);
    packet.EncodeStr(user.account.strName);
    packet.Encode1(user.account.Gender);
    packet.EncodeStr(user.account.Address);
    packet.EncodeStr(user.account.Profile);
    packet.EncodeStr(user.account.Birthday);
    packet.Encode1(user.account.Reveal);
    socket.SendPacket(packet);
  }

  /** CChannelPool::OnRequestModifyUserInfo — packet 66 (prUpdateUserAccount). */
  OnRequestModifyUserInfo(n: CReceivedPacket, socket: CClientSocket): void {
    const user = socket.GetUser(0);
    if (!user) return;
    user.account.strName = n.DecodeStr();
    user.account.Gender = n.Decode1();
    user.account.Address = n.DecodeStr();
    user.account.Reveal = n.Decode1();
    user.account.Profile = n.DecodeStr();
    user.account.Birthday = n.DecodeStr();
    this.db.prUpdateUserAccount(
      user.account.strID,
      user.account.strName,
      user.account.Gender,
      user.account.Address,
      user.account.Reveal,
      user.account.Profile,
      user.account.Birthday,
    );
  }

  /** CChannelPool::OnRequestUserInfoDetail — packet 67. */
  OnRequestUserInfoDetail(n: CReceivedPacket, socket: CClientSocket): void {
    const name = n.DecodeStr();
    const user = CLocalUserTable.ms_pInstance!.FindUserFromId(name);
    if (!user) {
      // ask the center (MC 7 [E1 0|1][E4 asker][EStr name])
      const p = new CSendPacket(MC_ReceivedPacket.OnSvrReservedMsg);
      p.Encode1(0);
      p.Encode4(socket.GetUser(0)!.GetGlobalSerialNo());
      p.EncodeStr(name);
      CCenterProcess.ms_pInstance?.SendPacket(p);
      return;
    }
    this.SendUserDetailInfo(socket, user);
  }

  /** CChannelPool::SendUserDetailInfo — the local-user 71 body. */
  SendUserDetailInfo(socket: CClientSocket, user: CUser): void {
    const packet = new CSendPacket(GS_ClientSend.OnRequestUserInfoDetailRes);
    packet.Encode1(1);
    packet.EncodeStr(user.GetName());
    packet.EncodeStr(user.account.strName);
    const guild = CGuildTable.ms_pInstance!.FindGuildFromSerialNo(user.m_nGuildSN);
    packet.EncodeStr(guild ? guild.strName : "");
    packet.Encode1(user.account.Gender);
    packet.Encode4(user.dyn.win);
    packet.Encode4(user.dyn.draw);
    packet.Encode4(user.dyn.lose);
    packet.Encode4(user.dyn.exp);
    packet.Encode4(0x7fffffff); // GetMaxExpInLevel (the top level)
    packet.Encode2(user.m_nLevel);
    packet.Encode4(user.dyn.money);
    packet.Encode1(10);
    packet.Encode4(CServerConfig.ms_pInstance!.GetNumAttribute("ServerIndex"));
    packet.Encode2(user.GetSessionIdx() & 0xffff);
    packet.Encode1(user.account.Reveal);
    if (user.account.Reveal !== 0) {
      packet.EncodeStr(user.account.Address);
      packet.EncodeStr(user.account.Tel);
      packet.EncodeStr(user.account.Profile);
      packet.EncodeStr(user.account.Birthday);
    }
    packet.Encode4(user.m_nPremiumSvrIdx);
    packet.Encode1(user.account.CommunitySvr);
    // SendGameSlotInfo (the 9 decoration slots)
    let slots = 0;
    for (let i = 0; i < 9; i++) if (user.GetSlotDecorationLoaded(i)) slots++;
    packet.Encode2(slots);
    for (let i = 0; i < 9; i++) {
      const deco = user.GetSlotDecorationLoaded(i);
      if (deco) {
        packet.Encode1(i);
        packet.Encode2(deco.ItemSN);
      }
    }
    packet.Encode2(0);
    user.MakeInventoryPacket(packet, 3);
    socket.SendPacket(packet);
  }

  /** CChannelPool::OnRequestUserLocation — packet 69. */
  OnRequestUserLocation(n: CReceivedPacket, socket: CClientSocket): void {
    const name = n.DecodeStr();
    const user = CLocalUserTable.ms_pInstance!.FindUserFromId(name);
    if (!user) {
      const p = new CSendPacket(MC_ReceivedPacket.OnSvrReservedMsg);
      p.Encode1(1);
      p.Encode4(socket.GetUser(0)!.GetGlobalSerialNo());
      p.EncodeStr(name);
      CCenterProcess.ms_pInstance?.SendPacket(p);
      return;
    }
    const packet = new CSendPacket(GS_ClientSend.OnRequestUserLocationRes);
    packet.Encode1(1);
    packet.EncodeStr(user.GetName());
    packet.Encode1(10);
    packet.Encode4(CServerConfig.ms_pInstance!.GetNumAttribute("ServerIndex"));
    packet.Encode2(user.GetSessionIdx() & 0xffff);
    socket.SendPacket(packet);
  }

  /** CChannelPool::OnRequestGuildInfo — packet 70 request → 66. */
  OnRequestGuildInfo(n: CReceivedPacket, socket: CClientSocket): void {
    const sn = n.Decode4();
    const guild = CGuildTable.ms_pInstance!.FindGuildFromSerialNo(sn);
    if (!guild) return;
    const packet = new CSendPacket(GS_ClientSend.OnRequestGuildInfoRes);
    packet.Encode4(guild.m_nGuildSN);
    packet.EncodeStr(guild.strName);
    packet.Encode2(guild.m_nMarkRevision);
    socket.SendPacket(packet);
  }

  /** CChannelPool::OnGuildMarkRevision — packet 38. */
  OnGuildMarkRevision(n: CReceivedPacket): void {
    const sn = n.Decode4();
    const rev = n.Decode2();
    const guild = CGuildTable.ms_pInstance!.FindGuildFromSerialNo(sn);
    if (guild && guild.m_nMarkRevision < rev) guild.m_nMarkRevision = rev;
  }

  /** CChannelPool::OnInviteUser — packet 28. */
  OnInviteUser(n: CReceivedPacket, socket: CClientSocket): void {
    const idx = n.Decode2();
    const serial = n.Decode4();
    const name = n.DecodeStr();
    const target = CLocalUserTable.ms_pInstance!.FindUserFromId(name);
    if (!target) return;
    const packet = new CSendPacket(GS_ClientSend.OnInviteUser);
    packet.Encode2(idx);
    packet.Encode4(serial);
    packet.EncodeStr(socket.GetUser(0)!.GetName());
    packet.EncodeStr(""); // CopySessionPasswd — no password echo
    target.m_pSocket?.SendPacket(packet);
  }

  /** CChannelPool::OnRequestGuildMemberInfo — packet 85. */
  OnRequestGuildMemberInfo(n: CReceivedPacket, socket: CClientSocket): void {
    const page = n.Decode2();
    this.PutGuildMemberListPacket(socket, page);
  }

  /** CChannelPool::OnRequestUserItemList — packet 209. */
  OnRequestUserItemList(socket: CClientSocket): void {
    const packet = new CSendPacket(GS_ClientSend.OnUserItemList);
    CUserItemMan.ms_pInstance!.PutUserItemList(packet);
    socket.SendPacket(packet);
  }
}

// ============================ CMainSystem ============================

/** CMainSystem — config-derived globals + the client dispatch hook. */
export class CMainSystem {
  static ms_pInstance: CMainSystem | null = null;

  m_nGameDomain = 0; // +4
  m_nChannelType = 0; // +8 (MainSystem+8 — chByteType[ServerIndex])
  m_fInventoryDB = 0; // +27 (the entry path's InitUserInventory gate)
  m_nPremiumSvrReward = 0; // CChannelPool ctor fill
  m_nPremiumSvrLuckPro = 30000;

  constructor(cfg: CServerConfig) {
    CMainSystem.ms_pInstance = this;
    this.m_nGameDomain = cfg.GetNumAttribute("GameDomain");
  }

  /** CMainSystem::OnConnEstablished — the connect-time packet 0. */
  OnConnEstablished(socket: CClientSocket): void {
    const packet = new CSendPacket(GS_ClientSend.OnConnect);
    packet.Encode2(3);
    packet.Encode2(7);
    packet.Encode4(socket.m_nHeaderType);
    socket.SendPacket(packet);
  }

  /** The worker-thread dispatch: connect/channel pool by the socket stage. */
  DispatchClient(n: CReceivedPacket, socket: CClientSocket): void {
    if (socket.m_nPoolType === 0) CConnectPool.ms_pInstance?.OnPacket(n, socket);
    else CChannelPool.ms_pInstance?.OnPacket(n, socket);
  }
}

// ============================ CCenterProcess ============================

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
  m_anChannelIdx: number[] = []; // +39192
  m_anChannelType: number[] = []; // +280
  m_anChannelSvrClass: number[] = []; // +43288
  m_anChannelPort: number[] = []; // +44312 (u16)
  m_anChannelEnterable: number[] = []; // +46360

  constructor(public db: CDBMan) {
    this.m_pSocket = new CLocalSocket({
      onPacket: (_sock, packet) => this.OnPacket(packet),
      onClose: () => {
        console.error("[GS] LocalSocket connection closed from center server, terminate process.");
        process.exit(0);
      },
    });
    CCenterProcess.ms_pInstance = this;
  }

  /** CCenterProcess::Init — connect, greet, identify. */
  async Init(cfg: CServerConfig): Promise<void> {
    await this.m_pSocket.ConnectToCenter(
      cfg.GetAttribute("CenterIP"),
      cfg.GetNumAttribute("CenterPort"),
      SVRCLASS_GAME,
      cfg.GetNumAttribute("ServerIndex"),
      7,
      3,
    );
    console.log("[GS] Connection to Center Server established");
  }

  /** CCenterProcess::SendPacket (the CLocalSocket uplink). */
  SendPacket(packet: CSendPacket): void {
    this.m_pSocket.SendToCenter(packet);
  }

  /** CCenterProcess::UnregisterConnection — MC 1 [E4 serial]. */
  UnregisterConnection(n: number): void {
    const p = new CSendPacket(MC_ReceivedPacket.OnDeleteUser);
    p.Encode4(n);
    this.SendPacket(p);
  }

  /** CCenterProcess::SendAuthenCode — MC 9 [E4 serial][E1 code]. */
  SendAuthenCode(n: number, code: number): void {
    const p = new CSendPacket(MC_ReceivedPacket.OnSetAuthenCode);
    p.Encode4(n);
    p.Encode1(code);
    this.SendPacket(p);
  }

  /** CCenterProcess::OnPacket — the 13-case dispatch. */
  OnPacket(n: CReceivedPacket): void {
    switch (n.Decode1()) {
      case CM_ReceivedPacket.OnCenterResConnectToSvr:
        CChannelPool.ms_pInstance?.OnCenterResConnectToSvr(n);
        break;
      case CM_ReceivedPacket.OnCenterResConnEstablished:
        CConnectPool.ms_pInstance?.OnCenterResConnEstablished(n);
        break;
      case CM_ReceivedPacket.OnLocalServerInfo:
        this.OnLocalServerInfo(n);
        break;
      case CM_ReceivedPacket.OnLocalServerState:
        this.OnLocalServerState(n);
        break;
      case CM_ReceivedPacket.OnLocalGameState:
        this.OnLocalGameState(n);
        break;
      case CM_ReceivedPacket.OnSvrReservedMsg:
        this.OnSvrReservedMsg(n);
        break;
      case CM_ReceivedPacket.OnAdminNotifyMsg:
        this.OnAdminNotifyMsg(n);
        break;
      case CM_ReceivedPacket.OnUserChannelResult:
        this.OnUserChannelResult(n);
        break;
      case CM_ReceivedPacket.OnDeleteUser:
        this.OnDeleteUser(n);
        break;
      case CM_ReceivedPacket.OnInitialSvrAttr:
        this.OnInitialSvrAttr(n);
        break;
      case CM_ReceivedPacket.OnSystemMsg:
        this.OnSystemMsg(n);
        break;
      case CM_ReceivedPacket.OnItemDBInit:
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
    this.m_anChannelIdx = [];
    this.m_anChannelType = [];
    this.m_anChannelSvrClass = [];
    this.m_anChannelPort = [];
    this.m_anChannelEnterable = [];
    for (let i = 0; i < this.m_nChannels; i++) {
      this.m_aszChannelName.push(n.DecodeStr());
      this.m_anChannelIdx.push(n.Decode4());
      this.m_anChannelType.push(n.Decode1());
      this.m_anChannelSvrClass.push(n.Decode1());
      this.m_anChannelPort.push(n.Decode2());
      this.m_anChannelEnterable.push(n.Decode1());
    }
    // MainSystem+8 = chByteType[ServerIndex]
    const idx = CServerConfig.ms_pInstance!.GetNumAttribute("ServerIndex");
    CMainSystem.ms_pInstance!.m_nChannelType = this.m_anChannelType[idx] ?? 0;
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
    packet.InitPacket(GS_ClientSend.OnChannelsState);
    packet.Encode2(this.m_nChannels);
    for (let i = 0; i < this.m_nChannels; i++) packet.Encode2(this.m_anConnCount[i] ?? 0);
  }

  /** CCenterProcess::MakeChannelsGameStatePacket — the 14 body (InitPacket). */
  MakeChannelsGameStatePacket(packet: CSendPacket): void {
    if (this.m_vtGameStateOrder.length === 0) return;
    packet.InitPacket(GS_ClientSend.OnChannelsGameState);
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
    if (this.m_vtGameStateOrder.length === 0) return 0;
    if ((this.m_mapAlive.get(i) ?? 0) !== 0) {
      return (this.m_mapGameVersion.get(i) ?? 0) === version ? 1 : 4;
    }
    return 5;
  }

  /** CCenterProcess::OnSvrReservedMsg — CM 7 → client 16. */
  OnSvrReservedMsg(n: CReceivedPacket): void {
    const name = n.DecodeStr();
    const user = CLocalUserTable.ms_pInstance!.FindUserFromId(name);
    if (!user) return;
    const code = n.Decode1();
    const p = new CSendPacket(GS_ClientSend.OnSvrReservedMsg);
    p.Encode1(code);
    if (code === 1) p.EncodeStr(n.DecodeStr());
    user.m_pSocket?.SendPacket(p);
  }

  /** CCenterProcess::OnAdminNotifyMsg — CM 8 → client 26 to everyone. */
  OnAdminNotifyMsg(n: CReceivedPacket): void {
    const msg = n.DecodeStr();
    const p = new CSendPacket(GS_ClientSend.OnAdminNotifyMsg);
    p.EncodeStr(msg);
    CChannelPool.ms_pInstance?.SendAll(p, 0);
  }

  /** CCenterProcess::OnSystemMsg — CM 13 → client 30 to everyone. */
  OnSystemMsg(n: CReceivedPacket): void {
    const msg = n.DecodeStr();
    const p = new CSendPacket(GS_ClientSend.OnSystemMsg);
    p.EncodeStr(msg);
    CChannelPool.ms_pInstance?.SendAll(p, 0);
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

  /** CMainSystem::OnInitialSvrAttr — CM 12 [E1 domain][E1 inventory flag]. */
  OnInitialSvrAttr(n: CReceivedPacket): void {
    const domain = n.Decode1();
    const inv = n.Decode1();
    CMainSystem.ms_pInstance!.m_nGameDomain = domain;
    CMainSystem.ms_pInstance!.m_fInventoryDB = inv;
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
      const p = new CSendPacket(GS_ClientSend.OnRequestUserLocationRes);
      p.Encode1(1);
      p.EncodeStr(name);
      p.Encode1(type);
      p.Encode4(sessionIdx);
      p.Encode2(0xfffe); // the other-server marker
      asker.m_pSocket.SendPacket(p);
    } else {
      // SendUserDetailInfo → 71 (DB-backed)
      const info = this.db.prGetUserInfo(name);
      const p = new CSendPacket(GS_ClientSend.OnRequestUserInfoDetailRes);
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
        p.Encode4(0x7fffffff);
        p.Encode2(CDynInfoCalculator_GetLevel(info.exp));
        p.Encode4(info.money);
        p.Encode1(type);
        p.Encode4(sessionIdx);
        p.Encode2(0xfffe);
        p.Encode1(info.Reveal);
        if (info.Reveal !== 0) {
          p.EncodeStr(info.Address);
          p.EncodeStr(info.Tel);
          p.EncodeStr(info.Profile);
          p.EncodeStr(info.Birthday);
        }
        p.Encode4(0);
        p.Encode1(info.CommunitySvr);
        p.Encode2(0); // SendGameSlotInfo(NULL): 0 slots
        p.Encode2(0);
        p.Encode2(0);
      } else {
        p.Encode1(0);
        p.EncodeStr(name);
      }
      asker.m_pSocket.SendPacket(p);
    }
  }
}

// ============================ boot ============================

/** CFxServerApp::SetUp — the process entry. */
export async function main(cfgFile: string, dbDir: string): Promise<void> {
  const cfg = new CServerConfig();
  cfg.Init(cfgFile);
  CServerConfig.ms_pInstance = cfg;

  const db = new CDBMan(dbDir);
  const itemMan = new CUserItemMan();
  itemMan.Init(db);
  new CLocalUserTable();
  const mainSystem = new CMainSystem(cfg);
  new CGameSessionTable();
  const connectPool = new CConnectPool(db);
  const channelPool = new CChannelPool(db);
  new CGuildTable(db);
  const center = new CCenterProcess(db);
  void mainSystem;
  void connectPool;
  void channelPool;

  // CListenThread — the client listener (ServerIP/ServerPort)
  const port = cfg.GetNumAttribute("ServerPort") || 4848;
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
        mainSystem.OnConnEstablished(socket);
      },
      data: (t, data) => {
        const s = clientSockets.get(t);
        if (s) {
          s.m_dwIdleTime = Date.now();
          s.OnReceive(new Uint8Array(data as Buffer));
        }
      },
      close: (t) => {
        clientSockets.get(t)?.Close();
      },
      error: (_t, err) => console.error(`[GS] ${String(err)}`),
    },
  });
  console.log(`[GS] listening on :${port}`);

  // the periodic CUserPool::OnTimer sweeps (once a second, like the timer thread)
  setInterval(() => {
    connectPool.DisconnectTimeoutSocket();
    channelPool.DisconnectTimeoutSocket();
  }, 1000);

  await center.Init(cfg);
}
