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
import { PacketLog } from "../core/PacketLog.ts";
import { CPacketSocket } from "../core/CPacketSocket.ts";
import { CipherDegree, CReceivedPacket, CSendPacket } from "../core/Packet.ts";
import { UpdateCRC32 } from "../core/CRC.ts";
import { CDBMan } from "../db/DBMan.ts";
import { CData, CIDFMan } from "./CData.ts";
import {
  HOSTHANDLE,
  MTUDP_TYPE_PEER_INFO,
  MTUDP_TYPE_READY_FOR_IMMEDIATE_START,
  MTUDP_UDP_PORT_OFFSET,
  SplitDatagram,
} from "./MTUDP.ts";
import { CLocalSocket } from "../lib/CenterLink.ts";
import { CM_ReceivedPacket, CENTER_VERSION, CONN_HELLO_VERSION, MC_ReceivedPacket, SVRCLASS_GAME } from "../lib/S2S.ts";
import {
  CLIENTSOCKET_HEADER_CODE_MODIFIER,
  CLIENTSOCKET_HEADER_CODE_RCV,
  CLIENTSOCKET_HEADER_CODE_SND,
  CLIENTSOCKET_SEQ,
  CLIENTSOCKET_SEQ_DELTA,
  GS_ClientSend,
  GS_ReceivedPacket,
  SESSION_ReceivedPacket,
  PACKET_NAME_TABLES,
} from "../lib/PacketIDs.ts";
import {
  CDynInfoCalculator_GetLevel,
  CDynInfoCalculator_GetMaxExpInLevel,
  kLevelTableSize,
} from "../login/LevelTable.ts";


/** CMainSystem::OnConnEstablished (FxServer.exe.c:20694) — the client patch
 *  URL; the GS hands out the download root (shop/util hand out the patch
 *  root, the LS its UrlPatch config table). */
const CONN_PATCH_URL = "ftp://download.nexon.co.kr/ca";

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

/**
 * CBaseSession m_rgSlotState triple (+68+3·slot) bit fields — byte0: bits 2-4
 * carry the ready-group code (4 = OnSetPlayerReady's ready toggle :35286, 8 =
 * the OnReadyForImmediateStart start-gate state :34488 that the launch poll
 * requires :31919), byte1 low 6 = the selected bomber idx (:31177/:37308),
 * byte2 low 5 = the colour (:30429).  The CanStartGame stand-by check reads
 * the same group code (:33531/:33537).
 */
export const SLOTSTATE_GROUP_MASK = 0x1c;
export const SLOTSTATE_GROUP_CLEAR = 0xe3; // ~GROUP_MASK & 0xff
export const SLOTSTATE_READY = 0x04;
export const SLOTSTATE_LAUNCH_OK = 0x08;
export const SLOTSTATE_CHIEF = 0x02; // byte0 bit1 — SetChiefSlotidx's marker
export const SLOTSTATE_CHIEF_CLEAR = 0xfd; // ~CHIEF & 0xff
export const SLOTSTATE_BOMBER_MASK = 0x3f;
export const SLOTSTATE_BOMBER_CLEAR = 0xc0; // ~BOMBER_MASK & 0xff
export const SLOTSTATE_COLOR_MASK = 0x1f;
export const SLOTSTATE_COLOR_CLEAR = 0xe0; // ~COLOR_MASK & 0xff

/** CClientSocket+500 session-idx WORD sentinels (ctor `mov word -1`;
 *  the GetPacket switch default ignores session packets in these states). */
export const SESSION_IDX_NONE = 0xffff; // sitting in the lobby
export const SESSION_IDX_CONNECTING = 0xfffe; // still connecting
/** the unsigned idx validity bound — the sentinels above all fail it. */
export const SESSION_IDX_MAX = 255;

/** CChannelPool::SendUserLocation (:6192) / SendUserDetailInfo (:6561) —
 *  the Encode2(65534) "user is on another server" marker that follows the
 *  session idx in the 71/72 responses. */
export const SESSION_LOC_OTHER_SERVER = 0xfffe; // 65534

/** CListSession chief-swap counter +728 — at 10000 the room turns supreme
 *  (GetNextChiefSlot / IsLadderGame read it; the original writes 10000). */
export const SUPREME_ROOM_SWAP_COUNT = 0x2710;
/** CUdpLossRegulator::DeferRegulateConnection (:26256) — regulate only once
 *  8 s have passed since the first loss-report (187). */
export const UDP_REGULATE_DELAY = 0x1f40;
/** CGameSession::DeferReturnPrepareStage (:31979) — 8 s after the end screen. */
export const RETURN_STAGE_DELAY = 0x1f40;
/** CGameSessionStrategy::GetResultViewType (4216C6; guild override 4233B9 → 1)
 *  — CreateSessionStrategy only builds the guild strategy when CMainSystem+8
 *  is 77, so on FXGS the SendGameResult head byte is always the base 0. */
export const GAME_RESULT_VIEW_TYPE = 0;
/** CGameSession::IsLadderGame (4209A6: xor eax,eax) — the SendGameResult head
 *  byte is hardwired 0 in this build. */
export const IS_LADDER_GAME = 0;
/** asc_48F568 (EUC-KR) — "[\xbe\xcb\xb8\xb2] %s ..." = "[Notification] %s has obtained 100x the luck of experience in the premium channel."
 *  (SendGameResult → SendBigLuckMsg; GetWinExp never sets the trigger flag). */
export const STR_BIG_LUCK_MSG = "\x5b\xbe\xcb\xb8\xb2\x5d\x20\x25\x73\x20\xb4\xd4\xb2\xb2\xbc\xad\x20\xc7\xc1\xb8\xae\xb9\xcc\xbe\xf6\x20\xc3\xa4\xb3\xce\xbf\xa1\xbc\xad\x20\xb0\xe6\xc7\xe8\xc4\xa1\x20\x31\x30\x30\xb9\xe8\xc0\xc7\x20\xc7\xe0\xbf\xee\xc0\xbb\x20\xbe\xf2\xc0\xb8\xbc\xcc\xbd\xc0\xb4\xcf\xb4\xd9\x2e";

/** The session dimension everywhere: 8 slots / 8 colours / 8 loss-matrix rows
 *  (the original loops the same 8-slot tables with plain do/while). */
export const MAX_SESSION_SLOTS = 8;

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
  m_nFree = 0; // +20 (CSafeObject::m_nFree — 0 while the user object is live)
  m_nSlotIdx = -1; // +490
  m_nGlobalSerialNo = 0; // +491 (CUser::SetGlobalSerialNo)
  m_nGuildSN = 0; // +493 (CUser::SetGuildSerialNo; filled from the p7 tail)
  m_fMoneyModified = 0; // +494
  m_nWinCount = 0; // +216
  m_nDrawCount = 0; // +220
  m_nLoseCount = 0; // +224
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

  SetName(strName: string): void {
    this.strName = strName;
  }

  /** CUser::SetGlobalSerialNo */
  SetGlobalSerialNo(serial: number): void {
    this.m_nGlobalSerialNo = serial >>> 0;
  }

  GetGlobalSerialNo(): number {
    return this.m_nGlobalSerialNo;
  }

  /** CUser::SetGuildSerialNo */
  SetGuildSerialNo(serial: number): void {
    this.m_nGuildSN = serial;
  }

  GetGuildSerialNo(): number {
    return this.m_nGuildSN;
  }

  /** CUser::SetSessionIdx — through the owning socket (+500). */
  SetSessionIdx(idx: number): void {
    if (this.m_pSocket) this.m_pSocket.m_nSessionIdx = idx;
  }

  /** CUser::GetSessionIdx — unsigned __int16 (FxServer.exe.c:26925; the
   *  `return -1` there is a u16 0xFFFF). */
  GetSessionIdx(): number {
    return this.m_pSocket ? this.m_pSocket.m_nSessionIdx & 0xffff : SESSION_IDX_NONE;
  }

  /** CUser::SetSessionSerialNo — through the owning socket (+504). */
  SetSessionSerialNo(serial: number): void {
    if (this.m_pSocket) this.m_pSocket.m_nSessionSerialNo = serial >>> 0;
  }

  GetSessionSerialNo(): number {
    return this.m_pSocket ? this.m_pSocket.m_nSessionSerialNo : 0;
  }

  /** CUser::SetPoolType / GetPoolType — the owning socket's stage tag (+468). */
  SetPoolType(type: number): void {
    if (this.m_pSocket) this.m_pSocket.m_nPoolType = type;
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
  /** CUser::IncWin / IncDraw / IncLose (41D1C1..41D219) — count + the money flush flag. */
  IncWin(): void {
    this.m_nWinCount++;
    this.m_fMoneyModified = 1;
  }
  IncDraw(): void {
    this.m_nDrawCount++;
    this.m_fMoneyModified = 1;
  }
  IncLose(): void {
    this.m_nLoseCount++;
    this.m_fMoneyModified = 1;
  }

  /** CUser::IncGame (41D245) — bumps the dyn burst counter (+2000). */
  IncGame(): void {
    this.m_nFlushCount++;
  }

  /** CUser::GetSelfidx (FxServer.exe.c:26610) — this user's index inside its socket. */
  GetSelfidx(): number {
    const socket = this.m_pSocket;
    if (!socket) return -1;
    for (let i = 0; i < socket.GetUserCount(); i++) if (socket.GetUser(i) === this) return i;
    return -1;
  }

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
  DeferFlushModifiedInfo(db: CDBMan, fForce: number): void {
    if (fForce !== 0 || this.m_nFlushCount >= DYN_FLUSH_BURST) {
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
    // CUser::AppendSimpleInfoPacket (FxServer.exe.c:27122) — the look level
    // rides through vtbl+24 = Encode2 (CSendPacketBase vtable 0x492198:
    // +20 E1 / +24 E2 / +28 E4 / +32 EStr), NOT Encode4.
    packet.Encode2(this.GetLookLevel());
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
  m_nSessionIdx = SESSION_IDX_NONE; // +500 — a WORD in the original (ctor `mov word -1`,
  // FxServer.exe.c:9831): 0xFFFF = none/lobby, 0xFFFE (-2) = connecting, else slot
  m_nSessionSerialNo = 0; // +504 (CUser::SetSessionSerialNo)
  m_fImpPoint = 0; // +472 (CClientSocket::SetImpPoint — modified client)
  m_dwLastRTT = 0; // the socket's last RTT reply time
  m_apUser: (CUser | null)[] = []; // +460
  m_nUserCount = 0; // +456
  m_anBeforeJoinSession: number[] = []; // +476..+496 (5-deep ring)
  m_dwIdleTime = Date.now() - 5000;
  /** The CBaseSession::PutPacket queue (this+56); FlushPacket drains it. */
  m_pendingPackets: CSendPacket[] = [];

  constructor() {
    super(CPacketSocket.dwRcvBufferSize, CPacketSocket.dwSndBufferSize, {
      onPacket: (_sock, packet) => CMainSystem.ms_pInstance?.DispatchClient(packet, this),
    });
    this.m_szLogTag = "GS";
    this.m_fClientLink = true;
    this.m_nLocalSerialNo = CClientSocket.ms_tblSN2Obj.size + 1;
    const nHeaderType = CClientSocket.ms_nHeaderTypeCounter % 16;
    CClientSocket.ms_nHeaderTypeCounter++;
    this.SetHeaderType(nHeaderType);
    this.SetHeaderCode(CLIENTSOCKET_HEADER_CODE_RCV, CLIENTSOCKET_HEADER_CODE_SND, CLIENTSOCKET_HEADER_CODE_MODIFIER);
    this.SetSequence(CLIENTSOCKET_SEQ, CLIENTSOCKET_SEQ, CLIENTSOCKET_SEQ_DELTA, CLIENTSOCKET_SEQ_DELTA);
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
  SetUser(i: number, user: CUser): void {
    this.m_apUser[i] = user;
  }

  GetUser(i: number): CUser | null {
    return this.m_apUser[i] ?? null;
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
  CheckInBeforeJoinSession(idx: number): boolean {
    return this.m_anBeforeJoinSession.includes(idx);
  }

  /**
   * CClientSocket::AddBeforeJoinSession (FxServer.exe.c:8908) — remember a
   * session idx this socket left, in the fixed 5-entry array at +476 with the
   * count at +496: once full, entry 0 falls off ([119]<=[120]<=[121]<=
   * [122]<=[123]=idx).
   */
  AddBeforeJoinSession(idx: number): void {
    if (this.CheckInBeforeJoinSession(idx)) return;
    if (this.m_anBeforeJoinSession.length >= 5) this.m_anBeforeJoinSession.shift();
    this.m_anBeforeJoinSession.push(idx);
  }

  /** CClientSocket::GetSelfidxFromSerialNo */
  GetSelfidxFromSerialNo(n: number): number {
    return this.m_apUser.findIndex((u) => u && u.m_nGlobalSerialNo === n);
  }

  /** CClientSocket::IsAttatchedUser — does this socket own the user? */
  IsAttatchedUser(user: CUser): boolean {
    return this.m_apUser.includes(user);
  }

  /** CClientSocket::HasAuthority — always 0 without the operator link. */
  static HasAuthority(_a1: number): number {
    return 0;
  }

  /** CBaseSession::PutPacket target (CClientSocket vtbl+56) — queue a copy
   *  of the session's shared packet.  (CPacketSocket::PutPacket above is the
   *  encode-into-send-buffer primitive the base socket uses.) */
  QueuePacket(packet: CSendPacket): void {
    const copy = new CSendPacket(packet.m_nPacketType, packet.m_nCipherDegree);
    copy.EncodeBuffer(packet.m_pBlock.subarray(1, packet.m_uOffset)); // skip the type byte
    this.m_pendingPackets.push(copy);
  }

  /** CClientSocket vtbl+64 — send everything the sessions queued. */
  FlushPendingPackets(): void {
    if (this.m_pendingPackets.length === 0) return;
    const queue = this.m_pendingPackets;
    this.m_pendingPackets = [];
    for (const p of queue) this.SendPacket(p);
  }

  /** CClientSocket vtbl+76 — one last packet, then destroy the connection. */
  SendPacketAndDestroy(packet: CSendPacket): void {
    this.SendPacket(packet);
    this.Close();
  }

  PostClosePacket(): void {
    this.Close();
  }

  /** CClientSocket::SafeFree — session teardown, pool removal, user frees. */
  Close(): void {
    if (!this.m_bConnected) return;
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
    const packet = new CSendPacket(GS_ClientSend.OnEstimateRTTRes, CipherDegree.kPacketEncryptedCRC8);
    const rttValue = n.Decode4(); // the client's stamp, echoed verbatim
    const hash = n.Decode4();
    const now = Date.now() & 0x7fffffff;
    packet.Encode4(rttValue);
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
            const p = new CSendPacket(GS_ClientSend.OnGuildBanRes, CipherDegree.kPacketEncryptedCRC8);
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
    const p210 = new CSendPacket(GS_ClientSend.OnEnterGame, CipherDegree.kPacketEncryptedCRC8);
    p210.Encode1(CMainSystem.ms_pInstance!.m_fInventoryDB);
    const socket = users[0]!.m_pSocket!;
    socket.SendPacket(p210);
    if (this.DeleteSocket(socket) !== 0 && CChannelPool.ms_pInstance!.AddNewSocket(socket) !== 0) {
      let sent = false;
      if (users[0]!.m_nFlushCount === 0) {
        const p202 = new CSendPacket(GS_ClientSend.OnUserItemList, CipherDegree.kPacketEncryptedCRC8);
        CUserItemMan.ms_pInstance!.PutUserItemList(p202);
        socket.SendPacket(p202);
        sent = true;
      }
      if (users.some((u) => u && u.m_nPreInventoryCount > 0)) {
        const p207 = new CSendPacket(GS_ClientSend.OnPreInventory, CipherDegree.kPacketEncryptedCRC8);
        p207.Encode1(count);
        for (const u of users) u!.MakePreInventoryPacket(p207);
        socket.SendPacket(p207);
        sent = true;
      }
      if (sent) {
        const p201 = new CSendPacket(GS_ClientSend.OnUserInventory, CipherDegree.kPacketEncryptedCRC8);
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
// ============================ game data tables ============================

/**
 * SimpleCipher (FxServer.exe.c:16189) — the self-inverse byte chain that
 * obfuscates the names inside Attr/ItemAttr: byte i is XORed with a key that
 * starts at 0xA5 and then becomes (key * (i+1) + key / (i+1)) & 0xFF.
 */
function SimpleCipher(buf: Uint8Array, n64: number): void {
  let key = 0xa5;
  for (let i = 0; i < n64; i++) {
    buf[i] = (buf[i] ^ key) & 0xff;
    key = (key * (i + 1) + Math.floor(key / (i + 1))) & 0xff;
  }
}

/** CItemAttr (Attr/ItemAttr) — the name table SendAirplaneItemProb needs. */
export class CItemAttr {
  static ms_pInstance: CItemAttr | null = null;

  /** index → the decoded "Item/..." name (CItemAttr +12, stride 164). */
  m_vtName: string[] = [];
  /** entry+140 (dword 35) — the effect class (99 = the lucci/gem item). */
  m_vtEffect: number[] = [];
  /** entry+144 (dword 36) — the per-use amount (the lucci payout). */
  m_vtAmount: number[] = [];

  constructor() {
    CItemAttr.ms_pInstance = this;
  }

  Load(): void {
    const cd = new CData();
    if (!cd.Load("Attr/ItemAttr")) return; // "Data File Not Found" — the table stays empty
    const data = cd.GetPtr()!;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let at = 0;
    at += 8; // two header dwords (+102428 / +102432)
    const mapCount = dv.getUint32(at, true);
    at += 4;
    at += mapCount * 60; // the id→item map section (15 dwords each)
    // the main section: [E4 len][ciphered name][E4 len][ciphered image]…, idx = load order
    let idx = 0;
    while (at + 8 <= data.byteLength) {
      const len = dv.getUint32(at, true);
      at += 4;
      if (len <= 0 || len >= 64 || at + len > data.byteLength) break;
      const name = data.subarray(at, at + len);
      SimpleCipher(name, 64 <= len ? 64 : len);
      this.m_vtName[idx] = new TextDecoder().decode(name).replace(/\0.*$/, "");
      at += len;
      at += 4;
      const len2 = dv.getUint32(at, true);
      at += 4 + len2;
      at += 2 * 4; // +132 (string-id count) / +136
      this.m_vtEffect[idx] = dv.getInt32(at, true);
      at += 4;
      this.m_vtAmount[idx] = dv.getInt32(at, true);
      at += 4 + 4 * 4; // +148..+160
      idx++;
    }
  }

  /** CItemAttr::GetItemidx — the "Item/" prefix is stripped before comparing. */
  GetItemidx(name: string): number {
    let s = name;
    if (s.toLowerCase().startsWith("item/item")) s = s.slice(9);
    else if (s.toLowerCase().startsWith("item/")) s = s.slice(5);
    const lower = s.toLowerCase();
    return this.m_vtName.findIndex((n) => n.toLowerCase() === lower);
  }
}

/** CBomberAttr (Attr/BomberAttr) — 296 bytes per bomber, FxServer.exe.c:54336. */
export interface BomberAttrEntry {
  strName: string; // +0
  nAttr1: number; // +256
  nAttr2: number; // +260
  nAttr3: number; // +264
  nAttr4: number; // +268
  nDefSpeed: number; // +272 (clamped to 10)
  nAttr6: number; // +276
  nDefBombCount: number; // +280
  nAttr8: number; // +284
  nDefBombPower: number; // +288
  nAttr10: number; // +292
}

export class CBomberAttr {
  static ms_pInstance: CBomberAttr | null = null;

  m_nTotalCount = 0; // +4 (GetTotalCount; GetRandomBomberIdx returns it too)
  m_nHiddenCount = 0; // +8 (GetNormalCount = TotalCount - HiddenCount)
  m_vtAttr: BomberAttrEntry[] = []; // 296-byte records from +12

  constructor() {
    CBomberAttr.ms_pInstance = this;
  }

  Load(): void {
    const cd = new CData();
    if (!cd.Load("Attr/BomberAttr")) return; // "Data File Not Found" — the table stays empty
    const data = cd.GetPtr()!;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let at = 0;
    const decoder = new TextDecoder();
    while (at + 4 <= data.byteLength) {
      const len = dv.getUint32(at, true);
      at += 4;
      // 40 = the 10 trailing dwords (+256..+292) — the record needs them all
      if (len <= 0 || len >= 54 || at + len + 40 > data.byteLength) break;
      const name = decoder.decode(data.subarray(at, at + len)).replace(/\0.*$/, "");
      at += len;
      const attr: BomberAttrEntry = {
        strName: name,
        nAttr1: dv.getUint32(at, true),
        nAttr2: dv.getUint32(at + 4, true),
        nAttr3: dv.getUint32(at + 8, true),
        nAttr4: dv.getUint32(at + 12, true),
        nDefSpeed: Math.min(dv.getUint32(at + 16, true), 10),
        nAttr6: dv.getUint32(at + 20, true),
        nDefBombCount: dv.getUint32(at + 24, true),
        nAttr8: dv.getUint32(at + 28, true),
        nDefBombPower: dv.getUint32(at + 32, true),
        nAttr10: dv.getUint32(at + 36, true),
      };
      at += 40;
      if (attr.nAttr1 !== 0) this.m_nHiddenCount++;
      this.m_nTotalCount++;
      this.m_vtAttr.push(attr);
    }
  }

  GetNormalCount(): number {
    return this.m_nTotalCount - this.m_nHiddenCount;
  }

  GetTotalCount(): number {
    return this.m_nTotalCount;
  }

  GetRandomBomberIdx(): number {
    return this.m_nTotalCount;
  }

  /** CBomberAttr::IsValidSelectIdx — [0, NormalCount) plus the random index. */
  IsValidSelectIdx(idx: number): boolean {
    return (idx >= 0 && idx < this.GetNormalCount()) || idx === this.m_nTotalCount;
  }

  GetDefSpeed(idx: number): number {
    return this.m_vtAttr[idx]?.nDefSpeed ?? 0;
  }

  GetDefBombCount(idx: number): number {
    return this.m_vtAttr[idx]?.nDefBombCount ?? 0;
  }

  GetDefBombPower(idx: number): number {
    return this.m_vtAttr[idx]?.nDefBombPower ?? 0;
  }
}

/** CGameMapTmpl — one entry of CGameMapTmplList (LoadMap, FxServer.exe.c:13640). */
export class CGameMapTmpl {
  m_nIdx = 0; // +0 (the load order)
  m_strName = ""; // +16 (the "Map/…" path minus the prefix)
  m_nVersion = 1000; // +28 (file dword 0, clamped up to 1000)
  m_nMaxTeam = 8; // +32 (GetMapMaxTeam; 8 when the file is pre-1000)
  m_nOld = 1; // +36
  m_nLevelLimit = 0; // +52 (GetMapLevelLimit, minus the premium discount)
  m_nMaxPlayer = 8; // +48 (GetMapMaxPlayer)
  m_nPremiumOnly = 0; // +56 (GetMapPremiumOnly)
  m_dwCRC = 0; // +88 (CRC32 of the whole file)
  m_nThemeIdx = -1; // +80 (CheckGetThemeIdx)
  m_fLadderMap = 0; // +92
  m_fPracticeMap = 0; // +96 (IsPracticeMap; "PraticeMapGroup" in the original)
  m_fReBirthMap = 0; // +100
  m_nMissionType = 0; // +108 (MissionInfo head; > 0 → IsMissionMap)
  m_nLapTileCount = 0; // +112
  m_nLapTime = 0; // +116
  m_nLapBonus = 0; // +120
  m_nArg84 = 0; // +84
  m_nArg60 = 0; // +60
  m_nArg64 = 0; // +64
  m_dwAirplaneItemProb = 0; // +72 — SendAirplaneItemProb dword 1 (:36930); NOT a play time
  // (the old name was a misread — nothing ever uses it as a clock)
  m_dwArg76 = 0; // +76
}

/** CGameMapTmplList — the "Map/…" templates plus the theme groups. */
export class CGameMapTmplList {
  static ms_pInstance: CGameMapTmplList | null = null;

  m_nMapCount = 0; // +4 (GetMapCount)
  m_apGameMapTmpl: CGameMapTmpl[] = []; // +8 (the tmpl pointers)
  m_apTheme: { strName: string; m_nMaxTeam: number }[] = []; // +1292 (CheckGetThemeIdx)

  constructor() {
    CGameMapTmplList.ms_pInstance = this;
  }

  /** CGameMapTmplList::LoadMapGroupInfo (Attr/MapGroup). */
  LoadMapGroupInfo(groups: Map<string, string[]>): void {
    const cd = new CData();
    if (!cd.Load("Attr/MapGroup")) return;
    const data = cd.GetPtr()!;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let at = 0;
    const decoder = new TextDecoder();
    const groupCount = dv.getUint32(at, true);
    at += 4;
    for (let g = 0; g < groupCount && at + 4 <= data.byteLength; g++) {
      const nameLen = dv.getUint32(at, true);
      at += 4;
      if (nameLen >= 0x80) break;
      const groupName = decoder.decode(data.subarray(at, at + nameLen)).replace(/\0.*$/, "");
      at += nameLen;
      const mapCount = dv.getUint32(at, true);
      at += 4;
      const maps: string[] = [];
      for (let m = 0; m < mapCount && at + 4 <= data.byteLength; m++) {
        const len = dv.getUint32(at, true);
        at += 4;
        if (len >= 0x80) break;
        maps.push(decoder.decode(data.subarray(at, at + len)).replace(/\0.*$/, ""));
        at += len;
      }
      groups.set(groupName, maps);
    }
  }

  /** CGameMapTmplList::CreateTmplList — every "Map/…" entry of the package. */
  CreateTmplList(): void {
    this.m_apGameMapTmpl = [];
    this.m_apTheme = [];
    const groups = new Map<string, string[]>();
    this.LoadMapGroupInfo(groups);
    const fastFile = CIDFMan.ms_pInstance?.m_FastFile;
    if (!fastFile) return;
    for (let i = 0; i < fastFile.GetDataCount(); i++) {
      const name = fastFile.GetDataName(i);
      if (name.slice(0, 4).toLowerCase() !== "map/") continue; // _mbsnbicmp(entry, "Map/", 4)
      const content = fastFile.FFReadFileSize(name)?.buf;
      if (!content) continue;
      const themeIdx = this.CheckGetThemeIdx(name);
      const tmpl = new CGameMapTmpl();
      this.LoadMap(tmpl, name, content, themeIdx, groups);
      // the theme's +12 keeps the widest max team of its maps
      if (themeIdx >= 0) {
        const theme = this.m_apTheme[themeIdx]!;
        if (theme.m_nMaxTeam < tmpl.m_nMaxTeam) theme.m_nMaxTeam = tmpl.m_nMaxTeam;
      }
      tmpl.m_nIdx = this.m_nMapCount++;
      this.m_apGameMapTmpl.push(tmpl);
    }
    if (this.m_nMapCount > 0) console.log(`[GS] Game map template list created.`);
  }

  /** CGameMapTmpl::LoadMap — the template fields straight from the map file. */
  LoadMap(tmpl: CGameMapTmpl, name: string, content: Uint8Array, themeIdx: number, groups: Map<string, string[]>): void {
    tmpl.m_strName = name.slice(4);
    tmpl.m_nThemeIdx = themeIdx;
    tmpl.m_fLadderMap = this.IsMapInGroup("LadderMapGroup", tmpl.m_strName, groups) ? 1 : 0;
    tmpl.m_fPracticeMap = this.IsMapInGroup("PraticeMapGroup", tmpl.m_strName, groups) ? 1 : 0;
    tmpl.m_fReBirthMap = this.IsMapInGroup("ReBirthMapGroup", tmpl.m_strName, groups) ? 1 : 0;
    // +88 = CCRC32::UpdateCRC(0, file, size) over the WHOLE map file
    // (FxServer.exe.c:13710) — packet 109 compares the client's CRC of the
    // same file against this; MSB-first poly 0x04C11DB7, NOT zlib's reflected
    // crc32 (that mismatch tripped the "Hacking suspected: crc mismatch").
    tmpl.m_dwCRC = UpdateCRC32(0, content, 0, content.byteLength) >>> 0;
    const dv = new DataView(content.buffer, content.byteOffset, content.byteLength);
    if (content.byteLength < 8) return;
    const version = dv.getUint32(0, true);
    tmpl.m_nVersion = version < 1000 ? 1000 : version;
    let at = 4;
    if (version < 1000) {
      tmpl.m_nMaxTeam = 8;
      tmpl.m_nOld = 1;
    } else {
      if (at + 16 > content.byteLength) return;
      tmpl.m_nMaxTeam = dv.getUint32(at, true);
      tmpl.m_nOld = dv.getUint32(at + 4, true);
      at += 8;
      at += 8; // dwords 3 and 4 → +40 / +44
    }
    const need = at + 8 * 4 + 4 * 4 + 4;
    if (content.byteLength < need) return;
    tmpl.m_nMaxPlayer = dv.getUint32(at, true);
    tmpl.m_nLevelLimit = dv.getUint32(at + 4, true);
    tmpl.m_nPremiumOnly = dv.getUint32(at + 8, true);
    tmpl.m_nArg60 = dv.getUint32(at + 12, true);
    tmpl.m_nArg64 = dv.getUint32(at + 16, true);
    tmpl.m_dwAirplaneItemProb = dv.getUint32(at + 24, true);
    tmpl.m_dwArg76 = dv.getUint32(at + 28, true);
    tmpl.m_nMissionType = dv.getUint32(at + 32, true);
    tmpl.m_nLapTileCount = dv.getUint32(at + 36, true);
    tmpl.m_nLapTime = dv.getUint32(at + 40, true);
    tmpl.m_nLapBonus = dv.getUint32(at + 44, true);
    tmpl.m_nArg84 = dv.getUint32(at + 48, true);
  }

  /** CGameMapTmplList::CheckGetThemeIdx — "Map/xx_y" has no theme (-1). */
  CheckGetThemeIdx(name: string): number {
    if (name[4] === "_") return -1;
    const themeName = `Theme/${name.slice(4, name.length - 2)}`;
    const at = this.m_apTheme.findIndex((t) => t.strName.toLowerCase() === themeName.toLowerCase());
    if (at >= 0) return at;
    this.m_apTheme.push({ strName: themeName, m_nMaxTeam: 0 });
    return this.m_apTheme.length - 1;
  }

  /** CGameMapTmplList::IsMapInGroup — exact or trailing-'?' wildcard match. */
  IsMapInGroup(groupName: string, mapName: string, groups: Map<string, string[]>): boolean {
    const maps = groups.get(groupName);
    if (!maps) return false;
    const lower = mapName.toLowerCase();
    for (const m of maps) {
      if (m.endsWith("?")) {
        const stem = m.slice(0, -1).toLowerCase();
        if (lower.startsWith(stem)) return true;
      } else if (m.toLowerCase() === lower) {
        return true;
      }
    }
    return false;
  }

  GetMapCount(): number {
    return this.m_nMapCount;
  }

  GetMapMaxPlayer(idx: number): number {
    return this.m_apGameMapTmpl[idx]?.m_nMaxPlayer ?? 0;
  }

  GetMapMaxTeam(idx: number): number {
    return this.m_apGameMapTmpl[idx]?.m_nMaxTeam ?? 0;
  }

  GetMapThemeIdx(idx: number): number {
    return this.m_apGameMapTmpl[idx]?.m_nThemeIdx ?? -1;
  }

  GetMapPremiumOnly(idx: number): number {
    return this.m_apGameMapTmpl[idx]?.m_nPremiumOnly ?? 0;
  }

  IsPracticeMap(idx: number): number {
    return this.m_apGameMapTmpl[idx]?.m_fPracticeMap ?? 0;
  }

  IsMissionMap(idx: number): number {
    return this.m_apGameMapTmpl[idx]?.m_nMissionType ?? 0;
  }

  /** CGameMapTmplList::GetMapLevelLimit — the premium channel discount. */
  GetMapLevelLimit(idx: number): number {
    const limit = this.m_apGameMapTmpl[idx]?.m_nLevelLimit ?? 0;
    return CMainSystem.IsPremiumChannel() ? limit - CMainSystem.ms_pInstance!.m_nPremiumLv : limit;
  }

  /** CGameMapTmplList::GetRandomMapIdx (FxServer.exe.c:14179). */
  GetRandomMapIdx(nPlayers: number, level: number, theme: number, practice: number, gm: number, premiumTicket: number): number {
    if (nPlayers <= 0 || nPlayers > 8 || this.m_nMapCount <= 0) return -1;
    const isLadder = CMainSystem.ms_pInstance!.m_nChannelType === 77;
    const fits: number[] = [];
    for (let i = 0; i < this.m_nMapCount; i++) {
      const tmpl = this.m_apGameMapTmpl[i]!;
      if (tmpl.m_nMaxPlayer < nPlayers) continue;
      if (theme !== -1 && tmpl.m_nThemeIdx !== theme) continue;
      if (isLadder && (tmpl.m_nMissionType > 0 ? 1 : 0) !== 0) continue;
      if (premiumTicket === 0) {
        if (this.GetMapLevelLimit(i) > level) continue;
        if (!CMainSystem.IsPremiumChannel() && tmpl.m_nPremiumOnly === 1) continue;
        if (practice !== 0 && practice !== (tmpl.m_fPracticeMap !== 0 ? 1 : 0)) continue;
      }
      if (gm > tmpl.m_nMaxTeam) continue;
      fits.push(i);
    }
    if (fits.length === 0) return -1;
    return fits[Math.floor(Math.random() * fits.length) % fits.length]!;
  }
}

// ============================ CGameContext / in-play state ============================

/**
 * CBanChief (+12576) — the idle-room start-gate timers
 * (FxServer.exe.lst:401010..401140).  All delays are timeGetTime ticks.
 */
export class CBanChief {
  m_dwCanStartTime = 0; // +4 (SetCanStart)
  m_nCanStart = 0; // +8 (SetCanStart)
  m_nOddSlot = 0; // +12 (SetOddSlot)
  m_dwOddSlotTime = 0; // +16 (SetOddSlot)
  m_nWarnedBan = 0; // +14 (SetWarnedBan)
  m_dwWarnedBanTime = 0; // +18 (SetWarnedBan)
  m_nWarnedBanOdd = 0; // +1C (SetWarnedBanOddSlot)
  m_dwWarnedBanOddTime = 0; // +20 (SetWarnedBanOddSlot)

  /** CBanChief::Init (401101) — SetOddSlot(0) then SetCanStart(0). */
  Init(): void {
    this.SetOddSlot(0);
    this.SetCanStart(0);
  }

  /** CBanChief::SetWarnedBanOddSlot (401010). */
  SetWarnedBanOdd(n: number): void {
    this.m_nWarnedBanOdd = n;
    this.m_dwWarnedBanOddTime = n !== 0 ? CGameClock.Now() : 0;
  }

  /**
   * CBanChief::IsBanChief (40102F) — true once timeGetTime-SetCanStart beats
   * (flag ? 10000 : 20000) × superChief, superChief being the 1/3 flag from
   * "Item/SuperChief".  The middle gameType argument is not read.
   */
  IsBanChief(nFlag: number, _gameType: number, superChief: number): boolean {
    const elapsed = (CGameClock.Now() - this.m_dwCanStartTime) | 0;
    const v = (nFlag !== 0 ? 10000 : 20000) * superChief;
    return elapsed > v;
  }

  /** CBanChief::SetWarnedBan (401065). */
  SetWarnedBan(n: number): void {
    this.m_nWarnedBan = n;
    this.m_dwWarnedBanTime = n !== 0 ? CGameClock.Now() : 0;
  }

  /** CBanChief::GetWarningDelay (401084) — ticks × 10000 (32-bit wrap). */
  GetWarningDelay(ticks: number): number {
    return Math.imul(ticks, 10000) >>> 0;
  }

  /** CBanChief::GetOddSlotInManner (401091) — ticks × 5000 (32-bit wrap). */
  GetOddSlotInManner(ticks: number): number {
    return Math.imul(ticks, 5000) >>> 0;
  }

  /** CBanChief::SetCanStart (4010BB) — also clears both warned states. */
  SetCanStart(n: number): void {
    this.m_nWarnedBan = 0;
    this.m_dwWarnedBanTime = 0;
    this.m_dwCanStartTime = CGameClock.Now();
    this.m_nCanStart = n;
  }

  /** CBanChief::SetOddSlot (4010DA) — clears the odd-slot warned state. */
  SetOddSlot(n: number): void {
    this.m_nOddSlot = n;
    this.m_dwOddSlotTime = n !== 0 ? CGameClock.Now() : 0;
    this.m_nWarnedBanOdd = 0;
    this.m_dwWarnedBanOddTime = 0;
  }
}

/**
 * CDynInfoCalculator — the 0x254-byte statistics block at CGameSession+11684
 * (+0x2DA4).  CDynInfoCalculator::Init runs once per launch (the launch tail
 * of CGameSession::LaunchGameStage); the bomber-event / game-result units
 * then read it to award exp.  All offsets below are calculator relative.
 */
export class CDynInfoCalculator {
  m_nPlayerCount = 0; // +4 (non-empty slots)
  m_dwAvgWeight = 0; // +8 (float: Σ sqrt(level+100) / m_nPlayerCount)
  m_dwColourWeight = new Float32Array(8); // +12 (per-colour average sqrt(level+100))
  m_vtSlotWeight = new Float32Array(8); // +44 (+0x2C, per-slot sqrt(level+100))
  m_nSaveMatrix = new Int32Array(64); // +76 (+0x4C, 8×8 first-save-per-colour marks)
  m_vtKills = new Int32Array(8); // +332 (+0x14C, SetKillerIndex)
  m_vtSaves = new Int32Array(8); // +364 (+0x16C, SetSaverIndex)
  m_nUnk18C = new Int32Array(8); // +396 (+0x18C, zeroed only)
  m_nUnk1AC = new Int32Array(8); // +428 (+0x1AC, zeroed only)
  m_vtColour = new Int32Array(8).fill(-1); // +460 (+0x1CC, slot → colour)
  m_vtColourCount = new Int32Array(8); // +492 (+0x1EC, players per colour)
  m_nUnk20C = new Int32Array(8); // +524 (+0x20C, zeroed only)
  m_nUnk22C = new Int32Array(8); // +556 (+0x22C, zeroed only)
  m_nPremiumFlag = 0; // +588 (+0x24C, IsPremiumRewardCondition bypass — never set in FXGS)
  m_nInvalidGame = 1; // +592 (+0x250, forced 1 by Init; 0 once a second socket is seen)

  /**
   * CDynInfoCalculator::Init (FxServer.exe.lst:40B337) — m_rgPlayer and the
   * slot-state triples (the colour byte lives at slotstate + 3*slot + 2).
   */
  Init(users: (CUser | null)[], slotstates: Uint8Array): void {
    this.m_nInvalidGame = 1; // mov [esi+250h], 1
    this.m_nPremiumFlag = 0;
    this.m_nPlayerCount = 0;
    this.m_dwAvgWeight = 0;
    for (let c = 0; c < MAX_SESSION_SLOTS; c++) {
      this.m_vtColour[c] = -1;
      this.m_vtSlotWeight[c] = 0;
      this.m_vtColourCount[c] = 0;
      this.m_vtSaves[c] = 0; // [eax-80h]
      this.m_vtKills[c] = 0; // [eax-0A0h]
      this.m_nUnk1AC[c] = 0; // [eax-40h]
      this.m_nUnk18C[c] = 0; // [eax-60h]
      this.m_nUnk20C[c] = 0; // [eax+20h]
      this.m_nUnk22C[c] = 0; // [eax+40h]
      this.m_dwColourWeight[c] = 0; // fldz / [eax-1C0h]
    }
    this.m_nSaveMatrix.fill(0); // memset(+4Ch, 0, 0x100)
    let firstSocket: CClientSocket | null = null; // var_C
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      const user = users[slot]!;
      if (user === null) continue;
      if (firstSocket === null) {
        firstSocket = user.m_pSocket;
      } else if (firstSocket !== user.m_pSocket) {
        this.m_nInvalidGame = 0; // and [esi+250h], 0
      }
      this.m_nPlayerCount++;
      const level = user.m_nLevel; // [edi+7C0h]
      this.m_dwAvgWeight += Math.sqrt(level + 100.0); // sqrt ×1 → +8
      const colour = slotstates[3 * slot + 2]! & SLOTSTATE_COLOR_MASK;
      this.m_dwColourWeight[colour] += Math.sqrt(level + 100.0); // sqrt ×2 → +0xC+4*colour
      this.m_vtColourCount[colour]++; // inc [+0x1EC+4*colour]
      this.m_vtSlotWeight[slot] = Math.sqrt(level + 100.0); // sqrt ×3 → +0x2C+4*slot
      this.m_vtColour[slot] = colour; // mov [eax], ecx
    }
    if (this.m_nPlayerCount !== 0) this.m_dwAvgWeight /= this.m_nPlayerCount;
    for (let c = 0; c < MAX_SESSION_SLOTS; c++) {
      if (this.m_vtColourCount[c] !== 0) this.m_dwColourWeight[c] /= this.vtColourCountAt(c);
    }
  }

  private vtColourCountAt(c: number): number {
    return this.m_vtColourCount[c]!;
  }

  /** CDynInfoCalculator::SetKillerIndex (40B1DC) — case 4 of OnSetBomberEvent. */
  SetKillerIndex(killer: number): void {
    this.m_vtKills[killer]!++;
  }

  /**
   * CDynInfoCalculator::SetSaverIndex (40B1EC) — case 3 of OnSetBomberEvent.
   * The first save by colour `saver` sets the 8×8 mark (row `slot`, column
   * `saver`) and bumps that colour's save count.
   */
  SetSaverIndex(slot: number, saver: number): void {
    const i = slot + saver * 8; // lea eax, [edx+esi*8]
    if (this.m_nSaveMatrix[i] === 0) {
      this.m_nSaveMatrix[i] = 1;
      this.m_vtSaves[saver]!++;
    }
  }

  /** CDynInfoCalculator::GetExpPercentage (40B29E) — cur exp ‰ inside its level. */
  static GetExpPercentage(nCur: number): number {
    const level = CDynInfoCalculator_GetLevel(nCur);
    const nMaxExp = CDynInfoCalculator_GetMaxExpInLevel(level);
    const nLowExp = CDynInfoCalculator_GetMaxExpInLevel(level - 1);
    if (nLowExp === 0x7fffffff) return 0;
    return Math.trunc(((nCur - nLowExp) * 1000) / (nMaxExp - nLowExp));
  }

  /** CDynInfoCalculator::IsPremiumRewardCondition (40B2FD). */
  IsPremiumRewardCondition(): boolean {
    if (this.m_nPremiumFlag !== 0) return true;
    return CMainSystem.IsPremiumChannel();
  }

  /** CDynInfoCalculator::GetWinExp (40B4CE) — the winning-slot exp (clamped 50..200). */
  GetWinExp(slot: number, pnRewardFlag: number[]): number {
    pnRewardFlag[0] = 0; // mov [eax], edi (edi = 0)
    if (this.m_nInvalidGame !== 0) return 0;
    const colour = this.m_vtColour[slot]!;
    if (colour < 0 || this.m_vtColourCount[colour] === 0) return 0;
    if (this.m_dwColourWeight[colour] === 0) return 0;
    let t =
      (this.m_nPlayerCount * this.m_dwAvgWeight * 100.0 * this.m_vtColourCount[colour]!) /
      (this.m_vtColourCount[colour]! * this.m_dwColourWeight[colour]!);
    t *= this.m_vtSlotWeight[slot]! / this.m_dwColourWeight[colour]!; // fld [+2C+4n] / colourWeight
    t *= 0.5;
    t += this.m_vtSaves[slot]! * 20.0;
    t += this.m_vtKills[slot]! * 20.0;
    let v = Math.trunc(t);
    if (v < 50) v = 50;
    if (v > 200) v = 200;
    if (this.IsPremiumRewardCondition()) v = Math.trunc((v * 11) / 10);
    return v;
  }

  /** CDynInfoCalculator::GetDrawExp (40B5A0) — the tied-game exp (clamped 0..50). */
  GetDrawExp(slot: number): number {
    if (this.m_nInvalidGame !== 0) return 0;
    const colour = this.m_vtColour[slot]!;
    if (colour < 0 || this.m_vtColourCount[colour] === 0) return 0;
    if (this.m_dwColourWeight[colour] === 0) return 0;
    let t =
      (this.m_nPlayerCount * this.m_dwAvgWeight * 10.0 * this.m_vtColourCount[colour]!) /
      (this.m_vtColourCount[colour]! * this.m_dwColourWeight[colour]!);
    t *= this.m_vtSlotWeight[slot]! / this.m_dwColourWeight[colour]!;
    t *= 0.5;
    t += this.m_vtSaves[slot]! * 20.0;
    t += this.m_vtKills[slot]! * 20.0;
    let v = Math.trunc(t);
    if (v < 0) v = 0;
    if (v > 50) v = 50;
    if (this.IsPremiumRewardCondition()) v = Math.trunc((v * 11) / 10);
    return v;
  }

  /**
   * CDynInfoCalculator::GetKillNSaveExp (40B665) — premium channels only;
   * a bad context logs ReportError("Invalid CDynInfoCalculator context").
   */
  GetKillNSaveExp(slot: number): number {
    if (!CMainSystem.IsPremiumChannel()) return 0;
    if (this.m_nInvalidGame !== 0) {
      console.error("Invalid CDynInfoCalculator context");
      return 0;
    }
    const colour = this.m_vtColour[slot]!;
    if (colour < 0 || this.m_vtColourCount[colour] === 0 || this.m_dwColourWeight[colour] === 0) {
      console.error("Invalid CDynInfoCalculator context");
      return 0;
    }
    let v = Math.trunc(this.m_vtSaves[slot]! * 20.0 + this.m_vtKills[slot]! * 20.0);
    if (v < 0) v = 0;
    if (v > 140) v = 140;
    return v;
  }
}

/**
 * CGameSession::IsSameNumberPerTeam (FxServer.exe.lst:41B044) — every
 * occupied slot's colour must hold players / colours player counts.
 */
function IsSameNumberPerTeam(session: CGameSession): boolean {
  const counts = new Int32Array(8); // var_20 (memset 0x20)
  let teamCount = 0; // edi
  for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
    const user = session.m_rgPlayer[slot]!;
    if (user === null) continue;
    const c = session.GetColor(slot);
    if (++counts[c] === 1) teamCount++;
  }
  if (teamCount < 2) return false;
  for (let c = 0; c < MAX_SESSION_SLOTS; c++) {
    if (counts[c] !== 0 && counts[c] !== Math.trunc(session.m_nCurPlayerNum / teamCount)) return false;
  }
  return true;
}

/**
 * CGameContext — the in-play object state (0x288C bytes at CGameSession+1184;
 * CGameSession::SetCurrentGameContext picks ctx 0).  Field offsets are ctx
 * relative (FxServer.exe.c:41CD9B CGameContext::Init).
 */
export class CGameContext {
  m_rgnTeamScore = new Int32Array(8); // +0 (SetHouseState ++ per color)
  /** +32, 20 bytes per bomb, m_nBombCount entries (ignite refuses >= 150). */
  m_rgBomb: { id: number; fMoving: number; timer: number; x: number; y: number; sub: number; fFlag16: number }[] = [];
  m_nBombCount = 0; // +4812
  m_nBombIdCounter = 0; // +4816 (the per-ignite serial)
  m_nBoxItemCounter = 126; // +4916 (CGameContext::Init; AddBoxItem caps at 250)
  m_rgnBoxItem = new Int32Array(250); // +3032 (0 free / 1 eaten)
  m_rgnObstacle = new Int32Array(195); // +4032, 13 rows × 15 cols (0 free / 1 eaten)
  /** +4820 — per-slot down time (CGameClock::ElapsedTime at the trap/death). */
  m_rgnDownTime = new Int32Array(8);
  /** +4852 — per-slot [E2 x][E2 y] pair written by OnSetBomberEvent case 2. */
  m_rgnDiePos = new Int32Array(16);
  m_rgnBula = new Int32Array(1170); // +4920, 45 × 26 (GetBulaState dword[1230+45x+y]; -1 init)
  m_rgnHouse = new Int32Array(195); // +9600, 15 × 13 (GetHouseState dword[2400+15row+col]; -1 init)

  /** CGameContext::Init (FxServer.exe.c:41CD9B). */
  Init(): void {
    this.m_rgnTeamScore.fill(0);
    this.m_rgBomb = [];
    this.m_nBombCount = 0;
    this.m_nBombIdCounter = 0;
    this.m_rgnBoxItem.fill(0);
    this.m_rgnObstacle.fill(0);
    this.m_nBoxItemCounter = 126;
    this.m_rgnDownTime.fill(0);
    this.m_rgnDiePos.fill(0);
    this.m_rgnBula.fill(-1);
    this.m_rgnHouse.fill(-1);
  }

  /** CGameContext::AddBoxItem — the running box serial, -1 at the 250 cap. */
  AddBoxItem(): number {
    if (this.m_nBoxItemCounter >= 250) return -1;
    return this.m_nBoxItemCounter++;
  }

  /** CGameContext::GetBulaState / SetBulaState (dword[1230 + 45x + y]). */
  GetBulaState(x: number, y: number): number {
    return this.m_rgnBula[45 * x + y]!;
  }
  SetBulaState(x: number, y: number, v: number): void {
    this.m_rgnBula[45 * x + y] = v;
  }

  /** CGameContext::GetHouseState / SetHouseState (dword[2400 + 15row + col]). */
  GetHouseState(row: number, col: number): number {
    return this.m_rgnHouse[15 * row + col]!;
  }
  SetHouseState(row: number, col: number, v: number, color: number): void {
    this.m_rgnHouse[15 * row + col] = v;
    if (color < MAX_SESSION_SLOTS) this.m_rgnTeamScore[color]!++;
  }
}

/** CGameClock (+12732) — StartGame/EndGame/ElapsedTime (FxServer.exe.c:41B843). */
export class CGameClock {
  m_dwSuspended = 0; // +0 (ResumeGame adds the suspend gap here)
  m_dwStartTime = 0; // +4
  m_dwEndTime = 0; // +8
  m_dwSuspendAt = 0; // +12

  static Now(): number {
    return Date.now() & 0xffffffff;
  }

  StartGame(): void {
    this.m_dwSuspended = 0;
    this.m_dwEndTime = 0;
    this.m_dwStartTime = CGameClock.Now();
  }

  EndGame(): void {
    this.m_dwEndTime = CGameClock.Now();
  }

  /** CGameClock::SuspendGame / ResumeGame. */
  SuspendGame(): void {
    if (this.m_dwSuspendAt !== 0) {
      console.error("[GS] Mismatch suspend/resume game clock (suspend)");
      this.ResumeGame();
    }
    this.m_dwSuspendAt = CGameClock.Now();
  }

  ResumeGame(): void {
    if (this.m_dwSuspendAt !== 0) {
      const gap = (CGameClock.Now() - this.m_dwSuspendAt) >>> 0;
      this.m_dwSuspendAt = 0;
      this.m_dwSuspended = (this.m_dwSuspended + gap) >>> 0;
    } else {
      console.error("[GS] Mismatch suspend/resume game clock (resume)");
    }
  }

  ElapsedTime(): number {
    return (CGameClock.Now() - this.m_dwStartTime) >>> 0;
  }
}

/**
 * CSyncGameObjMan (+12788) — the synchronized-object ownership table.
 * A map objId → slot plus one per-slot set (FxServer.exe.c:415451).
 */
export class CSyncGameObjMan {
  m_mapObj = new Map<number, number>(); // +0 objId → slotidx
  m_rgSetObj: Set<number>[] = [0, 1, 2, 3, 4, 5, 6, 7].map(() => new Set<number>()); // +44
  m_pGameSession: CGameSession | null = null; // +140 (dword 35)
  m_nNextObjId = -1; // +144 (dword 36; ctor -1, Init 0)
  m_dwLastCreateTime = 0; // +148 (dword 37)

  /** CSyncGameObjMan::Init. */
  Init(session: CGameSession): void {
    for (const set of this.m_rgSetObj) set.clear();
    this.m_mapObj.clear();
    this.m_pGameSession = session;
    this.m_nNextObjId = 0;
    this.m_dwLastCreateTime = 0;
  }

  /** CSyncGameObjMan::OnGameEnd — drop the next-object id back to -1. */
  OnGameEnd(): void {
    this.m_nNextObjId = -1;
  }

  /** CSyncGameObjMan::Delegate — record objId under the owning slot. */
  Delegate(objId: number, slot: number): void {
    this.m_rgSetObj[slot]!.add(objId);
    this.m_mapObj.set(objId, slot);
  }

  /** CSyncGameObjMan::FindMinimumLoadSlotIdx — the socket-chief slot with the least objs. */
  FindMinimumLoadSlotIdx(): number {
    if (!this.m_pGameSession) {
      console.error("[GS] [CSyncGameObjMan::FindMinimumSlotIdx] m_pGameSession is NULL");
      return -1;
    }
    let best = -1;
    let bestLoad = 0x80000000;
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      const user = this.m_pGameSession.m_rgPlayer[slot];
      if (user && user.GetSelfidx() === 0 && this.m_rgSetObj[slot]!.size < bestLoad) {
        bestLoad = this.m_rgSetObj[slot]!.size;
        best = slot;
      }
    }
    if (best === -1) console.error("[GS] No player here??? .\\SyncGameObjMan.cpp(55)");
    return best;
  }

  /** CSyncGameObjMan::SetInitialObjNo — the initial 175s (tmpl+84 objects). */
  SetInitialObjNo(n: number): void {
    if (!this.m_pGameSession) {
      console.error("[GS] [CSyncGameObjMan::SetInitialObjNo] m_pGameSession is NULL");
      return;
    }
    this.m_nNextObjId = 0;
    for (let id = 0; id < n; id++) {
      const slot = this.FindMinimumLoadSlotIdx();
      if (slot === -1) {
        console.error(`[GS] FindMinimumLadSlotIdx returned -1 on Object id ${id}`);
        continue;
      }
      this.Delegate(id, slot);
      const packet = new CSendPacket(GS_ClientSend.OnObjInitial, CipherDegree.kPacketEncryptedCRC8);
      packet.Encode2(id);
      packet.Encode1(slot);
      this.m_pGameSession.SendPacket(packet);
      this.m_nNextObjId++;
    }
  }

  /** CSyncGameObjMan::OnReqCreateObj — packet 158 → 174. */
  OnReqCreateObj(n: CReceivedPacket, _socket: CClientSocket): void {
    const session = this.m_pGameSession;
    if (!session) {
      console.error("[GS] [CSyncGameObjMan::OnReqCreateObj] m_pGameSession is NULL");
      return;
    }
    const elapsed = (session.m_GameClock.ElapsedTime() - session.m_GameClock.m_dwSuspended) >>> 0;
    if (elapsed < this.m_dwLastCreateTime + 5000) return;
    this.m_dwLastCreateTime = elapsed;
    const objType = n.Decode2();
    const buf = new Uint8Array(20);
    n.DecodeBufferAt(n.m_uOffset, buf, 20);
    n.m_uOffset += 20;
    const objId = this.m_nNextObjId;
    this.m_nNextObjId = objId + 1;
    const slot = this.FindMinimumLoadSlotIdx();
    if (slot === -1) {
      console.error("[GS] CSyncGameObjMan::OnReqCreateObj, FindMinimumLoadSlotIdx returned -1, cannot create obj");
      return;
    }
    this.Delegate(objId, slot);
    const packet = new CSendPacket(GS_ClientSend.OnObjCreate, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode2(objId);
    packet.Encode1(slot);
    packet.Encode2(objType);
    packet.EncodeBuffer(buf, 20);
    session.SendPacket(packet);
  }

  /** CSyncGameObjMan::OnReqDestroyObj — packet 159 → 176. */
  OnReqDestroyObj(n: CReceivedPacket, _socket: CClientSocket): void {
    const session = this.m_pGameSession;
    if (!session) {
      console.error("[GS] [CSyncGameObjMan::OnReqDestroyObj] m_pGameSession is NULL");
      return;
    }
    const objId = n.Decode2();
    if (!this.m_mapObj.has(objId)) return;
    const crc = n.Decode4();
    for (const set of this.m_rgSetObj) set.delete(objId);
    this.m_mapObj.delete(objId);
    const packet = new CSendPacket(GS_ClientSend.OnObjDestroy, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode2(objId);
    packet.Encode4(crc);
    session.SendPacket(packet);
  }

  /** CSyncGameObjMan::OnPlayerLeave — the leaver's objects vanish as 176 [E2 id][E4 0]. */
  OnPlayerLeave(slot: number): void {
    if (this.m_nNextObjId === -1) return;
    const session = this.m_pGameSession;
    if (!session) {
      console.error("[GS] [CSyncGameObjMan::OnPlayerLeave] m_pGameSession is NULL");
      return;
    }
    if (slot >= MAX_SESSION_SLOTS) {
      console.error(`[GS] .\\SyncGameObjMan.cpp(99) : Invalid slotidx, ${slot}`);
      return;
    }
    if (session.m_nCurPlayerNum !== 0) {
      for (const objId of [...this.m_rgSetObj[slot]!]) {
        if (!this.m_mapObj.has(objId)) {
          console.error(`[GS] Player has invalid obj, objId = ${objId}, session idx = ${session.m_nIdx}`);
        } else {
          this.m_mapObj.delete(objId);
        }
        const packet = new CSendPacket(GS_ClientSend.OnObjDestroy, CipherDegree.kPacketEncryptedCRC8);
        packet.Encode2(objId);
        packet.Encode4(0);
        session.SendPacket(packet);
      }
      this.m_rgSetObj[slot]!.clear();
    }
  }
}

/**
 * CUdpLossRegulator (+12280) — the per-pair UDP-loss matrix.  Only the
 * matrix state and packet 187 live here; DeferRegulateConnection belongs
 * to the game-tick unit (FxServer.exe.c:26020).
 */
export class CUdpLossRegulator {
  m_fInit = 0; // +4
  m_dwInitTime = 0; // +8
  m_rgLoss = new Uint8Array(64); // +12, [8 * mySlot + targetSlot]

  /** CUdpLossRegulator::Init. */
  Init(): void {
    this.m_fInit = 0;
    this.m_dwInitTime = 0;
    this.m_rgLoss.fill(0);
  }

  /** CUdpLossRegulator::OnNotifyUdpLoss — packet 187. */
  OnNotifyUdpLoss(n: CReceivedPacket, socket: CClientSocket): void {
    if (this.m_fInit === 0) {
      this.m_fInit = 1;
      this.m_dwInitTime = CGameClock.Now();
    }
    const target = n.Decode1();
    if (target >= MAX_SESSION_SLOTS) return;
    const count = socket.GetUserCount();
    for (let i = 0; i < count; i++) {
      const user = socket.GetUser(i);
      if (!user) continue;
      const slot = user.m_nSlotIdx;
      if (slot < MAX_SESSION_SLOTS) this.m_rgLoss[8 * slot + target] = 1;
    }
  }

  /** CUdpLossRegulator::DeferRegulateConnection (416595) — 8 s after the first 187. */
  DeferRegulateConnection(session: CGameSession): void {
    if (this.m_fInit !== 0 && CGameClock.Now() - this.m_dwInitTime > UDP_REGULATE_DELAY) this.RegulateConnection(session);
  }

  /**
   * CUdpLossRegulator::RegulateConnection (4160D3) — kick the peer with the
   * most loss reports (ties: the fewest self reports), then reset.
   */
  RegulateConnection(session: CGameSession): void {
    const valid = new Int32Array(8);
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      const user = session.m_rgPlayer[slot];
      if (user && user.m_pSocket?.GetUser(0) === user) valid[slot] = 1;
    }
    for (;;) {
      const cnt = new Int32Array(8);
      const both = new Int32Array(8);
      for (let a = 0; a < MAX_SESSION_SLOTS; a++) {
        if (!valid[a] || !session.m_rgPlayer[a]) continue;
        for (let k = 0; k < MAX_SESSION_SLOTS; k++) {
          if (valid[k] && session.m_rgPlayer[k] && this.m_rgLoss[8 * a + k]! !== 0) {
            cnt[a]++;
            both[a]++;
            both[k]++;
          }
        }
      }
      let best = -1;
      let bestBoth = 0;
      let bestCnt = 0x7fffffff;
      for (let m = 0; m < MAX_SESSION_SLOTS; m++) {
        if (!valid[m]) continue;
        if (both[m]! > bestBoth || (both[m] === bestBoth && bestCnt > cnt[m]!)) {
          bestCnt = cnt[m]!;
          best = m;
          bestBoth = both[m]!;
        }
      }
      if (best === -1 || bestBoth === 0) break; // nothing reported → stop
      for (let k = 0; k < MAX_SESSION_SLOTS; k++) {
        this.m_rgLoss[8 * best + k] = 0; // the row
        this.m_rgLoss[8 * k + best] = 0; // the column
      }
      const user = session.m_rgPlayer[best]!;
      const ip = user.m_pSocket ? GetInfoStr(user.m_pSocket) : "";
      console.error(
        `[GS] User[${ip}:${user.GetName()}] (${user.m_pSocket?.GetUserCount() ?? 0}P) banned from game session (${session.m_nIdx}) while <PLAYING> by udp loss`,
      );
      CGameSessionTable.ms_pInstance!.DestroyPlayer(user.m_pSocket!, 0);
      if (user.m_nFree === 0) {
        // [user+7A4] != 0 and [socket+244] == 0 — +244 is the IO-layer detach
        // flag that FXGS logic never sets, so the port uses the connected flag
        const socket = user.m_pSocket;
        if (socket && socket.m_bConnected) {
          socket.SendPacket(new CSendPacket(GS_ClientSend.OnUdpLossBan, CipherDegree.kPacketEncryptedCRC8)); // 195, no payload
          socket.m_nPoolType = 4; // [socket+1D4]
        }
      }
    }
    this.m_fInit = 0;
    this.m_dwInitTime = 0;
    this.m_rgLoss.fill(0);
  }
}

// ============================ CGameSession ============================

/**
 * CGameSession — one game room (CBaseSession + CListSession + CGameSession,
 * 0x31DC bytes in the original).  The three originals are folded together
 * because every CGameSession virtual is either a CListSession body or one of
 * the empty CGameSessionStrategy thunks (FxServer.exe.lst:79685+).  Fields
 * carry the original struct offsets.
 */
export class CGameSession {
  static ms_ulSerialNo = 0; // CBaseSession::ms_ulSerialNo

  m_strName = ""; // CNamedObject (the room title)
  m_setSocket = new Set<CClientSocket>(); // +128
  fValid = 0; // +140 (CBaseSession::Init sets 1, Destroy clears it)
  m_nIdx = 0; // +144 (u16, GetIdx)
  m_nSerialNo = 0; // +148 (Init: ++ms_ulSerialNo)
  m_rgPlayer: (CUser | null)[] = new Array(8).fill(null); // +20
  m_nMaxSlot = 8; // +16 (the ctor argument)
  m_rgSlotState = new Uint8Array(24); // +68, 3 bytes per slot (cleared by Init)
  m_rgVoteMatrix = new Int32Array(64); // +152 ([8][8], 48-byte stride)
  m_nChiefSwapCount = 0; // +728 (u16; >= 10000 = supreme room)
  m_rgVote = new Int32Array(8); // +780 (0 none, 1 asked, 2 yes, 3 no)
  m_nBanSerial = 0; // +828
  m_nCurPlayerNum = 0; // +832 (byte)
  m_nMaxPlayerNum = 8; // +833 (byte)
  m_szPassword = ""; // +834 (char array, DoJoinSession compares it)
  m_nLevelLimit = 0; // +840
  m_nGameType = 0; // +844 (CGameSession::Init writes it)
  m_fHasPassword = 0; // +848 (byte; set when the password is non-empty)
  m_nMapIdx = -1; // +850 (u16; -1 = random, -2-theme = theme random)
  m_fPlaying = 0; // +852
  m_fModified = 0; // +856 (1 playing / 2 map / 4 cur / 8 max / 0x10 title)
  m_dwCreateTime = 0; // +860 (timeGetTime)
  m_nChiefSlotidx = -2; // +864
  m_fSupreme = 0; // +868 (SetChiefSlotidx: NextChiefSlot == -2)
  m_nGameTypeMod = 0; // +948 (SendGameTypeMod 1 / SendGameTypeNormal 0)
  m_MissionInfo = new Int32Array(4); // +12748 (MissionInfo::operator= ← tmpl+108..+120 at LaunchGameStage)
  m_nGameMapIdx = -1; // +1180 (SetMapIdxPlayingByLevel result)
  m_nGamePhase = 0; // +984 (0 wait / 1 in-play / 2 ended; DoStartGame 1, SendGameResult→2, DoReturnPrepareStage 0)
  m_aBomberIdx = new Int32Array(8).fill(-1); // +11572
  m_abDeleted = new Uint8Array(8); // +11604 (0 alive; 1 dead / 2 goal / 3 trap / 5 lap finish / 6 win / 7 draw)
  m_rgnUsedItem = new Int32Array(8); // +11652 (a special item was used this game)
  m_rgnShopItem = new Int32Array(8); // +12112 (a shop item was used this game)  /** +12632/+12636 — per-slot {time, rank} lap pairs (LaunchGameStage fills -1). */
  m_rgLapTime = new Int32Array(16).fill(-1);
  m_rgLapRank = new Int32Array(16).fill(-1);
  m_rgLapCount = new Int32Array(8); // +12696 (per-slot lap byte)
  /** +12940 — the UDP-alive flags (OnUDPPeerInfo sets, DestroyPlayer clears). */
  m_rgUdpAlive = new Uint8Array(8);
  /** +12948 — the per-slot join times (CGameSession::AddUser; the UDP sweep reads them). */
  m_rgJoinTime = new Int32Array(8);
  /** +988 — per-slot UDP peer hosts (3 × {ip dword, port u16, pad}); the UDP unit reads these. */
  m_rgUdpHost: Uint8Array[] = [0, 1, 2, 3, 4, 5, 6, 7].map(() => new Uint8Array(24));
  m_dwStartSeed = 0; // +12736 (the DoStartGame seed dword)
  m_BanChief = new CBanChief(); // +12576 (the idle-room start gate)
  m_nObj0 = -1; // +11612
  m_nObj1 = -1; // +11616
  /** +12016/+12048/+12208/+12240 — the four dword arrays GetWinGameResult,
   *  GetGameDetailResult and SendGameResult read.  No FXGS code writes any of
   *  them (lst: 2EF0h/2F10h/2FB0h/2FD0h appear only as reads), so they stay 0
   *  for the server's lifetime; the client-visible result bytes still flow
   *  through their comparisons. */
  m_rgColourCount = new Int32Array(8); // +12016 (GetGameDetailResult's D; SendGameResult encode 3)
  m_rgWinDetailB = new Int32Array(8); // +12048 (SendGameResult encode 2)
  m_rgDetailCount = new Int32Array(8); // +12208 (GetWinGameResult's expected-finish count)
  m_rgWinDetailA = new Int32Array(8); // +12240 (GetGameDetailResult's A)
  m_nBombTickTime = 0; // +12552 (the last bomb-tick time)
  m_dwLastTickTime = 0; // +12548 (Update's per-tick timeGetTime marker)
  m_nGameType100 = 0; // +12728 (tmpl+100 at DoStartGame)
  m_GameClock = new CGameClock(); // +12732
  m_UdpLossRegulator = new CUdpLossRegulator(); // +12280
  m_DynInfoCalculator = new CDynInfoCalculator(); // +11684 (the results unit)
  m_fSkipExpReward = 0; // +12276 (SendGameResult/DeleteUser: nonzero skips every exp reward; nothing writes it)
  m_dwPremiumFlag = 0; // +12272 (SendGameResult's per-user premium dword, user+2004 == 1)

  m_SyncGameObjMan = new CSyncGameObjMan(); // +12788
  m_pCtx = new CGameContext(); // +1184 (SetCurrentGameContext(0))
  m_nGameVersion = 0; // +12568 (rand at Init)
  m_nGameSerial = 0; // +12572 (the session serial copy)
  m_dwLaunchTime = 0; // +12556 (timeGetTime at launch)
  m_nGhostStart = 0; // +12560 (tmpl+60 s at LaunchGameStage; ×1000 ms at DoStartGame)
  m_nGhostFreq = 0; // +12564 (tmpl+64 s; ×1000 ms at DoStartGame)
  m_dwLastGhostTime = 0; // +940
  m_nGhostCount = 0; // +936
  m_rgSlotGhost = new Int32Array(8).fill(-1); // +872 slot → ghost idx
  m_rgGhostSlot = new Int32Array(8).fill(-1); // +904 ghost idx → slot
  m_abCaptain = new Int32Array(8); // +952 (CheckIsCaptain's cache)
  m_dwLastAirplaneTime = 0; // +12624 (dword 3156)
  m_dwAirplaneItemProb = 0; // +12776 ← tmpl+72 (SendAirplaneItemProb dword 1)
  m_dwArg76 = 0; // +12780 (tmpl+76)

  /** CBaseSession::Init — CListSession::Init / CGameSession::Init heads. */
  Init(title: string | null, password: string | null, gameType?: number): void {
    this.fValid = 1;
    CGameSession.ms_ulSerialNo++;
    this.m_nSerialNo = CGameSession.ms_ulSerialNo >>> 0;
    this.m_strName = title ?? "";
    this.m_rgPlayer.fill(null);
    this.m_rgSlotState.fill(0);
    if (gameType !== undefined) {
      this.m_szPassword = password ?? "";
      this.m_fHasPassword = this.m_szPassword.length > 0 ? 1 : 0;
      this.m_nMapIdx = -1;
      this.m_nCurPlayerNum = 0;
      this.m_nMaxPlayerNum = this.m_nMaxSlot;
      this.m_fPlaying = 0;
      this.m_fModified = 0;
      this.m_dwCreateTime = Date.now() & 0xffffffff;
      // ---- CGameSession::Init tail (FxServer.exe.c:31752) ----
      this.m_nGamePhase = 0; // +984
      for (const host of this.m_rgUdpHost) host.fill(0); // memset(+988, 0, 0xC0)
      this.m_nGameMapIdx = -1; // +295
      this.m_nGameType = gameType; // +211
      this.m_nGameVersion = Math.floor(Math.random() * 0x7fffffff); // +3142
      this.m_nGameSerial = this.m_nSerialNo; // +3143
      this.m_aBomberIdx.fill(-1); // memset(+11572, -1, 0x20)
      this.m_nGameTypeMod = 0; // +948
      this.m_abCaptain.fill(0); // memset(+952, 0, 0x20)
      this.m_nGhostCount = 0; // +936
      this.m_rgSlotGhost.fill(-1); // memset(+872, -1, 0x20)
      this.m_rgGhostSlot.fill(-1); // memset(+904, -1, 0x20)
    }
  }

  /** CGameSession::Create — CListSession::Init + AddPlayer + InitBangPok. */
  Create(socket: CClientSocket, title: string, password: string, selects: number[], gameType: number): void {
    this.Init(title, password, gameType);
    this.AddPlayerList(socket, selects); // vtbl+24 = CListSession::AddPlayer
    this.m_fModified = 0;
    this.InitBangPok(socket);
  }

  GetName(): string {
    return this.m_strName;
  }

  hasPassword(): boolean {
    return this.m_fHasPassword !== 0;
  }

  // ---- slot-state helpers (the 3-byte records at +68) ----
  // byte0: 0x01 closed / 0x02 chief / 0x1C the ready group (0x04 ready)
  // byte1: 0x3F bomber select, byte2: 0x1F team color

  IsClosed(slot: number): boolean {
    return (this.m_rgSlotState[slot * 3]! & 1) !== 0;
  }

  SetClosed(slot: number, closed: boolean): void {
    const p = slot * 3;
    this.m_rgSlotState[p] = closed ? (this.m_rgSlotState[p]! | 1) : (this.m_rgSlotState[p]! & 0xfe);
  }

  IsReady(slot: number): boolean {
    return (this.m_rgSlotState[slot * 3]! & 0x04) !== 0;
  }

  /** CanStartGame's stand-by probe — the whole 0x1C group. */
  GetReadyGroup(slot: number): number {
    return this.m_rgSlotState[slot * 3]! & SLOTSTATE_GROUP_MASK;
  }

  GetColor(slot: number): number {
    return this.m_rgSlotState[slot * 3 + 2]! & SLOTSTATE_COLOR_MASK;
  }

  SetColor(slot: number, color: number): void {
    const p = slot * 3 + 2;
    this.m_rgSlotState[p] = (this.m_rgSlotState[p]! & SLOTSTATE_COLOR_CLEAR) | (color & SLOTSTATE_COLOR_MASK);
  }

  GetBomber(slot: number): number {
    return this.m_rgSlotState[slot * 3 + 1]! & SLOTSTATE_BOMBER_MASK;
  }

  SetBomber(slot: number, bomber: number): void {
    const p = slot * 3 + 1;
    this.m_rgSlotState[p] = (this.m_rgSlotState[p]! & SLOTSTATE_BOMBER_CLEAR) | (bomber & SLOTSTATE_BOMBER_MASK);
  }

  // ---- CBaseSession slot bookkeeping ----

  /** CBaseSession::IsEmptySlot — nobody seated and the slot open. */
  IsEmptySlot(slot: number): boolean {
    return this.m_rgPlayer[slot] === null && !this.IsClosed(slot);
  }

  IsNullSlot(slot: number): boolean {
    return this.m_rgPlayer[slot] === null;
  }

  /** IsPlayerSet (vtbl+184) — CGameSession also counts practice occupants. */
  IsPlayerSet(slot: number): boolean {
    return this.m_rgPlayer[slot] !== null;
  }

  GetEmptySlotCount(): number {
    let n = 0;
    for (let i = 0; i < this.m_nMaxSlot; i++) if (this.IsEmptySlot(i)) n++;
    return n;
  }

  GetNullSlotCount(): number {
    let n = 0;
    for (let i = 0; i < this.m_nMaxSlot; i++) if (this.IsNullSlot(i)) n++;
    return n;
  }

  GetEmptySlot(): number {
    for (let i = 0; i < this.m_nMaxSlot; i++) if (this.IsEmptySlot(i)) return i;
    return -1;
  }

  GetNullSlot(): number {
    for (let i = 0; i < this.m_nMaxSlot; i++) if (this.IsNullSlot(i)) return i;
    return -1;
  }

  /** CBaseSession::GetSlotidx — the user's +490. */
  GetSlotidx(user: CUser | null): number {
    return user ? user.m_nSlotIdx : -1;
  }

  /** CBaseSession::SetSlotidx. */
  SetSlotidx(user: CUser | null, slot: number): void {
    if (user) user.m_nSlotIdx = slot;
  }

  /** CBaseSession::CheckValidPlayer (vtbl+96). */
  CheckValidPlayer(user: CUser | null): boolean {
    const slot = this.GetSlotidx(user);
    return slot >= 0 && slot < this.m_nMaxSlot && this.m_rgPlayer[slot] === user;
  }

  /** CBaseSession::CheckValidSocket (vtbl+100). */
  CheckValidSocket(socket: CClientSocket): boolean {
    const n = socket.GetUserCount();
    if (n <= 0) return false;
    for (let i = 0; i < n; i++) {
      if (!this.CheckValidPlayer(socket.GetUser(i))) return false;
    }
    return true;
  }

  // ---- sending ----

  /** CBaseSession::SendPacket — every socket of the room. */
  SendPacket(packet: CSendPacket): void {
    for (const socket of this.m_setSocket) socket.SendPacket(packet);
  }

  /** CBaseSession::SendPacketExclude. */
  SendPacketExclude(packet: CSendPacket, except: CClientSocket): void {
    for (const socket of this.m_setSocket) {
      if (socket !== except) socket.SendPacket(packet);
    }
  }

  /** CBaseSession::PutPacket — queue for everyone (optionally minus one). */
  PutPacket(packet: CSendPacket, except: CClientSocket | null = null): void {
    for (const socket of this.m_setSocket) {
      if (socket !== except) socket.QueuePacket(packet);
    }
  }

  /** CBaseSession::FlushPacket — drain the queues, close dead sockets. */
  FlushPacket(): void {
    for (const socket of [...this.m_setSocket]) {
      if (socket.m_bConnected) socket.FlushPendingPackets();
      else {
        console.error(`[GS] Not connected socket (${socket.GetUser(0)?.GetName() ?? "NULL"}) in game session. Post Close Packet.`);
        socket.PostClosePacket();
      }
    }
  }

  // ---- the 105/106/107/112 makers ----

  /** CBaseSession::MakeSetSlotStatePacket — 107 [E1 slot][EBuffer 3]. */
  MakeSetSlotStatePacket(slot: number, packet: CSendPacket): void {
    packet.InitPacket(GS_ClientSend.OnSetSlotState);
    packet.Encode1(slot);
    packet.EncodeBuffer(this.m_rgSlotState.subarray(slot * 3, slot * 3 + 3));
  }

  /** CBaseSession::MakeSlotAccessoryPacket — the tail of packet 105. */
  MakeSlotAccessoryPacket(slot: number, packet: CSendPacket): void {
    const user = this.m_rgPlayer[slot]!;
    let n9 = 0;
    for (let i = 0; i < 9; i++) if (user.GetSlotDecorationLoaded(i)) n9++;
    packet.Encode1(n9);
    if (n9 > 0) {
      packet.Encode1(slot);
      for (let i = 0; i < 9; i++) {
        const deco = user.GetSlotDecorationLoaded(i);
        if (deco) {
          packet.Encode1(i);
          packet.Encode2(deco.nAttr1 & 0xffff); // UserInventory+24
        }
      }
    }
    let n5 = 0;
    for (let i = 0; i < 5; i++) if (user.GetCharDecoLoaded(i)) n5++;
    packet.Encode1(n5);
    if (n5 > 0) {
      packet.Encode1(slot);
      for (let i = 0; i < 5; i++) {
        const deco = user.GetCharDecoLoaded(i);
        if (deco) {
          packet.Encode4(deco.nAttr1); // UserInventory+24
          packet.Encode4(deco.nAttr2); // +28
          packet.Encode4(deco.nAttr3); // +32
        }
      }
    }
    const loaded14 = user.GetInventoryLoaded(14);
    packet.Encode4(loaded14 ? loaded14.nAttr3 : 0); // UserInventory+32
  }

  /** CBaseSession::MakeSetPlayerPacket — 105 [slot][serial][self][community]
   *  [deco?][state 3B][simple info][accessory]. */
  MakeSetPlayerPacket(slot: number, fSelf: number, packet: CSendPacket): void {
    const user = this.m_rgPlayer[slot];
    if (!user) return;
    packet.InitPacket(GS_ClientSend.OnSetPlayer);
    packet.Encode1(slot);
    packet.Encode4(user.GetGlobalSerialNo());
    packet.Encode1(fSelf);
    packet.Encode1(user.account.CommunitySvr);
    if (fSelf !== 0) {
      const deco = user.GetInventoryLoaded(4);
      packet.Encode1(deco ? deco.nAttr1 & 0xff : 255); // UserInventory+24
    }
    packet.EncodeBuffer(this.m_rgSlotState.subarray(slot * 3, slot * 3 + 3));
    user.AppendSimpleInfoPacket(packet);
    this.MakeSlotAccessoryPacket(slot, packet);
  }

  /** CBaseSession::MakeSessionInfoPacket — 105/107 for every slot. */
  MakeSessionInfoPacket(socket: CClientSocket): void {
    const packet = new CSendPacket(0, CipherDegree.kPacketEncryptedCRC8);
    for (let slot = 0; slot < this.m_nMaxSlot; slot++) {
      if (this.m_rgPlayer[slot]) this.MakeSetPlayerPacket(slot, socket === this.m_rgPlayer[slot]!.m_pSocket ? 1 : 0, packet);
      else this.MakeSetSlotStatePacket(slot, packet);
      socket.QueuePacket(packet);
    }
  }

  /** CBaseSession::SendSessionInfoPacket / CGameSession override
   *  (FxServer.exe.c:41AF87) — 105s + 112 + the strategy's SendSessionInfo +
   *  a second PutPacket of the same buffer.  The base strategy's
   *  SendSessionInfo is a bare `retn 4` (FxServer.exe.lst:4216EF), so on a
   *  normal channel the buffer still holds the 112 and the second PutPacket
   *  sends it AGAIN — the original client receives two consecutive 112s.
   *  The type-77 guild strategy rewrites the buffer as packet 88
   *  (EncodeGuildSessionInfo) and broadcasts it; the guild-channel session
   *  state is not modeled yet. */
  SendSessionInfoPacket(socket: CClientSocket): void {
    this.MakeSessionInfoPacket(socket);
    const packet = new CSendPacket(GS_ClientSend.OnSessionMapIdx, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode2(this.m_nMapIdx & 0xffff);
    socket.QueuePacket(packet);
    if (CMainSystem.ms_pInstance!.m_nChannelType === 77) {
      console.error("[GS] CGuildSessionStrategy::SendSessionInfo (packet 88) is not implemented");
    } else {
      socket.QueuePacket(packet); // the original's second PutPacket — 112 twice
    }
    socket.FlushPendingPackets();
  }

  /** CBaseSession::SendJoinPacket — build the newcomer's self-view 105
   *  (fSelf=1, so the category-4 deco byte rides along) and PutPacket it to
   *  every room socket EXCEPT the joiner (CBaseSession::PutPacket skips the
   *  excluded socket,
   *  FxServer.exe.c:30670-30686) — this is how the seated players see the
   *  joiner.  The joiner got the full roster from SendSessionInfoPacket
   *  (vtbl+80) already.  FlushPacket drains the whole room either way
   *  (FxServer.exe.c:30926 LABEL_4). */
  SendJoinPacket(socket: CClientSocket): void {
    const packet = new CSendPacket(0, CipherDegree.kPacketEncryptedCRC8);
    const n = socket.GetUserCount();
    if (n <= 0) {
      this.FlushPacket();
      return;
    }
    for (let i = 0; i < n; i++) {
      const user = socket.GetUser(i);
      if (!this.CheckValidPlayer(user)) {
        console.error(`[GS] Wrong session player send session packet(SendJoinPacket). Disconnect user[${user?.GetName() ?? "NULL"}].`);
        socket.PostClosePacket();
        return;
      }
      this.MakeSetPlayerPacket(this.GetSlotidx(user), 1, packet);
      this.PutPacket(packet, socket);
    }
    this.FlushPacket();
  }

  /** CBaseSession::SendResetPlayer — 106 for the leaver's users. */
  SendResetPlayer(socket: CClientSocket, fSendReset: number): void {
    const packet = new CSendPacket(0, CipherDegree.kPacketEncryptedCRC8);
    const n = socket.GetUserCount();
    for (let i = 0; i < n; i++) {
      const user = socket.GetUser(i);
      if (user && this.GetSlotidx(user) >= 0) {
        packet.InitPacket(GS_ClientSend.OnResetPlayer);
        packet.Encode1(this.GetSlotidx(user));
        packet.Encode4(user.GetGlobalSerialNo());
        this.PutPacket(packet);
      }
    }
    if (fSendReset !== 0) socket.SendPacket(packet);
    this.FlushPacket();
  }

  // ---- seating ----

  /** CGameSession::GetColorForNewComer (FxServer.exe.c:32760). */
  GetColorForNewComer(slot: number): number {
    const counts = new Int32Array(8);
    let used = 0;
    for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
      if (this.m_rgPlayer[i]) {
        if (++counts[this.GetColor(i)]! === 1) used++;
      }
    }
    const want = slot % 8;
    if (used > 1) {
      let best = -1;
      let bestCount = 8;
      for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
        if (counts[i]! !== 0 && counts[i]! < bestCount) {
          bestCount = counts[i]!;
          best = i;
        }
      }
      if (best >= 0) return best;
      return want;
    }
    if (used === 1) {
      const mapIdx = this.m_nMapIdx;
      let teams: number;
      if (mapIdx === -1) teams = 0;
      else if (mapIdx < 0) teams = CGameMapTmplList.ms_pInstance?.m_apTheme[321 - mapIdx]?.m_nMaxTeam ?? 0;
      else teams = CGameMapTmplList.ms_pInstance?.GetMapMaxTeam(mapIdx) ?? 0;
      if (teams < 2 || teams > 4) {
        if (counts[want]! > 0) return want === 0 ? 1 : 0;
      } else if (counts[0]! <= 0) {
        return 0;
      } else {
        return 3;
      }
    }
    return want;
  }

  /** CBaseSession::AddUser(slot, user, bomber, color) + the CListSession tail. */
  AddUser(slot: number, user: CUser, bomber: number, color: number): void {
    if (this.m_rgPlayer[slot]) {
      console.error("[GS] m_rgPlayer[slotidx], CBaseSession::AddUser(int slotidx, CUser* pUser), not return");
      return;
    }
    this.m_rgPlayer[slot] = user;
    user.SetSessionIdx(this.m_nIdx);
    user.SetSessionSerialNo(this.m_nSerialNo);
    this.SetSlotidx(user, slot);
    user.SetPoolType(2); // user->socket +468 = 2
    const p = slot * 3;
    this.m_rgSlotState[p + 1] = (this.m_rgSlotState[p + 1]! ^ (bomber ^ this.m_rgSlotState[p + 1]!)) & SLOTSTATE_BOMBER_MASK;
    this.m_rgSlotState[p] = this.m_rgSlotState[p]! & 0xe1; // keep closed + 0xE0
    this.m_rgSlotState[p + 2] = (this.m_rgSlotState[p + 2]! ^ (color ^ this.m_rgSlotState[p + 2]!)) & SLOTSTATE_COLOR_MASK;
    this.m_nCurPlayerNum++;
    this.m_fModified |= 4;
    // CGameSession::AddUser tail (41AF4B)
    this.m_aBomberIdx[slot] = -1; // or [esi+edi*4+2D34h], -1
    this.m_rgUdpAlive[slot] = 0; // +12940 = 0 (CGameSession::AddUser, FxServer.exe.c:31876) — the flag OnUDPPeerInfo (type 11) sets and IsAllPlayerReadyForStart/the 30 s udp-loss sweep read
    this.m_rgJoinTime[slot] = CGameClock.Now(); // [esi+edi*4+3294h] = timeGetTime()
  }

  /**
   * CGameSession::OnUDPPeerInfo (41CE45) — a UDP handshake arrived: merge the
   * self-reported hosts into the slot's HOSTHANDLE list and broadcast the
   * peer matrix (120) to every TCP socket of the room.
   */
  OnUDPPeerInfo(user: CUser, host: HOSTHANDLE, hosts: number[], ports: number[]): void {
    const socket = user.m_pSocket;
    if (!socket) return;
    if (user.GetSessionIdx() !== this.m_nIdx) return;
    if (user.GetSessionSerialNo() !== this.m_nSerialNo) return;
    const count = socket.GetUserCount();
    for (let i = 0; i < count; i++) {
      const u: CUser | null = socket.GetUser(i);
      if (!u) continue;
      const slot = u.m_nSlotIdx;
      if (!this.m_rgPlayer[slot]) return;
      if (this.m_rgUdpAlive[slot] === 1) return;
      this.m_rgUdpAlive[slot] = 1;
    }
    for (let i = 0; i < count; i++) {
      const u = socket.GetUser(i)!;
      if (!this.CheckValidPlayer(u) || u.m_nSlotIdx >= MAX_SESSION_SLOTS) return;
    }
    for (let i = 0; i < count; i++) {
      const slot = socket.GetUser(i)!.m_nSlotIdx;
      const base = this.m_rgUdpHost[slot]!;
      base[0] = (host.ip >>> 24) & 0xff;
      base[1] = (host.ip >>> 16) & 0xff;
      base[2] = (host.ip >>> 8) & 0xff;
      base[3] = host.ip & 0xff;
      base[4] = (host.port >>> 8) & 0xff;
      base[5] = host.port & 0xff;
      let filled = 1; // host[0] occupies the first 8 bytes
      for (let j = 0; j < 2; j++) {
        if (hosts[j] === 0) continue;
        let found = false;
        for (let k = 0; k < filled; k++) {
          const ip = ((base[8 * k]! << 24) | (base[8 * k + 1]! << 16) | (base[8 * k + 2]! << 8) | base[8 * k + 3]!) >>> 0;
          const port = (base[8 * k + 4]! << 8) | base[8 * k + 5]!;
          if (ip === hosts[j] && port === ports[j]) {
            found = true;
            break;
          }
        }
        if (!found && filled < 3) {
          const at = 8 * filled;
          base[at] = (hosts[j]! >>> 24) & 0xff;
          base[at + 1] = (hosts[j]! >>> 16) & 0xff;
          base[at + 2] = (hosts[j]! >>> 8) & 0xff;
          base[at + 3] = hosts[j]! & 0xff;
          base[at + 4] = (ports[j]! >>> 8) & 0xff;
          base[at + 5] = ports[j]! & 0xff;
          filled++;
        }
      }
    }
    const packet = new CSendPacket(GS_ClientSend.OnUDPPeerInfo, CipherDegree.kPacketEncryptedCRC8);
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      if (this.m_rgPlayer[slot]) {
        packet.Encode1(1);
        const base = this.m_rgUdpHost[slot]!;
        for (let k = 0; k < 3; k++) {
          const at = 8 * k;
          const ip = ((base[at]! << 24) | (base[at + 1]! << 16) | (base[at + 2]! << 8) | base[at + 3]!) >>> 0;
          const port = (base[at + 4]! << 8) | base[at + 5]!;
          packet.Encode4(ip);
          packet.Encode2(port);
        }
        packet.Encode4(this.m_rgJoinTime[slot]! >>> 0);
      } else {
        packet.Encode1(0);
        this.m_rgUdpHost[slot]!.fill(0);
      }
    }
    this.SendPacket(packet);
    if (this.m_fPlaying !== 0 && this.m_nGamePhase === 0) this.DeferStartGame();
  }

  /**
   * The launch-phase UDP-loss sweep inside CGameSession::Update (the phase-0
   * branch): a player that never completed the UDP handshake within 25 s of
   * joining gets kicked with an empty 195 and the socket parked on stage 4.
   * (The <WAITING>/30 s variant in the original is dead code there: the sweep
   * only runs while m_fPlaying is set.)
   */
  private SweepUdpLossOnLaunching(): void {
    // 41DF53 — the grace is 25 s while the room is already flagged playing,
    // 30 s in the waiting stage; the Report string switches with it.
    const grace = this.m_fPlaying !== 0 ? 25000 : 30000;
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      const user = this.m_rgPlayer[slot];
      if (!user) continue;
      if (this.m_rgUdpAlive[slot] !== 0) continue;
      if (CGameClock.Now() - this.m_rgJoinTime[slot]! <= grace) continue;
      const ip = user.m_pSocket ? GetInfoStr(user.m_pSocket) : "";
      console.error(
        `[GS] User[${ip}:${user.GetName()}] (${user.m_pSocket?.GetUserCount() ?? 0}P) banned from game session (${this.m_nIdx}) while ${this.m_fPlaying !== 0 ? "<STARTING>" : "<WAITING>"} by udp loss`,
      );
      this.DumpLog();
      CGameSessionTable.ms_pInstance!.DestroyPlayer(user.m_pSocket!, 0);
      if (user.m_nFree === 0) {
        // [socket+244] == 0 — the IO-layer detach flag FXGS logic never sets,
        // so the port uses the connected flag
        const socket = user.m_pSocket;
        if (socket && socket.m_bConnected) {
          socket.SendPacket(new CSendPacket(GS_ClientSend.OnUdpLossBan, CipherDegree.kPacketEncryptedCRC8)); // 195, no payload
          socket.m_nPoolType = 4; // [socket+1D4]
        }
      }
    }
  }

  /** CBaseSession::AddUser(socket, selects, i) — pick slot/bomber/color. */
  AddUserFromSocket(socket: CClientSocket, selects: number[], i: number): void {
    const user = socket.GetUser(i)!;
    const slot = CClientSocket.HasAuthority(1) !== 0 ? this.GetNullSlot() : this.GetEmptySlot();
    let bomber = selects[i] ?? 0;
    if (!CBomberAttr.ms_pInstance!.IsValidSelectIdx(bomber)) bomber = CBomberAttr.ms_pInstance!.GetRandomBomberIdx();
    let color: number;
    if (i <= 0) color = this.GetColorForNewComer(slot);
    else {
      const first = this.GetSlotidx(socket.GetUser(0));
      color = this.GetColor(first);
    }
    if (CMainSystem.ms_pInstance!.m_nChannelType === 77) {
      for (let s = 0; s < this.m_nMaxSlot; s++) {
        const other = this.m_rgPlayer[s];
        if (other && other.GetGuildSerialNo() === user.GetGuildSerialNo()) {
          color = this.GetColor(s);
          break;
        }
      }
    }
    this.AddUser(slot, user, bomber, color);
  }

  /** CBaseSession::AddAllUser (vtbl+40). */
  AddAllUser(socket: CClientSocket, selects: number[]): void {
    for (let i = 0; i < socket.GetUserCount(); i++) this.AddUserFromSocket(socket, selects, i);
  }

  /** CBaseSession::AddPlayer (vtbl+36 body): seat check, AddAllUser, AddSocket. */
  AddPlayer(socket: CClientSocket, selects: number[]): number {
    if (this.m_fPlaying !== 0) return 0;
    const n = socket.GetUserCount();
    const free = CClientSocket.HasAuthority(1) !== 0 ? this.GetNullSlotCount() : this.GetEmptySlotCount();
    if (free < n) return 0;
    this.AddAllUser(socket, selects);
    this.m_setSocket.add(socket);
    return 1;
  }

  /** CListSession::AddPlayer — CGameSession::AddPlayer wraps it (vtbl+36). */
  AddPlayerList(socket: CClientSocket, selects: number[]): number {
    if (this.m_fPlaying !== 0) return 0;
    if (this.AddPlayer(socket, selects) === 0) return 0;
    if (CClientSocket.HasAuthority(1) !== 0) { // CGameSession::AddPlayer: HasAuthority(1)
      this.SetNewChief(this.GetSlotidx(socket.GetUser(0)));
    }
    return 1;
  }

  /** CBaseSession::DeleteUser(slot) + CListSession/DeleteUser + CGameSession::DeleteUser (41D297). */
  DeleteUser(slot: number): void {
    const user = this.m_rgPlayer[slot];
    if (this.fValid !== 0) {
      // CGameSession::DeleteUser — in-play: the captain's death cascade and
      // the loss count (+12276, the results-unit gate, is 0 until then).
      let incLose: boolean;
      if (this.m_nGamePhase === 1) {
        this.OnBomberDie(slot);
        incLose = true;
      } else {
        incLose = this.m_nGamePhase === 0;
      }
      if (incLose) user?.IncLose();
    }
    this.m_rgPlayer[slot] = null;
    this.m_rgSlotState[slot * 3] = this.m_rgSlotState[slot * 3]! & 0xfd; // clear chief
    for (let i = 0; i < this.m_nMaxSlot; i++) {
      this.m_rgVoteMatrix[slot * 8 + i] = 0;
      this.m_rgVoteMatrix[i * 8 + slot] = 0;
    }
    this.m_rgVote[slot] = 0;
    this.m_nCurPlayerNum--;
    this.m_fModified |= 4;
    this.m_aBomberIdx[slot] = -1; // CGameSession+11572 dword[slot]
    const host = this.m_rgUdpHost[slot]!;
    if (host.some((b) => b !== 0)) host.fill(0); // HOSTHANDLE::operator!= invalidHost
  }

  /** CBaseSession::DeleteAllSlotidx — SetSlotidx(-1) for the socket's users. */
  DeleteAllSlotidx(socket: CClientSocket): void {
    if (!socket) return;
    for (let i = 0; i < socket.GetUserCount(); i++) this.SetSlotidx(socket.GetUser(i), -1);
  }

  // ---- chief ----

  /** CListSession::IsChief — the socket owns the chief user. */
  IsChief(socket: CClientSocket): boolean {
    if (!socket) return false;
    const slot = this.m_nChiefSlotidx;
    if (slot < 0 || slot >= this.m_nMaxSlot) return false;
    const user = this.m_rgPlayer[slot];
    return user !== null && user.m_pSocket === socket;
  }

  /** CListSession::GetFirstSupremeChief — the first RoomTicket holder. */
  GetFirstSupremeChief(): number {
    if (this.m_nMaxSlot <= 0) return -2;
    for (let i = 0; i < this.m_nMaxSlot; i++) {
      const user = this.m_rgPlayer[i];
      if (user && user.HasFunctionalItem("Item/RoomTicket")) return i;
    }
    return -2;
  }

  /** CListSession::GetNextChiefSlot. */
  GetNextChiefSlot(): number {
    if (this.m_nChiefSwapCount >= SUPREME_ROOM_SWAP_COUNT) return this.GetFirstSupremeChief();
    for (let i = 0; i < this.m_nMaxSlot; i++) {
      if (this.m_rgPlayer[i]) return i;
    }
    return -2;
  }

  /** CListSession::SetChiefSlotidx — byte0 0x02 marks the chief. */
  SetChiefSlotidx(next: number): void {
    this.m_fSupreme = next === -2 ? 1 : 0;
    const old = this.m_nChiefSlotidx;
    if (old >= 0 && old < this.m_nMaxSlot) this.m_rgSlotState[old * 3] &= SLOTSTATE_CHIEF_CLEAR;
    this.m_nChiefSlotidx = next;
    if (next >= 0 && next < this.m_nMaxSlot) {
      this.m_rgSlotState[next * 3] |= SLOTSTATE_CHIEF;
      const user = this.m_rgPlayer[next];
      if (user) {
        const socket = user.m_pSocket;
        if (socket) {
          if (this.m_fPlaying === 0) {
            for (const u of socket.m_apUser) {
              if (!u) continue;
              const slot = this.GetSlotidx(u);
              if (slot >= 0 && slot < this.m_nMaxSlot) this.m_rgSlotState[slot * 3] &= SLOTSTATE_GROUP_CLEAR; // clear ready
            }
          }
        } else {
          console.error("[GS] !pSocket, CListSession::SetChiefSlotidx");
        }
      } else {
        console.error("[GS] !pUser, CListSession::SetChiefSlotidx");
      }
    }
  }

  /** CListSession::SetNewChief — move the crown and queue the 107s. */
  SetNewChief(next: number): void {
    const old = this.m_nChiefSlotidx;
    let nextSlot = next;
    if (nextSlot < 0) nextSlot = this.GetNextChiefSlot();
    this.SetChiefSlotidx(nextSlot);
    if (this.m_nChiefSlotidx >= 0 && this.m_nMaxSlot > 0) {
      for (let slot = 0; slot < this.m_nMaxSlot; slot++) {
        const user = this.m_rgPlayer[slot];
        if (user && slot !== this.m_nChiefSlotidx && this.IsChief(user.m_pSocket!)) {
          const packet = new CSendPacket(0, CipherDegree.kPacketEncryptedCRC8);
          this.MakeSetSlotStatePacket(slot, packet);
          this.PutPacket(packet);
        }
      }
    }
    if (old >= 0) {
      const packet = new CSendPacket(0, CipherDegree.kPacketEncryptedCRC8);
      this.MakeSetSlotStatePacket(old, packet);
      this.PutPacket(packet);
    }
    if (this.m_nChiefSlotidx >= 0) {
      const packet = new CSendPacket(0, CipherDegree.kPacketEncryptedCRC8);
      this.MakeSetSlotStatePacket(this.m_nChiefSlotidx, packet);
      this.PutPacket(packet);
    }
  }

  /** CListSession::InitBangPok — decide the first chief. */
  InitBangPok(socket: CClientSocket): void {
    let chief = 0;
    this.m_fSupreme = 0;
    if (this.m_nChiefSwapCount < SUPREME_ROOM_SWAP_COUNT) {
      const maxLevelUser = socket.GetMaxLevelUser();
      let slot = 0;
      for (; slot < this.m_nMaxSlot && this.m_rgPlayer[slot] !== maxLevelUser; slot++);
      if (slot === this.m_nMaxSlot) {
        slot = 0;
        for (; slot < this.m_nMaxSlot; slot++) {
          const user = this.m_rgPlayer[slot];
          if (user && user.m_pSocket === socket) break;
        }
      }
      this.SetChiefSlotidx(slot);
    } else {
      for (; chief < this.m_nMaxSlot; chief++) {
        const user = this.m_rgPlayer[chief];
        if (user && user.HasFunctionalItem("Item/RoomTicket")) break;
      }
      if (chief >= this.m_nMaxSlot) {
        this.m_nChiefSlotidx = -2;
        console.log("[GS] Spurious LadderSession Creation");
        return;
      }
      this.SetChiefSlotidx(chief);
    }
    this.m_nBanSerial = 0;
  }

  /** CListSession::DoBangPok — 122 to everyone, then out to the lobby. */
  DoBangPok(): void {
    for (const socket of [...this.m_setSocket]) {
      const p = new CSendPacket(GS_ClientSend.OnBangPok, CipherDegree.kPacketEncryptedCRC8);
      socket.SendPacket(p);
      socket.m_nPoolType = 4; // CClientSocket+468 = 4 (MoveToExchangeSession)
      CGameSessionTable.ms_pInstance!.MoveToExchangeSession(socket, 0);
    }
  }

  // ---- title ----

  /** CListSession::CanRequestChangeTitle (vtbl+108). */
  CanRequestChangeTitle(socket: CClientSocket): boolean {
    if (this.IsChief(socket)) return true;
    console.error("[GS] !this->IsChief(pSocket), CListSession::CanRequestChangeTitle");
    return false;
  }

  /** CBaseSession::DoChangeTitle + the CListSession modified bit. */
  DoChangeTitle(title: string): void {
    this.m_strName = title;
    const packet = new CSendPacket(GS_ClientSend.OnChangeTitle, CipherDegree.kPacketEncryptedCRC8);
    packet.EncodeStr(title);
    this.SendPacket(packet);
    this.m_fModified |= 0x10;
  }

  /** CListSession::DoOpenCloseSlot (vtbl+124) — 110 + the open-slot count. */
  DoOpenCloseSlot(slot: number, close: number): void {
    if (slot < 0 || slot >= this.m_nMaxSlot) return;
    if (this.m_rgPlayer[slot]) close = 0;
    const packet = new CSendPacket(GS_ClientSend.OnOpenCloseSlotRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(((slot << 4) | (close & 0xf)) & 0xff);
    this.SendPacket(packet);
    const p = slot * 3;
    const state = this.m_rgSlotState[p]!;
    const changing = (state & 1) === 0 !== (close === 0);
    this.m_rgSlotState[p] = state ^ ((close ^ state) & 1);
    if (changing) {
      let open = 0;
      for (let i = 0; i < this.m_nMaxSlot; i++) {
        if ((this.m_rgSlotState[i * 3]! & 1) === 0) open++;
      }
      if (open !== this.m_nMaxPlayerNum) {
        this.m_fModified |= 8;
        this.m_nMaxPlayerNum = open;
      }
    }
  }

  /** CListSession::SetPlaying. */
  SetPlaying(playing: number): void {
    this.m_fModified |= 1;
    this.m_fPlaying = playing;
  }

  /** CListSession::SetCurPlayer. */
  SetCurPlayer(cur: number): void {
    this.m_fModified |= 4;
    this.m_nCurPlayerNum = cur;
  }

  // ---- room list packets (83/85/86/87) ----

  /** CListSession::MakeSimpleInfoPacket — 83 [E2 idx][E4 serial][EStr name]
   *  [E1 hasPW][E1 gameType][E1 playing][E2 mapIdx][E1 cur][E1 max]. */
  MakeSimpleInfoPacket(packet: CSendPacket): void {
    packet.Encode2(this.m_nIdx);
    packet.Encode4(this.m_nSerialNo);
    packet.EncodeStr(this.m_strName);
    packet.Encode1(this.m_fHasPassword);
    packet.Encode1(this.m_nGameType);
    packet.Encode1(this.m_fPlaying);
    packet.Encode2(this.m_nMapIdx & 0xffff);
    packet.Encode1(this.m_nCurPlayerNum);
    packet.Encode1(this.m_nMaxPlayerNum);
  }

  /** CListSession::MakeCreatedPacket — 85 [E2 idx][E4 serial][EStr name]
   *  [E1 hasPW][E1 gameType][E1 cur][E1 max]. */
  MakeCreatedPacket(packet: CSendPacket): void {
    packet.InitPacket(GS_ClientSend.OnSessionCreated);
    this.MakeSimpleInfoCreated(packet);
  }

  private MakeSimpleInfoCreated(packet: CSendPacket): void {
    packet.Encode2(this.m_nIdx);
    packet.Encode4(this.m_nSerialNo);
    packet.EncodeStr(this.m_strName);
    packet.Encode1(this.m_fHasPassword);
    packet.Encode1(this.m_nGameType);
    packet.Encode1(this.m_nCurPlayerNum);
    packet.Encode1(this.m_nMaxPlayerNum);
  }

  /** CListSession::MakeModifiedPacket — 86, or 0 when nothing changed. */
  MakeModifiedPacket(packet: CSendPacket): number {
    if (this.m_fModified === 0) return 0;
    packet.InitPacket(GS_ClientSend.OnSessionModified);
    packet.Encode2(this.m_nIdx);
    packet.Encode4(this.m_nSerialNo);
    packet.Encode1(this.m_fModified);
    if ((this.m_fModified & 1) !== 0) packet.Encode1(this.m_fPlaying);
    if ((this.m_fModified & 2) !== 0) packet.Encode2(this.m_nMapIdx & 0xffff);
    if ((this.m_fModified & 4) !== 0) packet.Encode1(this.m_nCurPlayerNum);
    if ((this.m_fModified & 8) !== 0) packet.Encode1(this.m_nMaxPlayerNum);
    if ((this.m_fModified & 0x10) !== 0) packet.EncodeStr(this.m_strName);
    this.m_fModified = 0;
    return 1;
  }

  /** CListSession::MakeDestroyedPacket — 87 [E2 idx][E4 serial]. */
  MakeDestroyedPacket(packet: CSendPacket): void {
    packet.InitPacket(GS_ClientSend.OnSessionDestroyed);
    packet.Encode2(this.m_nIdx);
    packet.Encode4(this.m_nSerialNo);
  }

  // ---- leaving ----

  /** CGameSession::DestroyPlayer — the full leave path (FxServer.exe.c:32692). */
  DestroyPlayer(socket: CClientSocket, fSendReset: number): number {
    const wasChief = this.IsChief(socket);
    let dissolve = false;
    // CListSession::DestroyPlayer → CBaseSession::DestroyPlayer:
    // DeleteSocket, DeleteUser(socket) per user, SendResetPlayer, +468 = 1
    this.m_setSocket.delete(socket);
    for (let i = 0; i < socket.GetUserCount(); i++) {
      const user = socket.GetUser(i);
      if (!user) continue;
      const slot = this.GetSlotidx(user);
      if (slot >= 0 && slot < this.m_nMaxSlot && this.m_rgPlayer[slot] === user) {
        this.m_rgUdpAlive[slot] = 0;
        this.m_rgUdpHost[slot]!.fill(0);
      }
    }
    // the first leaver's slot drives CSyncGameObjMan::OnPlayerLeave
    const firstUser = socket.GetUserCount() > 0 ? socket.GetUser(0) : null;
    const firstSlot = firstUser ? firstUser.m_nSlotIdx : -1;
    this.DealWithGhostOfLeavingPlayer(socket);
    this.m_setSocket.delete(socket); // CBaseSession::DeleteSocket
    for (let i = 0; i < socket.GetUserCount(); i++) {
      const user = socket.GetUser(i);
      if (!user) continue;
      const slot = this.GetSlotidx(user);
      if (slot >= 0 && slot < this.m_nMaxSlot && this.m_rgPlayer[slot] === user) {
        this.m_abDeleted[slot] = 0;
        this.DeleteUser(slot);
      }
    }
    this.SendResetPlayer(socket, fSendReset);
    socket.m_nPoolType = 1; // socket +468 = 1 (back to the lobby)
    // m_pStrategy vtbl+24 OnLeaveSession — an empty thunk in the original
    this.m_SyncGameObjMan.OnPlayerLeave(firstSlot);
    if (wasChief) {
      const oldSupreme = this.m_fSupreme;
      this.m_BanChief = new CBanChief(); // CBanChief::Init(+12576)
      this.SetNewChief(-1);
      if (this.m_nChiefSwapCount >= SUPREME_ROOM_SWAP_COUNT && oldSupreme === 0 && this.m_fSupreme !== 0 && this.m_fPlaying === 0) {
        dissolve = true;
      }
    }
    this.FlushPacket();
    this.DeleteAllSlotidx(socket);
    if (this.m_nBanSerial !== 0) this.DeferBanPlayer();
    socket.AddBeforeJoinSession(this.m_nIdx);
    if (dissolve) this.DoBangPok();
    // a chief gone while the game is launching → try to start with the rest
    if (this.m_fPlaying !== 0 && this.m_nGamePhase === 0) this.DeferStartGame();
    return 1;
  }

  /**
   * CGameSession::DealWithGhostOfLeavingPlayer (FxServer.exe.c:31813) —
   * hand each of the leaving socket's ghosts to the first live socket with a
   * free ghost slot (166), or destroy them (167) when nobody can take one.
   */
  DealWithGhostOfLeavingPlayer(socket: CClientSocket): void {
    const count = socket.GetUserCount();
    for (let i = 0; i < count; i++) {
      const user = socket.GetUser(i);
      if (!user) continue;
      const slot = this.GetSlotidx(user);
      if (slot < 0 || slot >= MAX_SESSION_SLOTS) continue;
      const ghost = this.m_rgSlotGhost[slot]!;
      if (ghost === -1) continue;
      let freeSlot = 0;
      while (freeSlot < MAX_SESSION_SLOTS && !(this.m_rgPlayer[freeSlot] !== null && this.m_rgSlotGhost[freeSlot] === -1)) freeSlot++;
      if (freeSlot >= MAX_SESSION_SLOTS) {
        const p = new CSendPacket(GS_ClientSend.OnGhostDestroy, CipherDegree.kPacketEncryptedCRC8);
        p.Encode1(ghost);
        this.SendPacket(p);
        this.m_rgSlotGhost[slot] = -1;
        this.m_rgGhostSlot[ghost] = -1;
      } else {
        const p = new CSendPacket(GS_ClientSend.OnGhostGenerate, CipherDegree.kPacketEncryptedCRC8);
        p.Encode1(ghost);
        p.Encode1(freeSlot);
        this.SendPacket(p);
        this.m_rgSlotGhost[slot] = -1;
        this.m_rgGhostSlot[freeSlot] = ghost;
        this.m_rgSlotGhost[freeSlot] = ghost;
      }
    }
  }

  // ---- the in-play tick (CGameSession::Update, FxServer.exe.c:34783) ----

  /**
   * CGameSession::Update — every valid session gets this from
   * CGameSessionTable::UpdateGameSessions (4219A2) on the 400 ms timer (the
   * table's scratch packet argument carries no payload of its own).
   */
  Update(): void {
    if (this.fValid === 0) return;
    if (this.m_fPlaying === 0) {
      // !playing → vtbl+224 CBaseSession::DeferBanChief — the ban-chief unit.
      this.DeferBanChief();
      return;
    }
    const time = Date.now();
    this.m_dwLastTickTime = time;
    if (this.m_nGamePhase === 0) {
      // launching: kick the sockets that never completed the UDP handshake
      this.SweepUdpLossOnLaunching();
      return;
    }
    if (this.m_nGamePhase === 2) {
      this.DeferReturnPrepareStage();
      return;
    }
    // phase 1 — in play
    this.DeferHandleGameEnd();
    if (this.m_nGamePhase !== 1) {
      // the defer moved the game on — CSyncGameObjMan::OnGameEnd, once
      this.m_SyncGameObjMan.OnGameEnd();
      return;
    }
    if (this.m_GameClock.ElapsedTime() - this.m_GameClock.m_dwSuspended > 0x2bf20) {
      // the 3-minute play window (suspended time does not count) ran out
      this.SendGameResult(-1);
      this.m_GameClock.EndGame();
      this.m_nGamePhase = 2;
      return;
    }
    this.m_UdpLossRegulator.DeferRegulateConnection(this);
    const ctx = this.m_pCtx;
    const elapsed = time - this.m_nBombTickTime;
    this.m_nBombTickTime = time;
    let exploded = 0;
    if (ctx.m_nBombCount > 0) {
      // 152 — the bomb clock: every armed bomb counts down by the elapsed ms
      const packet = new CSendPacket(GS_ClientSend.OnSetBombTimerRes, CipherDegree.kPacketEncryptedCRC8);
      const countOffset = packet.m_uOffset;
      packet.Encode1(0);
      let i = 0;
      while (i < ctx.m_nBombCount) {
        const bomb = ctx.m_rgBomb[i]!;
        if (bomb.fFlag16 === 0 || bomb.fMoving === 1) bomb.timer -= elapsed;
        if (bomb.timer <= 0) {
          exploded++;
          packet.Encode2(bomb.id);
          if (bomb.fMoving === 1) {
            // a kicked bomb re-arms for another 2 s instead of exploding
            bomb.timer = 2000;
            bomb.fMoving = 0;
            packet.Encode1(1);
          } else {
            packet.Encode1(0);
            ctx.m_nBombCount--;
            if (ctx.m_nBombCount > 0) ctx.m_rgBomb[i] = ctx.m_rgBomb[ctx.m_nBombCount]!;
            continue; // re-examine the slot the last bomb moved into
          }
        }
        i++;
      }
      if (exploded > 0) {
        packet.Encode1At(countOffset, exploded);
        this.PutPacket(packet);
      }
    }
    // 159 — the trap clock: trapped players die once the grace runs out
    let died = 0;
    let grace = 10000;
    {
      let allDown = true;
      for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
        const code = this.m_abDeleted[slot]!;
        if (code !== 3 && code !== 1 && code !== 4) {
          allDown = false;
          break;
        }
      }
      if (allDown) grace = 6000; // everybody down/goal/trapped: the short fuse
    }
    const packet2 = new CSendPacket(GS_ClientSend.OnBomberEvent, CipherDegree.kPacketEncryptedCRC8);
    packet2.Encode1(80);
    packet2.Encode2(0);
    packet2.Encode2(0);
    const countOffset2 = packet2.m_uOffset;
    packet2.Encode1(0);
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      if (this.m_abDeleted[slot] !== 3) continue;
      if (this.m_GameClock.ElapsedTime() - ctx.m_rgnDownTime[slot]! >= grace) {
        packet2.Encode1(slot);
        packet2.Encode2(9999);
        packet2.Encode2(9999);
        died++;
        this.m_abDeleted[slot] = 1;
        ctx.m_rgnDownTime[slot] = this.m_GameClock.ElapsedTime();
        this.OnBomberDie(slot);
      }
    }
    if (died > 0) {
      packet2.Encode1At(countOffset2, died);
      this.PutPacket(packet2);
    }
    if (exploded > 0 || died > 0) this.FlushPacket();
  }

  /**
   * CGameSession::DeferBanChief (vtbl+224, FxServer.exe.lst:41C15B) — the
   * idle-room start gate.  The chief must press start within IsBanChief's
   * window (10 s idle games / 20 s fresh rooms since SetCanStart, halved when
   * he wears "Item/SuperChief" or holds Pm authority 25) or receive warning
   * 121 (E1 1/2/3 per stage); expiry removes him (163 with result 2).  A
   * start-flood gets the odd-slot grace (GetOddSlotInManner = count × 5 s)
   * and its own warning; expiry restarts the whole CanStart cycle
   * (SetCanStart(1)).  A chief-side decline (b) or the arrival of an
   * already-started room resets the cycle (SetCanStart(0)).
   */
  DeferBanChief(): void {
    if (this.m_fPlaying !== 0) {
      // cmp [esi+354h], ebx — a playing room only resets the gate
      this.m_BanChief.Init();
      return;
    }
    const slot = this.m_nChiefSlotidx; // [+360]
    if (slot < 0 || slot >= MAX_SESSION_SLOTS) return;
    const user = this.m_rgPlayer[slot]!;
    if (user === null || user.m_pSocket === null) return;
    // neg/sbb/and 2/inc — "Item/SuperChief" stretches every gate ×3
    const superChief = user.HasFunctionalItem("Item/SuperChief") ? 3 : 1;
    const now = CGameClock.Now(); // timeGetTime
    let oddGate = false; // 41C238
    if (this.m_nGameType === 0) {
      // [+34C] plain rooms: only 2+-player ones are gated
      if (this.m_nMaxPlayerNum > 1) {
        this.m_BanChief.SetOddSlot(0); // 41C202
      } else if (CClientSocket.HasAuthority(22) !== 0) { // CUser::HasAuthority(22)
        this.m_BanChief.SetOddSlot(0); // 41C1F5 → 41C202 (CUser::HasAuthority)
      } else {
        oddGate = true;
      }
    } else {
      // event rooms: odd player counts are gated
      if (this.m_nMaxPlayerNum % 2 === 0) {
        this.m_BanChief.SetOddSlot(0); // 41C1E4 even → 41C202
      } else if (CClientSocket.HasAuthority(22) !== 0) { // CUser::HasAuthority(22)
        this.m_BanChief.SetOddSlot(0); // 41C1F5 → 41C202
      } else {
        oddGate = true;
      }
    }
    if (oddGate) {
      // 41C238 — the odd-slot grace (GetOddSlotInManner = now × 5000)
      const bc = this.m_BanChief;
      if (bc.m_nOddSlot === 0) {
        bc.SetOddSlot(1);
      } else if (now - bc.m_dwOddSlotTime > bc.GetOddSlotInManner(now)) {
        if (bc.m_nWarnedBanOdd === 0) {
          bc.SetWarnedBanOdd(1);
          const p = new CSendPacket(GS_ClientSend.OnNeedStartGame, CipherDegree.kPacketEncryptedCRC8);
          p.Encode1(1);
          p.Encode2(Math.trunc(bc.GetWarningDelay(now) / 1000));
          this.SendPacket(p);
        } else if (now - bc.m_dwWarnedBanOddTime > bc.GetWarningDelay(now)) {
          const p = new CSendPacket(GS_ClientSend.OnNeedStartGame, CipherDegree.kPacketEncryptedCRC8);
          p.Encode1(3);
          p.Encode2(Math.trunc(bc.GetWarningDelay(now) / 1000));
          user.m_pSocket.SendPacket(p); // vtbl+68 — the chief only
          // CBaseSessionTable vtbl+48 (the DestroyPlayer override) then +468 = 4
          CGameSessionTable.ms_pInstance!.DestroyPlayer(user.m_pSocket, 0);
          bc.SetCanStart(0); // 41C46C → SetCanStart(0)
          return;
        }
      }
    }
    // 41C211 — the fresh-room start gate
    if (this.CanStartGame(1) !== 0) {
      // vtbl+220 refused → restart the whole cycle
      this.m_BanChief.SetCanStart(0);
      return;
    }
    if (this.m_BanChief.m_nCanStart === 0) {
      this.m_BanChief.SetCanStart(1); // 41C231
      return;
    }
    // 41C35B — the idle-game gate
    if (CClientSocket.HasAuthority(22) !== 0) return; // CUser::HasAuthority(22)
    const flag = this.m_nMaxPlayerNum - this.m_nCurPlayerNum < 0 ? 1 : 0;
    if (!this.m_BanChief.IsBanChief(flag, this.m_nGameType, superChief)) return;
    if (this.m_BanChief.m_nWarnedBan === 0) {
      this.m_BanChief.SetWarnedBan(1);
      const p = new CSendPacket(GS_ClientSend.OnNeedStartGame, CipherDegree.kPacketEncryptedCRC8);
      p.Encode1(0);
      p.Encode2(Math.trunc(this.m_BanChief.GetWarningDelay(now) / 1000));
      this.SendPacket(p);
      return;
    }
    if (now - this.m_BanChief.m_dwWarnedBanTime <= this.m_BanChief.GetWarningDelay(now)) return;
    const p2 = new CSendPacket(GS_ClientSend.OnNeedStartGame, CipherDegree.kPacketEncryptedCRC8);
    p2.Encode1(2);
    p2.Encode2(Math.trunc(this.m_BanChief.GetWarningDelay(now) / 1000));
    user.m_pSocket.SendPacket(p2); // vtbl+68 — the chief only
    CGameSessionTable.ms_pInstance!.DestroyPlayer(user.m_pSocket, 0); // vtbl+48 (+468 = 4 in the tail)
    this.m_BanChief.SetCanStart(0); // 41C46C
  }

  /** CGameSession::DeferReturnPrepareStage (41B0B7) — 8 s after the end screen. */
  DeferReturnPrepareStage(): void {
    if (Date.now() - this.m_GameClock.m_dwEndTime > RETURN_STAGE_DELAY) this.DoReturnPrepareStage();
  }

  /** CGameSession::DoReturnPrepareStage (41B0DA). */
  DoReturnPrepareStage(): void {
    const packet = new CSendPacket(GS_ClientSend.OnReturnPrepareStage, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(0);
    this.SendPacket(packet);
    this.m_nGamePhase = 0;
    this.m_nBanSerial = 0; // +828
    this.m_nGameMapIdx = -1; // +1180
    this.m_dwCreateTime = Date.now(); // +860
    this.SetPlaying(0);
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      this.m_aBomberIdx[slot] = -1; // +11572
      this.m_rgSlotState[slot * 3] = this.m_rgSlotState[slot * 3]! & SLOTSTATE_GROUP_CLEAR;
    }
    // strategy vtbl+32 OnReturnPrepareStage — an empty thunk in the original
    if (this.m_fSupreme !== 0) this.DoBangPok();
  }

  /**
   * CGameSession::DeferHandleGameEnd (41D31A) — the game is over when some
   * player finished (lap code 5) or won (6); otherwise every player must be
   * out of play (not 0/3).  The winner colour is the first finished player's
   * colour; any later disagreement downgrades to a tie (-1).
   */
  DeferHandleGameEnd(): void {
    let finished = false;
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      const code = this.m_abDeleted[slot]!;
      if (this.m_rgPlayer[slot] !== null && (code === 5 || code === 6)) finished = true;
    }
    if (!finished) {
      for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
        const code = this.m_abDeleted[slot]!;
        if (this.m_rgPlayer[slot] !== null && (code === 0 || code === 3)) return;
      }
    }
    let winner = -1;
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      const user = this.m_rgPlayer[slot];
      if (!user) continue;
      // CUser::HasAuthority(25) is the constant-0 stub — skipped
      const code = this.m_abDeleted[slot]!;
      if (code !== 2 && code !== 5 && code !== 6) {
        user.IncGame();
        continue;
      }
      const color = this.m_rgSlotState[slot * 3 + 2]! & SLOTSTATE_COLOR_MASK;
      if (winner === -1) {
        winner = color;
        user.IncGame();
      } else if (winner === color) {
        user.IncGame();
      } else {
        console.error("[GS] Clients returns different results. Send 'tie' result.");
        winner = -1;
        // the disagreement path skips IncGame for this user
      }
    }
    this.m_GameClock.EndGame();
    this.SendGameResult(winner); // sets the phase 2 internally in the original
    this.m_nGamePhase = 2;
  }

  /**
   * CGameSession::GetWinGameResult (41B482) — 1 when the number of slots in a
   * finish state (2 goal / 6 win) equals the slot's expected count (+12208)
   * while another team still has a pending count; in practice the counters
   * are never written, so this always returns 0.
   */
  GetWinGameResult(n8: number): number {
    const expected = this.m_rgDetailCount[n8]!; // [+12208+4n8]
    if (expected <= 2) return 0;
    const colour = this.GetColor(n8) & SLOTSTATE_COLOR_MASK;
    let otherPlaying = 0;
    for (let k = 0; k < MAX_SESSION_SLOTS; k++) {
      if ((this.GetColor(k) & SLOTSTATE_COLOR_MASK) !== colour && this.m_rgDetailCount[k]! > 2) otherPlaying = 1;
    }
    if (otherPlaying === 0) return 0;
    let finished = 0;
    for (let k = 0; k < MAX_SESSION_SLOTS; k++) {
      if (this.m_abDeleted[k] === 2 || this.m_abDeleted[k] === 6) finished++;
    }
    return finished === expected ? 1 : 0;
  }

  /**
   * CGameSession::GetGameDetailResult (41CA8C) — the winner slot's detail
   * byte: 3 when the slot's user carries the premium ticket, 1 when
   * +12240[n8] == +12048[n8] (both > 2), 2 when +12208[n8] == +12016[n8] + 1
   * (both > 2).  Those counters are never written in FXGS, so the practical
   * result is premium ? 3 : 0.
   */
  GetGameDetailResult(n8: number): number {
    let result = 0;
    if (this.m_rgPlayer[n8]?.m_fPremiumTicket === 1) result = 3;
    const a = this.m_rgWinDetailA[n8]!; // [+12240+4n8]
    if (a > 2 && a === this.m_rgWinDetailB[n8]!) {
      // [+12048+4n8]
      result = 1;
      const c = this.m_rgDetailCount[n8]!; // [+12208+4n8]
      if (c > 2 && c === this.m_rgColourCount[n8]! + 1) return 2;
    }
    return result;
  }

  /**
   * CGameSession::SendGameResult (vtbl+216, :36660) — the results unit.
   * Head [E1 flag][E1 winTeam][E1 view-type][E1 ladder][E1 diff-team item
   * flag]; per user [E1 1][E4 serial] then [E1 result][E1 +12048][E1 +12016]
   * [E2 exp‰][E2 exp‰ re-read][E2 look-level][E1 got-exp][E1 detail]; empty
   * slots send [E1 0].  IncDecExp feeds the DB dyn rows, IncWin/IncLose/
   * IncDraw the user counters, and level-ups re-sort the lobby rank list.
   */
  SendGameResult(winTeam: number): void {
    const packet = new CSendPacket(GS_ClientSend.OnGameResult, CipherDegree.kPacketEncryptedCRC8);
    const timeFactor = this.GetGameExpTimeFactor(); // v50 — the 41FE83 ladder
    let flag = 0;
    for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
      if (this.m_abDeleted[i] === 5 || this.m_abDeleted[i] === 6 || this.m_abDeleted[i] === 7) flag = 1;
    }
    packet.Encode1(flag);
    packet.Encode1(winTeam & 0xff);
    packet.Encode1(GAME_RESULT_VIEW_TYPE); // strategy vtbl+44
    packet.Encode1(IS_LADDER_GAME); // session vtbl+156
    let diffTeamUsedItem = 0; // v47
    for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
      if (this.m_rgPlayer[i] !== null && this.m_rgnUsedItem[i] !== 0 && (this.GetColor(i) & SLOTSTATE_COLOR_MASK) !== winTeam) diffTeamUsedItem = 1;
    }
    packet.Encode1(diffTeamUsedItem);
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      const user = this.m_rgPlayer[slot]!;
      if (user === null) {
        packet.Encode1(0);
        continue;
      }
      packet.Encode1(1);
      packet.Encode4(user.GetGlobalSerialNo()); // [+1964]
      let expPct = CDynInfoCalculator.GetExpPercentage(user.dyn.exp); // [+212] before the rewards
      let gotExp = 0; // DrawExp
      let gained = 0; // value
      let detail = 0; // GameDetailResult
      this.m_dwPremiumFlag = user.m_fPremiumTicket === 1 ? 1 : 0; // [+12272]
      if (!CMainSystem.IsPremiumChannel() && user.m_fPremiumTicket === 1) detail = 3;
      let result: number; // n3
      if (winTeam === -1) {
        result = 3;
        if (this.m_fSkipExpReward === 0) {
          const exp = this.m_DynInfoCalculator.GetDrawExp(slot);
          gained = Math.trunc(exp * timeFactor);
          gotExp = user.IncDecExp(gained) > 0 ? 1 : 0;
          user.IncDraw(); // vtbl+180 (UserIncDraw)
          if (CMainSystem.ms_pInstance!.m_nChannelType === 99) console.error(`${user.GetName()}:D:${gained}`);
        }
      } else if ((this.GetColor(slot) & SLOTSTATE_COLOR_MASK) === winTeam) {
        result = this.GetWinGameResult(slot);
        if (this.m_fSkipExpReward === 0) {
          let boost = 1.0; // v49
          if (diffTeamUsedItem !== 0) boost = 1.05;
          if (this.m_rgDetailCount[slot]! >= 2) {
            let premiumWinners = 0;
            for (let k = 0; k < MAX_SESSION_SLOTS; k++) {
              const w = this.m_rgPlayer[k]!;
              if (w !== null && (this.GetColor(k) & SLOTSTATE_COLOR_MASK) === winTeam && w.m_fPremiumTicket === 1) premiumWinners++;
            }
            if (premiumWinners >= 2) boost += 0.1;
          }
          const rewardFlag = [0]; // v45 — GetWinExp only zeroes it, so the big-luck branch stays dead in FXGS
          const exp = this.m_DynInfoCalculator.GetWinExp(slot, rewardFlag);
          gained = Math.trunc(exp * timeFactor * boost);
          gotExp = user.IncDecExp(gained) > 0 ? 1 : 0;
          detail = this.GetGameDetailResult(slot);
          user.IncWin(); // vtbl+172 (UserIncWin)
          if (CMainSystem.ms_pInstance!.m_nChannelType === 99) console.error(`${user.GetName()}:W:${gained}`);
          if (rewardFlag[0] !== 0) this.SendBigLuckMsg(STR_BIG_LUCK_MSG.replace("%s", user.GetName()));
        }
      } else {
        result = 2;
        if (this.m_fSkipExpReward === 0) {
          const exp = this.m_DynInfoCalculator.GetKillNSaveExp(slot);
          gained = Math.trunc(exp * timeFactor);
          gotExp = user.IncDecExp(gained) > 0 ? 1 : 0;
          user.IncLose(); // vtbl+176 (UserIncLose)
          if (CMainSystem.ms_pInstance!.m_nChannelType === 99) console.error(`${user.GetName()}:L:${gained}`);
        }
      }
      const pctNow = CDynInfoCalculator.GetExpPercentage(user.dyn.exp); // re-read after the rewards
      if (expPct > pctNow) expPct = 0;
      if (detail === 3 && gained === 0) detail = 0;
      packet.Encode1(result);
      packet.Encode1(this.m_rgWinDetailB[slot]!); // [+12048+4slot]
      packet.Encode1(this.m_rgColourCount[slot]!); // [+12016+4slot]
      packet.Encode2(expPct);
      packet.Encode2(pctNow);
      packet.Encode2(user.GetLookLevel());
      packet.Encode1(gotExp);
      packet.Encode1(detail);
      if (gotExp !== 0) CChannelPool.ms_pInstance!.UpdateRankList(user);
    }
    this.SendPacket(packet);
  }

  /** CGameSession::SendBigLuckMsg (:36478) — packet 10 [EStr] through the
   *  center link; CLocalServerMan::OnSystemMsg rebroadcasts it as CM 13. */
  SendBigLuckMsg(strMsg: string): void {
    const packet = new CSendPacket(MC_ReceivedPacket.OnSystemMsg);
    packet.EncodeStr(strMsg);
    CCenterProcess.ms_pInstance?.SendPacket(packet);
  }


  /** SendGameResult's time factor (the 41FE83 ladder). */
  private GetGameExpTimeFactor(): number {
    const elapsed = this.m_GameClock.ElapsedTime();
    if (elapsed < 15000) return 0.0;
    if (elapsed <= 45000) return (elapsed - 15000) / 30000.0;
    return 1.0;
  }

  /** CGameSessionTable::CloseSession's empty check lives on +832. */
  IsEmpty(): boolean {
    return this.m_nCurPlayerNum === 0;
  }

  /**
   * [this+852] — the vtbl+20 override marker DeferBanChief reads before its
   * chief probe (CGameSession::DumpLog prints the room header in FXGS).
   */
  vtblHasDumpLog(): number {
    return 0;
  }

  // ---- ready / map / color / bomber / slots (the 96..111 handlers) ----

  /**
   * CGameSession::OnSetPlayerReady — the *members'* ready toggle
   * (FxServer.exe.c:35201).  The body runs only when the sender is NOT the
   * chief's socket: the chief has no ready state of his own (he starts the
   * game), and a chief-sent 96 is silently ignored.
   */
  OnSetPlayerReady(n: CReceivedPacket, socket: CClientSocket): void {
    const chiefSlot = this.m_nChiefSlotidx;
    if (chiefSlot >= MAX_SESSION_SLOTS) return;
    const chiefUser = this.m_rgPlayer[chiefSlot];
    if (!chiefUser || chiefUser.m_pSocket === socket) return;
    const sender = socket.GetUser(0);
    if (!sender || sender.GetName().length === 0) {
      console.error(`[GS] Null player sent socket. Disconnect [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    const b = n.Decode1();
    if (b !== 1 && b !== 0) {
      console.error(`[GS] Hacking suspected [${GetInfoStr(socket)}]: set player ready packet out of range.`);
      socket.PostClosePacket();
      return;
    }
    const packet = new CSendPacket(0, CipherDegree.kPacketEncryptedCRC8);
    const count = socket.GetUserCount();
    for (let i = 0; i < count; i++) {
      const user = socket.GetUser(i);
      if (!user) {
        console.error(`[GS] Hacking suspected [${GetInfoStr(socket)}]: null user sent set player ready packet.`);
        socket.PostClosePacket();
        return;
      }
      const slot = this.GetSlotidx(user);
      if (slot >= MAX_SESSION_SLOTS) {
        console.error(`[GS] Hacking suspected [${GetInfoStr(socket)}]: non-valid player sent set player ready packet.`);
        socket.PostClosePacket();
        return;
      }
      const p = slot * 3;
      if (b !== 0) {
        if ((this.m_rgSlotState[p]! & SLOTSTATE_GROUP_MASK) !== 0) {
          console.error(`[GS] Hacking suspected [${GetInfoStr(socket)}]: set player ready packet [${b}] doesn't sync. Don't disconnect.`);
          return;
        }
        this.m_rgSlotState[p] = (this.m_rgSlotState[p]! & SLOTSTATE_GROUP_CLEAR) | SLOTSTATE_READY;
      } else {
        if ((this.m_rgSlotState[p]! & SLOTSTATE_GROUP_MASK) !== 0x04) {
          console.error(`[GS] Hacking suspected [${GetInfoStr(socket)}]: set player ready packet [${b}] doesn't sync. Don't disconnect.`);
          return;
        }
        this.m_rgSlotState[p] = this.m_rgSlotState[p]! & SLOTSTATE_GROUP_CLEAR;
      }
      this.MakeSetSlotStatePacket(slot, packet);
      this.PutPacket(packet);
    }
    this.FlushPacket();
  }

  /** CGameSession::OnSelectMap (FxServer.exe.c:33211). */
  OnSelectMap(n: CReceivedPacket, socket: CClientSocket): void {
    const mapIdx = n.Decode2() | 0;
    if (this.m_fPlaying === 0) {
      this.m_fModified |= 2;
      this.m_nMapIdx = mapIdx;
    }
    const packet = new CSendPacket(GS_ClientSend.OnSessionMapIdx, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode2(this.m_nMapIdx & 0xffff);
    this.PutPacket(packet);
    this.FlushPacket();
    if (this.m_fPlaying !== 0) return;
    // the team count of the chosen map (321 - mapIdx indexes m_apTheme)
    let teams: number;
    if (mapIdx === -1) teams = 8;
    else if (mapIdx >= 0) teams = CGameMapTmplList.ms_pInstance?.GetMapMaxTeam(mapIdx) ?? 0;
    else teams = CGameMapTmplList.ms_pInstance?.m_apTheme[321 - mapIdx]?.m_nMaxTeam ?? 0;
    // The color -> target-color map (:33264).  memset(0xFF) leaves every
    // entry at -1 (untouched); each color actually in use gets the marker
    // 0x11111111 (286331153).  For team counts the fold switch does not
    // cover (5/6/7) the marker survives into the apply step, whose `& 0xff`
    // then yields the original's quirky 0x11 — kept verbatim.
    const colorMap = new Int32Array(8).fill(-1);
    let usedColors = 0;
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      if (this.IsPlayerSet(slot) && colorMap[this.GetColor(slot)]! === -1) {
        usedColors++;
        colorMap[this.GetColor(slot)] = 0x11111111;
      }
    }
    const IN_USE = 0x11111111;
    if (teams < usedColors) {
      // round-robin re-assignment onto {0,3,5,6} for 2..4 team maps
      let k = 0;
      const teamColorPool = [0, 3, 5, 6];
      if (teams >= 2 && teams <= 4) {
        for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
          if (!this.IsPlayerSet(slot)) continue;
          const p = slot * 3 + 2;
          const want = teamColorPool[k % teams]!;
          this.m_rgSlotState[p] = (this.m_rgSlotState[p]! ^ (want ^ this.m_rgSlotState[p]!)) & SLOTSTATE_COLOR_MASK;
          k++;
          const sp = new CSendPacket(0, CipherDegree.kPacketEncryptedCRC8);
          this.MakeSetSlotStatePacket(slot, sp);
          this.PutPacket(sp);
        }
      }
    } else {
      switch (teams) {
        case 2:
          if (colorMap[0] === IN_USE) colorMap[0] = 0;
          if (colorMap[3] === IN_USE) colorMap[3] = 3;
          for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
            if (colorMap[i] === IN_USE) {
              if (colorMap[0] !== 0) {
                colorMap[i] = 0;
                colorMap[0] = 0;
              } else if (colorMap[3] !== 3) {
                colorMap[i] = 3;
                colorMap[3] = 3;
              }
            }
          }
          break;
        case 3:
          if (colorMap[0] === IN_USE) colorMap[0] = 0;
          if (colorMap[3] === IN_USE) colorMap[3] = 3;
          if (colorMap[5] === IN_USE) colorMap[5] = 5;
          for (let j = 0; j < MAX_SESSION_SLOTS; j++) {
            if (colorMap[j] === IN_USE) {
              if (colorMap[0] !== 0) {
                colorMap[j] = 0;
                colorMap[0] = 0;
              } else if (colorMap[3] === 3) {
                if (colorMap[5] !== 5) {
                  colorMap[j] = 5;
                  colorMap[5] = 5;
                }
              } else {
                colorMap[j] = 3;
                colorMap[3] = 3;
              }
            }
          }
          break;
        case 4:
          if (colorMap[0] === IN_USE) colorMap[0] = 0;
          if (colorMap[3] === IN_USE) colorMap[3] = 3;
          if (colorMap[5] === IN_USE) colorMap[5] = 5;
          if (colorMap[6] === IN_USE) colorMap[6] = 6;
          for (let m = 0; m < MAX_SESSION_SLOTS; m++) {
            if (colorMap[m] === IN_USE) {
              if (colorMap[0] !== 0) {
                colorMap[m] = 0;
                colorMap[0] = 0;
              } else if (colorMap[3] === 3) {
                if (colorMap[5] === 5) {
                  if (colorMap[6] !== 6) {
                    colorMap[m] = 6;
                    colorMap[6] = 6;
                  }
                } else {
                  colorMap[m] = 5;
                  colorMap[5] = 5;
                }
              } else {
                colorMap[m] = 3;
                colorMap[3] = 3;
              }
            }
          }
          break;
        case 8:
          for (let k = 0; k < MAX_SESSION_SLOTS; k++) colorMap[k] = k;
          break;
        default:
          break;
      }
      for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
        if (!this.IsPlayerSet(slot)) continue;
        const p = slot * 3 + 2;
        const want = colorMap[this.GetColor(slot)]! & 0xff;
        this.m_rgSlotState[p] = (this.m_rgSlotState[p]! ^ (want ^ this.m_rgSlotState[p]!)) & SLOTSTATE_COLOR_MASK;
        const sp = new CSendPacket(0, CipherDegree.kPacketEncryptedCRC8);
        this.MakeSetSlotStatePacket(slot, sp);
        this.PutPacket(sp);
      }
    }
    this.FlushPacket();
  }

  /** CBaseSession::OnSelectColor — 98 → 108 (FxServer.exe.c:30993). */
  OnSelectColor(n: CReceivedPacket, socket: CClientSocket): void {
    const user0 = socket.GetUser(0);
    if (!user0 || user0.GetName().length === 0) {
      console.error(`[GS] Null player sent socket. Disconnect [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    const b = n.Decode1();
    const selfIdx = b >> 4;
    const colorIdx = b & 0xf;
    const target = socket.GetUser(selfIdx);
    const slot = this.GetSlotidx(target);
    if (selfIdx < 0 || selfIdx >= socket.GetUserCount()) {
      console.error(`[GS] Hacking suspected [${GetInfoStr(socket)}]: selfidx is out of range.`);
      socket.PostClosePacket();
      return;
    }
    if (colorIdx >= MAX_SESSION_SLOTS) {
      console.error(`[GS] Hacking suspected [${GetInfoStr(socket)}]: coloridx is out of range.`);
      socket.PostClosePacket();
      return;
    }
    if (slot >= 0 && slot < this.m_nMaxSlot) {
      this.SetColor(slot, colorIdx); // DoSelectColor
      const packet = new CSendPacket(GS_ClientSend.OnSelectColorRes, CipherDegree.kPacketEncryptedCRC8);
      packet.Encode1(((slot << 4) | (colorIdx & 0xf)) & 0xff);
      this.SendPacket(packet);
      return;
    }
    console.error(`[GS] Invalid slot idx (OnSelectColor). Disconnect [${GetInfoStr(socket)}].`);
    socket.PostClosePacket();
  }

  /** CListSession::OnSelectBomber → CBaseSession::OnSelectBomber — 99 → 109. */
  OnSelectBomber(n: CReceivedPacket, socket: CClientSocket): void {
    if (this.m_fPlaying !== 0) return;
    const user0 = socket.GetUser(0);
    if (!user0 || user0.GetName().length === 0) {
      console.error(`[GS] Null player sent socket. Disconnect [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    const b = n.Decode1();
    const selfIdx = b >> 4;
    const bomberIdx = b & 0xf;
    const target = socket.GetUser(selfIdx);
    const slot = this.GetSlotidx(target);
    if (selfIdx < 0 || selfIdx >= socket.GetUserCount()) {
      console.error(`[GS] Hacking suspected [${GetInfoStr(socket)}]: selfidx is out of range(OnSelectBomber).`);
      socket.PostClosePacket();
      return;
    }
    const attr = CBomberAttr.ms_pInstance!;
    if (bomberIdx < attr.GetNormalCount() || bomberIdx === attr.GetTotalCount()) {
      if (slot >= 0 && slot < this.m_nMaxSlot) {
        const p = slot * 3 + 1;
        this.m_rgSlotState[p] = (this.m_rgSlotState[p]! ^ ((bomberIdx ^ this.m_rgSlotState[p]!) & SLOTSTATE_BOMBER_MASK));
        const packet = new CSendPacket(GS_ClientSend.OnSelectBomberRes, CipherDegree.kPacketEncryptedCRC8);
        packet.Encode1(((slot << 4) | (bomberIdx & 0xf)) & 0xff);
        this.SendPacket(packet);
        return;
      }
      console.error(`[GS] Invalid slot idx (OnSelectBomber). Disconnect [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    console.error(`[GS] Hacking suspected [${GetInfoStr(socket)}]: bomberidx is out of range(OnSelectBomber).`);
    socket.PostClosePacket();
  }

  /** CListSession::OnOpenCloseSlot — 100 (chief only, FxServer.exe.c:40725). */
  OnOpenCloseSlot(n: CReceivedPacket, socket: CClientSocket): void {
    if (this.m_fPlaying !== 0) return;
    const user0 = socket.GetUser(0);
    if (!user0 || user0.GetName().length === 0) {
      console.error(`[GS] Null player sent socket. Disconnect [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    const chiefSlot = this.m_nChiefSlotidx;
    if (chiefSlot < 0 || chiefSlot >= this.m_nMaxSlot) {
      console.error(`[GS] No Chief player exists.(Supreme Room) (SetSlotState). Disconnect [${GetInfoStr(socket)}].`);
      return;
    }
    const chiefUser = this.m_rgPlayer[chiefSlot];
    if (!chiefUser) {
      console.error(`[GS] Chief player doesn't exists(SetSlotState). Disconnect [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    if (chiefUser.m_pSocket !== socket) {
      console.error(`[GS] Hacking suspected [${GetInfoStr(socket)}]: non-chief tried to open or close slot.`);
      socket.PostClosePacket();
      return;
    }
    const b = n.Decode1();
    const slot = b >> 4;
    const close = (b & 0xf) !== 0 ? 1 : 0;
    if (slot >= 0 && slot < this.m_nMaxSlot) {
      this.DoOpenCloseSlot(slot, close);
      return;
    }
    console.error(`[GS] Invalid slot idx (OnOpenCloseSlot). Disconnect [${GetInfoStr(socket)}].`);
    socket.PostClosePacket();
  }

  /** CGameSession::OnSetGameTypeNormal — 102 → 93. */
  OnSetGameTypeNormal(socket: CClientSocket): void {
    const chiefSlot = this.m_nChiefSlotidx;
    if (chiefSlot >= MAX_SESSION_SLOTS) {
      console.error("[GS] No chief exists but player request to set game type");
      return;
    }
    const chiefUser = this.m_rgPlayer[chiefSlot];
    if (chiefUser && chiefUser.m_pSocket === socket) this.SendGameTypeNormal();
    else console.error("[GS] Non-chief player request to set game type");
  }

  /** CGameSession::OnSetGameTypeMod — 103 → 92. */
  OnSetGameTypeMod(socket: CClientSocket): void {
    const chiefSlot = this.m_nChiefSlotidx;
    if (chiefSlot >= MAX_SESSION_SLOTS) {
      console.error("[GS] No chief exists but player request to set game type");
      return;
    }
    const chiefUser = this.m_rgPlayer[chiefSlot];
    if (chiefUser && chiefUser.m_pSocket === socket) this.SendGameTypeMod();
    else console.error("[GS] Non-chief player request to set game type");
  }

  /** CGameSession::SendGameTypeNormal — +948 = 0, packet 93. */
  SendGameTypeNormal(): void {
    this.m_nGameTypeMod = 0;
    this.SendPacket(new CSendPacket(GS_ClientSend.OnGameTypeNormal, CipherDegree.kPacketEncryptedCRC8));
  }

  /** CGameSession::SendGameTypeMod — +948 = 1, packet 92. */
  SendGameTypeMod(): void {
    this.m_nGameTypeMod = 1;
    this.SendPacket(new CSendPacket(GS_ClientSend.OnGameTypeMod, CipherDegree.kPacketEncryptedCRC8));
  }

  /** CGameSession::SendGameType — the join tail (92 or 93). */
  SendGameType(socket: CClientSocket): void {
    socket.SendPacket(new CSendPacket(this.m_nGameTypeMod !== 0 ? GS_ClientSend.OnGameTypeMod : GS_ClientSend.OnGameTypeNormal, CipherDegree.kPacketEncryptedCRC8));
  }

  // ---- ban votes (104/105 → 113/114) ----

  /** CListSession::OnHostAskBanPlayer (FxServer.exe.c:41110). */
  OnHostAskBanPlayer(n: CReceivedPacket, socket: CClientSocket): void {
    const user0 = socket.GetUser(0);
    if (!user0 || user0.GetName().length === 0) {
      console.error(`[GS] Null player sent socket. Disconnect [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    const chiefSlot = this.m_nChiefSlotidx;
    if (chiefSlot < 0 || chiefSlot >= this.m_nMaxSlot) {
      console.error(`[GS] Hacking suspected [${GetInfoStr(socket)}]: Non-chief player ask ban player (there is no chief player exists)`);
      socket.PostClosePacket();
      return;
    }
    const chiefUser = this.m_rgPlayer[chiefSlot]!;
    if (!chiefUser || chiefUser.m_pSocket !== socket) {
      console.error(`[GS] Hacking suspected [${GetInfoStr(socket)}]: Non-chief player ask ban player`);
      socket.PostClosePacket();
      return;
    }
    if (this.m_nBanSerial !== 0) {
      const p = new CSendPacket(GS_ClientSend.OnBanPlayerRes, CipherDegree.kPacketEncryptedCRC8);
      p.Encode1(1);
      socket.SendPacket(p);
      return;
    }
    const serial = n.Decode4();
    const superFlag = n.Decode1();
    let slot = this.GetSlotidxFromSerialNo(serial);
    if (socket.GetSelfidxFromSerialNo(serial) !== -1) {
      console.error(`[GS] Hacking suspected [${GetInfoStr(socket)}]: Chief player ask ban himself`);
      socket.PostClosePacket();
      return;
    }
    // the target's users record 0, everyone else 1 (asked)
    for (let i = 0; i < this.m_nMaxSlot; i++) {
      const u = this.m_rgPlayer[i];
      if (u && u.GetGlobalSerialNo() === serial) {
        this.m_rgVote[i] = 0;
        slot = i;
      } else {
        this.m_rgVote[i] = 1;
      }
    }
    if (slot === -1) {
      this.m_nBanSerial = 0;
      return;
    }
    const targetUser = this.m_rgPlayer[slot]!;
    if (superFlag !== 0 || CClientSocket.HasAuthority(21) !== 0) {
      // a super chief (Item/SuperChief) or an operator kicks outright
      let hasSuper = false;
      for (const u of socket.m_apUser) {
        if (u && u.HasFunctionalItem("Item/SuperChief")) {
          hasSuper = true;
          break;
        }
      }
      if (hasSuper || CClientSocket.HasAuthority(21) !== 0) {
        this.m_nBanSerial = 0;
        const targetSocket = targetUser.m_pSocket!;
        this.MoveOut(targetSocket);
        const p = new CSendPacket(GS_ClientSend.OnBanPlayerRes, CipherDegree.kPacketEncryptedCRC8);
        p.Encode1(4);
        this.SendPacket(p);
        return;
      }
    }
    // Item/BanReflex bounces the ban onto the chief
    let reflex = false;
    for (const u of targetUser.m_pSocket?.m_apUser ?? []) {
      if (u && u.HasFunctionalItem("Item/BanReflex")) {
        reflex = true;
        break;
      }
    }
    if (reflex) {
      this.m_nBanSerial = 0;
      const chief = this.m_rgPlayer[this.m_nChiefSlotidx]!;
      const chiefSocket = chief.m_pSocket!;
      this.MoveOut(chiefSocket);
      const p = new CSendPacket(GS_ClientSend.OnBanPlayerRes, CipherDegree.kPacketEncryptedCRC8);
      p.Encode1(5);
      p.EncodeStr(chief.GetName());
      this.SendPacket(p);
      return;
    }
    // start the vote: the chief is a yes, the ask goes to the rest
    for (const u of targetUser.m_pSocket?.m_apUser ?? []) {
      const s = this.GetSlotidx(u);
      if (s >= 0) this.m_rgVote[s] = 0;
    }
    this.m_nBanSerial = serial;
    for (const u of socket.m_apUser) {
      const s = this.GetSlotidx(u);
      if (s >= 0) this.m_rgVote[s] = 2;
    }
    this.DeferBanPlayer();
    if (this.m_nBanSerial !== 0) {
      const ask = new CSendPacket(GS_ClientSend.OnBanVoteRequest, CipherDegree.kPacketEncryptedCRC8);
      ask.Encode4(serial);
      ask.EncodeStr(targetUser.GetName());
      const chiefSocket = chiefUser.m_pSocket!;
      const targetSocket = targetUser.m_pSocket!;
      const sent = new Set<CClientSocket>();
      for (const u of this.m_rgPlayer) {
        if (!u || u === chiefUser) continue;
        if (u.GetGlobalSerialNo() === serial) continue;
        const member = u.m_pSocket;
        if (!member || member === targetSocket || member === chiefSocket) continue;
        if (sent.has(member)) continue;
        sent.add(member);
        member.SendPacket(ask);
      }
      const res = new CSendPacket(GS_ClientSend.OnBanPlayerRes, CipherDegree.kPacketEncryptedCRC8);
      res.Encode1(0);
      socket.SendPacket(res);
    }
  }

  /** The MoveToExchangeSession stub — FXGS only logs and retags the socket. */
  MoveOut(socket: CClientSocket): void {
    console.error("[GS] CBaseSessionTable::MoveToExchangeSession(CClientSocket* pSocket1, CClientSocket* pSocket2)");
    void socket;
  }

  /** CListSession::GetSlotidxFromSerialNo. */
  GetSlotidxFromSerialNo(serial: number): number {
    return this.m_rgPlayer.findIndex((u) => u && u.GetGlobalSerialNo() === serial);
  }

  /** CListSession::OnRespondToBanPlayer — 105 (FxServer.exe.c:40232+). */
  OnRespondToBanPlayer(n: CReceivedPacket, socket: CClientSocket): void {
    if (this.m_nBanSerial === 0 || this.m_nBanSerial !== (n.Decode4() >>> 0)) return;
    const yes = n.Decode1();
    const count = socket.GetUserCount();
    for (let i = 0; i < count; i++) {
      const slot = this.GetSlotidx(socket.GetUser(i));
      if (this.m_rgVote[slot] !== 1) break;
      this.m_rgVote[slot] = yes !== 0 ? 2 : 3;
    }
    this.DeferBanPlayer();
  }

  /** CListSession::DeferBanPlayer (vtbl+144) — count and apply the votes. */
  DeferBanPlayer(): void {
    let targetSlot = -1;
    let total = 0;
    let yes = 0;
    let no = 0;
    for (let slot = 0; slot < this.m_nMaxSlot; slot++) {
      const user = this.m_rgPlayer[slot];
      if (!user) continue;
      if (user.GetGlobalSerialNo() === this.m_nBanSerial) targetSlot = slot;
      const vote = this.m_rgVote[slot]!;
      if (vote !== 0) {
        total++;
        if (vote === 2) yes++;
        else if (vote === 3) no++;
      }
    }
    if (targetSlot === -1) {
      this.m_nBanSerial = 0;
      const p = new CSendPacket(GS_ClientSend.OnBanPlayerRes, CipherDegree.kPacketEncryptedCRC8);
      p.Encode1(4);
      this.SendPacket(p);
      return;
    }
    if (2 * yes > total) {
      // banned by majority
      this.m_nBanSerial = 0;
      const target = this.m_rgPlayer[targetSlot]!;
      const targetSocket = target.m_pSocket!;
      this.MoveOut(targetSocket);
      targetSocket.m_nPoolType = 4;
      const p = new CSendPacket(GS_ClientSend.OnBanPlayerRes, CipherDegree.kPacketEncryptedCRC8);
      p.Encode1(2);
      p.EncodeStr(target.GetName());
      this.SendPacket(p);
      return;
    }
    if (2 * no >= total || yes + no >= total) {
      this.m_nBanSerial = 0;
      const target = this.m_rgPlayer[targetSlot]!;
      const p = new CSendPacket(GS_ClientSend.OnBanPlayerRes, CipherDegree.kPacketEncryptedCRC8);
      p.Encode1(3);
      p.EncodeStr(target.GetName());
      this.SendPacket(p);
    }
  }

  // ---- title / emotion / team chat ----

  /** CBaseSession::OnRequestChangeTitle — 107 (FxServer.exe.c:41978A). */
  OnRequestChangeTitle(n: CReceivedPacket, socket: CClientSocket): void {
    if (this.CanRequestChangeTitle(socket)) {
      let title = n.DecodeStr();
      if (title.length > 0x16) title = title.slice(0, 21);
      this.DoChangeTitle(title);
    } else {
      console.error("[GS] !this->CanRequestChangeTitle(pSocket), CBaseSession::CanRequestChangeTitle");
    }
  }

  /** CBaseSession::OnPlayEmotion — 108 → 118 minus the sender. */
  OnPlayEmotion(n: CReceivedPacket, socket: CClientSocket): void {
    const slot = n.Decode1();
    const a = n.Decode1();
    const b = n.Decode1();
    const c = n.Decode2();
    const user = this.m_rgPlayer[slot];
    if (user && user.m_pSocket === socket) {
      const packet = new CSendPacket(GS_ClientSend.OnPlayEmotion, CipherDegree.kPacketEncryptedCRC8);
      packet.Encode1(slot);
      packet.Encode1(a);
      packet.Encode1(b);
      packet.Encode2(c);
      this.SendPacketExclude(packet, socket);
    } else {
      console.error(`[GS] slotidx and socket doesn't match: hacking suspected [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
    }
  }

  /** CListSession::OnTeamChat — 111 → 27 to the same color (424251E0). */
  OnTeamChat(n: CReceivedPacket, socket: CClientSocket): void {
    const msg = n.DecodeStr();
    const user0 = socket.GetUser(0);
    if (!user0 || user0.GetName().length === 0) {
      console.error(`[GS] Null player sent socket. Disconnect [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    if (socket.GetUserCount() !== 1) {
      console.error(`[GS] 2 Player requested Team Chat, NOT ALLOWED![${GetInfoStr(socket)}]`);
      return;
    }
    if (msg.length + user0.GetName().length + 10 > 0x400) {
      console.error("[GS] User send too long chat msg. Disconnect connection");
      socket.PostClosePacket();
      return;
    }
    const text = `${user0.GetName()} : ${msg}`;
    const packet = new CSendPacket(GS_ClientSend.OnWhisperRes, CipherDegree.kPacketEncryptedCRC8);
    packet.EncodeStr(text);
    const slot = this.GetSlotidx(user0);
    const color = this.GetColor(slot);
    for (let s = 0; s < MAX_SESSION_SLOTS; s++) {
      const other = this.m_rgPlayer[s];
      if (other && s !== slot && this.GetColor(s) === color) {
        other.m_pSocket?.SendPacket(packet);
      }
    }
  }

  // ---- starting the game (106 → 115/116) ----

  /** CGameSession::CanStartGame (FxServer.exe.c:41C805) — 0 = go. */
  CanStartGame(fNeedMap: number): number {
    const counts = new Int32Array(8);
    let players = 0;
    let teams = 0;
    const chiefSlot = this.m_nChiefSlotidx;
    const chiefUser = chiefSlot < MAX_SESSION_SLOTS ? this.m_rgPlayer[chiefSlot] : null;
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      const user = this.m_rgPlayer[slot];
      if (!user || CClientSocket.HasAuthority(25) !== 0) continue;
      const state0 = this.m_rgSlotState[slot * 3]!;
      const state1 = this.m_rgSlotState[slot * 3 + 1]!;
      if (++counts[this.GetColor(slot)]! === 1) teams++;
      players++;
      if (chiefUser && chiefUser.m_pSocket === user.m_pSocket) {
        if ((state0 & SLOTSTATE_GROUP_MASK) !== 0) {
          console.error(`[GS] Chief Player is not stand-by, but [${(state0 >> 2) & 7}].`);
          return 2;
        }
      } else if ((state0 & SLOTSTATE_CHIEF) === 0 && (state0 & SLOTSTATE_GROUP_MASK) !== 4) {
        return 2;
      }
      void state1;
    }
    if (this.m_nGameType !== 0) {
      for (let c = 0; c < MAX_SESSION_SLOTS; c++) {
        if (counts[c] !== 0 && counts[c] !== Math.floor(players / teams)) return 6;
      }
    }
    const total = players; // GetExtraPlayerNo() == 0
    const totalTeams = teams; // GetExtraTeamNo() == 0
    if (total < 2) return 3;
    if (totalTeams < 2) return 5;
    const mapIdx = this.m_nGameMapIdx;
    const list = CGameMapTmplList.ms_pInstance!;
    if (mapIdx >= 0) {
      if (total > list.GetMapMaxPlayer(mapIdx)) return 4;
      if (chiefUser) {
        if (CClientSocket.HasAuthority(23) !== 0) return 0;
        if (!CMainSystem.IsPremiumChannel() && chiefUser.m_fPremiumTicket !== 1 && list.GetMapPremiumOnly(mapIdx) === 1) return 7;
        if (chiefUser.m_nLevel >= list.GetMapLevelLimit(mapIdx)) return 0; // chief level (dword +496), not exp
      } else {
        return 0;
      }
    } else if (fNeedMap !== 0) {
      return 0;
    }
    return 1;
  }

  /** CGameSession::SetMapIdxPlayingByLevel (FxServer.exe.c:41C9C4). */
  SetMapIdxPlayingByLevel(level: number, gm: number, premiumTicket: number): void {
    let mapIdx = this.m_nMapIdx;
    if (mapIdx === -1) {
      mapIdx = CGameMapTmplList.ms_pInstance!.GetRandomMapIdx(this.m_nCurPlayerNum, level, -1, 0, gm, premiumTicket);
    } else if (mapIdx < 0) {
      mapIdx = CGameMapTmplList.ms_pInstance!.GetRandomMapIdx(this.m_nCurPlayerNum, level, -2 - mapIdx, 0, gm, premiumTicket);
    }
    this.m_nGameMapIdx = mapIdx;
  }

  /** CGameSession::CheckIsCaptain — the highest exp of a color (mod mode). */
  CheckIsCaptain(slot: number): number {
    const user = this.m_rgPlayer[slot];
    if (!user) {
      this.m_abCaptain[slot] = 1;
      return 1;
    }
    const exp = user.dyn.exp;
    const color = this.GetColor(slot);
    for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
      const other = this.m_rgPlayer[i];
      if (other && color === this.GetColor(i) && exp < other.dyn.exp) {
        this.m_abCaptain[slot] = 0;
        return 0;
      }
    }
    this.m_abCaptain[slot] = 1;
    return 1;
  }

  /** CGameSession::OnBomberDie — the captain falls and the team follows (mod mode, 41BFAB). */
  OnBomberDie(slot: number): void {
    if (slot < 0 || slot >= MAX_SESSION_SLOTS) return;
    const user = this.m_rgPlayer[slot];
    if (!user || this.m_nGameTypeMod === 0 || this.m_abCaptain[slot] === 0) return;
    const exp = user.dyn.exp;
    const color = this.GetColor(slot);
    for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
      const other = this.m_rgPlayer[i];
      if (other && color === this.GetColor(i) && exp < other.dyn.exp) return;
    }
    let n = 0;
    for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
      const other = this.m_rgPlayer[i];
      if (other && i !== slot && color === this.GetColor(i)) {
        const code = this.m_abDeleted[i]!;
        if (code === 0 || code === 3) n++;
      }
    }
    if (n > 0) {
      const packet = new CSendPacket(GS_ClientSend.OnBomberEvent, CipherDegree.kPacketEncryptedCRC8);
      packet.Encode1(80);
      packet.Encode2(0);
      packet.Encode2(0);
      packet.Encode1(n);
      for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
        const other = this.m_rgPlayer[i];
        if (!other || i === slot || color !== this.GetColor(i)) continue;
        const code = this.m_abDeleted[i]!;
        if (code === 0 || code === 3) {
          packet.Encode1(i);
          packet.Encode2(9999);
          packet.Encode2(9999);
          this.m_abDeleted[i] = 1;
        }
      }
      this.PutPacket(packet, null);
      this.FlushPacket();
    }
  }

  /** CGameSession::SendAirplaneItemProb — 173 (needs iteminfo.txt). */
  /**
   * CGameSession::SendAirplaneItemProb (FxServer.exe.c:36930) — packet 173.
   * IsLadderGame (4209A6) is the constant-0 stub, so the >30000 clamp on
   * dword +12776 is dead code: the body is always the two raw dwords.
   */
  SendAirplaneItemProb(): void {
    const packet = new CSendPacket(GS_ClientSend.OnAirplaneItemProb, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode4(this.m_dwAirplaneItemProb >>> 0);
    packet.Encode4(this.m_dwArg76 >>> 0);
    this.SendPacket(packet);
  }
  /** CGameSession::IsLadderGame (vtbl+156) — the mission flag stands in. */
  IsLadderGame(): number {
    return this.m_nChiefSwapCount >= SUPREME_ROOM_SWAP_COUNT ? 1 : 0;
  }

  /** CGameSession::LaunchGameStage — packet 116 (FxServer.exe.c:37254). */
  LaunchGameStage(): void {
    const packet = new CSendPacket(GS_ClientSend.OnStartGame, CipherDegree.kPacketEncryptedCRC8);
    // DoLaunchGameStageEx is an empty `retn` in the original
    packet.Encode4(Date.now() & 0xffffffff);
    // the map idx rides through vtbl+24 = Encode2 (FxServer.exe.c:37289:
    // +28 E4 tick / +24 E2 mapIdx / +20 E1 cur) — an E4 here makes the
    // client read a garbage map index and crash on load
    packet.Encode2(this.m_nGameMapIdx & 0xffff);
    packet.Encode1(this.m_nCurPlayerNum); // +832 — GetPlayerNo(), not the max
    const tmpl = CGameMapTmplList.ms_pInstance!.m_apGameMapTmpl[this.m_nGameMapIdx];
    const spawns = Math.min(tmpl ? tmpl.m_nMaxPlayer : 8, 8);
    const order: number[] = [];
    for (let i = 0; i < spawns; i++) order.push(i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    let next = 0;
    const attr = CBomberAttr.ms_pInstance!;
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      this.m_aBomberIdx[slot] = -1;
      if (!this.IsPlayerSet(slot)) continue;
      let bomber = this.GetBomber(slot);
      if (bomber === attr.GetTotalCount() && attr.GetNormalCount() > 0) {
        if (Math.floor(Math.random() * 30) !== 0) {
          bomber = Math.floor(Math.random() * attr.GetNormalCount());
        } else {
          bomber = attr.GetNormalCount() + (Math.floor(Math.random() * 3) !== 0 ? 1 : 0);
        }
      }
      this.m_aBomberIdx[slot] = bomber;
      packet.Encode1(slot);
      if (this.m_nGameTypeMod !== 0) packet.Encode1(this.CheckIsCaptain(slot));
      else packet.Encode1(0);
      packet.Encode1(order[next++] ?? 0);
      packet.Encode1(bomber);
      packet.Encode1(this.GetColor(slot));
    }
    this.SendPacket(packet);
    // CDynInfoCalculator::Init(+11684) — the results-unit weights (m_rgPlayer,
    // and the slot-state triples whose +2 byte holds the colour)
    this.m_DynInfoCalculator.Init(this.m_rgPlayer, this.m_rgSlotState);
    this.m_UdpLossRegulator.Init();
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) this.m_abDeleted[slot] = this.IsPlayerSet(slot) ? 0 : 1;
    this.SetPlaying(1);
    // SetCurrentGameContext(0) + CGameContext::Init
    this.m_pCtx.Init();
    this.m_rgnUsedItem.fill(0); // memset(+11652, 0, 0x20)
    this.m_abDeleted.fill(0);
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) this.m_abDeleted[slot] = this.IsPlayerSet(slot) ? 0 : 1;
    this.m_rgSlotGhost.fill(-1); // memset(+872, -1, 0x20)
    this.m_rgGhostSlot.fill(-1); // memset(+904, -1, 0x20)
    this.m_nGhostCount = 0; // +936
    this.m_dwLastGhostTime = 0; // +940
    this.m_dwLaunchTime = Date.now() & 0xffffffff;
    this.m_nGhostStart = tmpl ? tmpl.m_nArg60 : 0; // +12560 ← tmpl+60 (seconds; ×1000 at DoStartGame)
    this.m_nGhostFreq = tmpl ? tmpl.m_nArg64 : 0; // +12564 ← tmpl+64
    this.m_dwAirplaneItemProb = tmpl ? tmpl.m_dwAirplaneItemProb : 0; // +12776 ← tmpl+72
    this.m_dwArg76 = tmpl ? tmpl.m_dwArg76 : 0; // +12780 ← tmpl+76
    // MissionInfo::operator= (+12748 ← tmpl+108..+120) — the server never
    // reads dwords 1..3 or the LapTileInfo vector copy back.
    for (let i = 0; i < 4; i++) this.m_MissionInfo[i] = tmpl ? [tmpl.m_nMissionType, tmpl.m_nLapTileCount, tmpl.m_nLapTime, tmpl.m_nLapBonus][i]! : 0;
    this.m_rgLapTime.fill(-1); // fill(_QWORD*)+12632..+12696 = -1 (the 8 {time,rank} pairs)
    this.m_rgLapRank.fill(-1);
    this.m_rgLapCount.fill(0); // +12696..+12727 = 0
    this.SendAirplaneItemProb();
  }

  /** CGameSession::OnRequestStartGame — 106 (FxServer.exe.c:37434). */
  OnRequestStartGame(_n: CReceivedPacket, socket: CClientSocket): void {
    const user0 = socket.GetUser(0);
    if (!user0) {
      console.error(`[GS] Null player sent socket. Disconnect [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    const chiefSlot = this.m_nChiefSlotidx;
    if (chiefSlot >= MAX_SESSION_SLOTS) {
      console.error(`[GS] [Hacking suspected:${GetInfoStr(socket)}] No chief player exists but tried to start game, ${chiefSlot}`);
      this.DoBangPok();
      return;
    }
    const chiefUser = this.m_rgPlayer[chiefSlot];
    if (!chiefUser || chiefUser.m_pSocket !== socket) {
      console.error(`[GS] Hacking suspected [${GetInfoStr(socket)}]: Non-chief player request to start game`);
      socket.PostClosePacket();
      return;
    }
    if (this.m_fPlaying !== 0) return;
    // fold the sub colors (1,2,4,7) onto the main ones (0,3,5,6):
    // color -> target map, -1 = untouched (:37490); in-use colors are marked
    // with themselves, a claimed main is consumed by writing 0 into its slot
    const colorMap = new Int32Array(8).fill(-1);
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      if (this.IsPlayerSet(slot) && colorMap[this.GetColor(slot)] === -1) colorMap[this.GetColor(slot)] = this.GetColor(slot);
    }
    const claimMain = (idx: number): void => {
      if (colorMap[0] === -1) {
        colorMap[idx] = 0;
        colorMap[0] = 0;
      } else if (colorMap[3] === -1) {
        colorMap[idx] = 3;
        colorMap[3] = 0;
      } else if (colorMap[5] === -1) {
        colorMap[idx] = 5;
        colorMap[5] = 0;
      } else if (colorMap[6] === -1) {
        colorMap[idx] = 6;
        colorMap[6] = 0;
      }
    };
    if (colorMap[1] !== -1) claimMain(1);
    if (colorMap[2] !== -1) claimMain(2);
    if (colorMap[4] !== -1) claimMain(4);
    if (colorMap[7] !== -1) claimMain(7);
    this.SetMapIdxPlayingByLevel(chiefUser.dyn.exp, CClientSocket.HasAuthority(23), chiefUser.m_fPremiumTicket);
    const can = this.CanStartGame(0);
    const res = new CSendPacket(GS_ClientSend.OnStartGameRes, CipherDegree.kPacketEncryptedCRC8);
    res.Encode1(can);
    socket.SendPacket(res);
    if (can !== 0) return;
    if (CGameMapTmplList.ms_pInstance!.GetMapMaxTeam(this.m_nGameMapIdx) < MAX_SESSION_SLOTS) {
      let changed = false;
      const packet = new CSendPacket(0, CipherDegree.kPacketEncryptedCRC8);
      for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
        if (!this.IsPlayerSet(slot)) continue;
        const want = colorMap[this.GetColor(slot)]!;
        if (this.GetColor(slot) !== want) {
          const p = slot * 3 + 2;
          this.m_rgSlotState[p] = (this.m_rgSlotState[p]! ^ (want ^ this.m_rgSlotState[p]!)) & SLOTSTATE_COLOR_MASK;
          changed = true;
          this.MakeSetSlotStatePacket(slot, packet);
          this.PutPacket(packet);
        }
      }
      if (changed) this.FlushPacket();
    }
    this.LaunchGameStage();
    // LaunchGameStageEx (vtbl+200) is an empty `retn`
  }

  /** CGameSession::OnHackingSuspected — 186 (FxServer.exe.c:36160). */
  OnHackingSuspected(n: CReceivedPacket, socket: CClientSocket): void {
    const user0 = socket.GetUser(0);
    if (!user0 || user0.GetName().length === 0) {
      console.error(`[GS] Null player sent socket. Disconnect [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    const slot = n.Decode1();
    const serial = n.Decode4();
    const code = n.Decode1();
    if (slot >= MAX_SESSION_SLOTS) {
      console.error(`[GS] Hacking suspected [${user0.GetName()}]: illegal slotidx (OnHackingSuspected)`);
      socket.PostClosePacket();
      return;
    }
    const target = this.m_rgPlayer[slot];
    if (!target || target.GetGlobalSerialNo() !== serial) return;
    const names = [
      "khcFailedGameContextSync",
      "kBombIgniteIllegalSlotidx",
      "kMovableBoxNotFound",
      "",
      "kEatObstacle",
      "khcSpecialItemWrong",
      "khcSpecialItemOverflow",
      "kSpecialItemShort",
    ];
    if (code === 3 || code === 8) return;
    if (code >= names.length) {
      console.error(`[GS] Hacking suspected [${user0.GetName()}]: illegal hacking code (OnHackingSuspected)`);
      const p = new CSendPacket(GS_ClientSend.OnHackingKick, CipherDegree.kPacketEncryptedCRC8);
      p.Encode1(slot);
      this.SendPacketExclude(p, socket);
      socket.SendPacketAndDestroy(p);
      return;
    }
    console.error(`[GS] [${user0.GetName()}] reported [${target.GetName()}] committed hacking (${names[code]}).`);
    if (target.m_pSocket === socket) {
      console.error(`[GS] Hacking suspected [${target.GetName()}] (${GetInfoStr(socket)}) by itself. Disconnect.`);
      const p = new CSendPacket(GS_ClientSend.OnHackingKick, CipherDegree.kPacketEncryptedCRC8);
      p.Encode1(slot);
      this.SendPacketExclude(p, socket);
      socket.SendPacketAndDestroy(p);
      return;
    }
    let reports = 0;
    let players = 0;
    const reporterSlot = this.GetSlotidx(user0);
    if (reporterSlot >= 0 && reporterSlot < MAX_SESSION_SLOTS) this.m_rgVoteMatrix[slot * 8 + reporterSlot] = 1;
    for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
      if (this.m_rgPlayer[i]) {
        players++;
        if (this.m_rgVoteMatrix[slot * 8 + i] !== 0) reports++;
      } else if (this.m_rgVoteMatrix[slot * 8 + i] !== 0) {
        console.error("[GS] Hacking Info Doesn't Sync");
        this.m_rgVoteMatrix[slot * 8 + i] = 0;
      }
    }
    if (reports < Math.floor(players / 2)) return;
    console.error(`[GS] Hacking suspected [${target.GetName()}] by major of the session. Disconnect.`);
    const p = new CSendPacket(GS_ClientSend.OnHackingKick, CipherDegree.kPacketEncryptedCRC8);
    p.Encode1(slot);
    this.SendPacketExclude(p, target.m_pSocket!);
    target.m_pSocket!.SendPacketAndDestroy(p);
  }

  /** CGameSession::OnPacket — the room dispatch (FxServer.exe.c:37668). */
  // ==================== the in-play stage (CGameSession::OnPacket 140..162 / 185) ====================

  /** CGameSession::IsMySocket (vtbl+188) — m_rgPlayer[slot] lives on this socket. */
  IsMySocket(slot: number, socket: CClientSocket): number {
    return this.m_rgPlayer[slot]?.m_pSocket === socket ? 1 : 0;
  }

  /** CGameSession::IsSlotInThisSocket (vtbl+192). */
  IsSlotInThisSocket(slot: number, socket: CClientSocket): number {
    if (slot >= MAX_SESSION_SLOTS) {
      console.error(`[GS] illegal user request. - nIdx < 0 || nIdx >= kFxPlayerMaxNo, nIdx = ${slot}`);
      return 0;
    }
    const user = this.m_rgPlayer[slot];
    if (!user) {
      console.error("[GS] illegal user request. - m_rgPlayer == NULL");
      return 0;
    }
    if (user.GetSelfidx() < 0) {
      console.error("[GS] illegal user request. - Selfidx < 0");
      return 0;
    }
    if (user.m_pSocket === socket) return 1;
    console.error("[GS] illegal user request. - GetSocket() != pSocket");
    return 0;
  }

  /** CGameSession::OnBombIgnite (140, FxServer.exe.c:41E5AC). */
  OnBombIgnite(n: CReceivedPacket, socket: CClientSocket): void {
    const slot = n.Decode1();
    if (this.IsMySocket(slot, socket) === 0) {
      console.error(`[GS] slotidx and socket doesn't match: hacking suspected [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    const ctx = this.m_pCtx;
    if (ctx.m_nBombCount >= 150) {
      console.error(`[GS] Bomb array overflow. Disconnect user[${this.m_rgPlayer[slot]?.GetName()}] (${GetInfoStr(socket)})`);
      socket.PostClosePacket();
      return;
    }
    const pos = n.Decode1();
    const attr = n.Decode1();
    const bomb = {
      id: ctx.m_nBombIdCounter++,
      fMoving: 0,
      timer: 2800,
      x: pos >> 4,
      y: pos & 0xf,
      sub: attr & 0xf,
      fFlag16: attr & 0x40 ? 1 : 0,
    };
    ctx.m_rgBomb[ctx.m_nBombCount] = bomb;
    const packet = new CSendPacket(GS_ClientSend.OnBombIgniteRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(slot);
    packet.Encode1(((pos >> 4) << 4) | (pos & 0xf));
    packet.Encode1(attr);
    packet.Encode2(bomb.id);
    this.SendPacket(packet);
    ctx.m_nBombCount++;
  }

  /** CGameSession::OnBombKickThrow (141, FxServer.exe.c:41E74E). */
  OnBombKickThrow(n: CReceivedPacket, socket: CClientSocket): void {
    const slotCode = n.Decode1();
    const slot = slotCode & 0xf;
    const bombId = n.Decode2();
    const pos = n.Decode1();
    if (this.IsMySocket(slot, socket) === 0) {
      console.error(`[GS] slotidx and socket doesn't match: hacking suspected [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    const ctx = this.m_pCtx;
    let idx = 0;
    while (idx < ctx.m_nBombCount && ctx.m_rgBomb[idx]!.id !== bombId) idx++;
    if (idx >= ctx.m_nBombCount) return;
    const bomb = ctx.m_rgBomb[idx]!;
    if (bomb.x !== pos >> 4 || bomb.y !== (pos & 0xf) || bomb.fMoving !== 0) return;
    const newPos = n.Decode1();
    bomb.x = newPos >> 4;
    bomb.y = newPos & 0xf;
    bomb.fMoving = 1;
    bomb.timer = n.Decode2();
    const packet = new CSendPacket(GS_ClientSend.OnBombKickThrowRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(slotCode);
    packet.Encode2(bombId);
    packet.Encode1(((newPos >> 4) << 4) | (newPos & 0xf));
    this.SendPacket(packet);
  }

  /** CGameSession::OnSetBombTimer (142, FxServer.exe.c:32034) — a client shortens the fuse. */
  OnSetBombTimer(n: CReceivedPacket, _socket: CClientSocket): void {
    const bombId = n.Decode2();
    const pos = n.Decode1();
    const timer = n.Decode2();
    const ctx = this.m_pCtx;
    let idx = 0;
    while (idx < ctx.m_nBombCount && ctx.m_rgBomb[idx]!.id !== bombId) idx++;
    if (idx >= ctx.m_nBombCount) return;
    const bomb = ctx.m_rgBomb[idx]!;
    if (bomb.x !== pos >> 4 || bomb.y !== (pos & 0xf) || bomb.fMoving !== 0) return;
    if (bomb.timer > timer) bomb.timer = timer;
    bomb.fFlag16 = 0;
  }

  /** CGameSession::OnMovableBoxMove (143, FxServer.exe.c:32082) — a plain 4-byte relay. */
  OnMovableBoxMove(n: CReceivedPacket, _socket: CClientSocket): void {
    const a = n.Decode1();
    const b = n.Decode1();
    const c = n.Decode1();
    const d = n.Decode1();
    const packet = new CSendPacket(GS_ClientSend.OnMovableBoxMoveRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(a);
    packet.Encode1(b);
    packet.Encode1(c);
    packet.Encode1(d);
    this.SendPacket(packet);
  }

  /** CGameSession::OnRequestEatItem (144, FxServer.exe.c:41EA50). */
  OnRequestEatItem(n: CReceivedPacket, socket: CClientSocket): void {
    const user0 = socket.GetUser(0);
    if (!user0 || user0.GetName().length === 0) {
      console.error(`[GS] Null player requested to eat item. Disconnect [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    const slot = n.Decode1();
    const box = n.Decode1();
    const item = n.Decode1();
    if (this.IsSlotInThisSocket(slot, socket) === 0) {
      console.error(`[GS] illegal user requested to eat item. disconnect [${user0.GetName()}].`);
      return;
    }
    const eater = this.m_rgPlayer[slot];
    if (slot >= MAX_SESSION_SLOTS) {
      console.error("[GS] player of invalid slotidx requested to eat item");
      socket.PostClosePacket();
      return;
    }
    if (box >= 250) {
      if (eater) console.error(`[GS] Invalid box idx from user[${eater.GetName()}], Disconnect player`);
      socket.PostClosePacket();
      return;
    }
    const itemAttr = CItemAttr.ms_pInstance!;
    if (item >= itemAttr.m_vtName.length) {
      if (eater) console.error(`[GS] Invalid item idx from user [${eater.GetName()}], Disconnect player.`);
      socket.PostClosePacket();
      return;
    }
    if (this.m_pCtx.m_rgnBoxItem[box] !== 0) return;
    this.m_pCtx.m_rgnBoxItem[box] = 1;
    const packet = new CSendPacket(GS_ClientSend.OnRequestEatItemRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(slot);
    packet.Encode1(box);
    packet.Encode1(item);
    if (itemAttr.m_vtEffect[item] === 99) {
      let count = 1;
      if (eater && (eater.m_fPremiumTicket & 0xff) === 1) count = Math.floor(Math.random() * 2) + 1; // user+2004 byte
      packet.Encode1(count);
      const lucci = count * itemAttr.m_vtAmount[item]!;
      if (lucci > 10000) console.error(`[GS] suspicious on lucci amount ${lucci}`);
      eater?.IncDecMoney(lucci);
    }
    this.SendPacket(packet);
  }

  /** CGameSession::OnRequestEatObstacle (145, FxServer.exe.c:41ECA3). */
  OnRequestEatObstacle(n: CReceivedPacket, socket: CClientSocket): void {
    const slot = n.Decode1();
    const pos = n.Decode1();
    const user0 = socket.GetUser(0);
    if (!user0 || user0.GetName().length === 0) {
      console.error(`[GS] OnRequestEatObstacle User none [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    if (this.IsSlotInThisSocket(slot, socket) === 0) {
      console.error(`[GS] OnRequestEatObstacle slotidx and socket doesn't match: hacking suspected [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    const obstacleId = (pos & 0xf) + 15 * (pos >> 4);
    if (obstacleId > 0xc2) {
      console.error(`[GS] Invalid obstacle id from user[${user0.GetName()}], Disconnect player`);
      socket.PostClosePacket();
      return;
    }
    if (this.m_pCtx.m_rgnObstacle[obstacleId] !== 0) return;
    this.m_pCtx.m_rgnObstacle[obstacleId] = 1;
    const packet = new CSendPacket(GS_ClientSend.OnRequestEatObstacleRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(slot);
    packet.Encode1(pos);
    this.SendPacket(packet);
  }

  /** CGameSession::OnSetBomberEvent (146, FxServer.exe.c:41EE05) — the event umbrella. */
  OnSetBomberEvent(n: CReceivedPacket, socket: CClientSocket): void {
    if (this.m_fPlaying === 0) return;
    const slotCode = n.Decode1();
    const a = n.Decode2();
    const b = n.Decode2();
    const packet = new CSendPacket(GS_ClientSend.OnBomberEvent, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(slotCode);
    packet.Encode2(a);
    packet.Encode2(b);
    const slot = slotCode & 0xf;
    const event = slotCode >> 4;
    if (slot >= MAX_SESSION_SLOTS || this.IsMySocket(slot, socket) === 0) {
      console.error(`[GS] slotidx and socket doesn't match: hacking suspected [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    const ctx = this.m_pCtx;
    switch (event) {
      case 0: {
        // UseSpecialItem
        const x = n.Decode1();
        const itemidx = n.Decode1();
        const count = n.Decode1();
        if (count !== 0) {
          if (CMainSystem.ms_pInstance!.m_nChannelType === 108) {
            console.error(`[GS] ${this.m_rgPlayer[slot]?.GetName()} Try to Use ShopItem at NoShopItemServer`);
            return;
          }
          this.m_rgnUsedItem[slot] = 1;
          this.m_rgnShopItem[slot] = 1;
          const sn = n.Decode4();
          const user = this.m_rgPlayer[slot];
          const inv = user ? user.GetUserInventory(sn) : null;
          let underflow = false;
          if (inv) {
            underflow = inv.Amount - count < 0;
            inv.Amount -= count;
            inv.fModified = 1;
            if (underflow) inv.Amount = 0;
          }
          if (!inv || underflow) {
            console.error("[GS] Tried to use nonresident Item..Disconnect user");
            socket.PostClosePacket();
            return;
          }
        }
        const itemAttr = CItemAttr.ms_pInstance!;
        if (itemidx < 0 || itemidx >= itemAttr.m_vtName.length) {
          console.error(`[GS] Illegal itemidx (UseSpecialItem). Disconnect [${GetInfoStr(socket)}].`);
          socket.PostClosePacket();
          return;
        }
        const effect = itemAttr.m_vtEffect[itemidx]!;
        if (effect === 22) {
          if (this.m_abDeleted[slot] === 3) ctx.m_rgnDownTime[slot] = this.m_GameClock.ElapsedTime() | 0;
        } else if (!((effect >= 11 && effect <= 13) || effect === 21 || (effect > 22 && effect <= 28) || effect === 31 || effect === 32)) {
          console.error(`[GS] Illegal item effect (UseSpecialItem). Disconnect [${GetInfoStr(socket)}].`);
          socket.PostClosePacket();
          return;
        }
        packet.Encode1(x);
        packet.Encode1(itemidx);
        packet.Encode1(count);
        this.SendPacketExclude(packet, socket);
        break;
      }
      case 1:
      case 7:
        this.SendPacketExclude(packet, socket);
        break;
      case 2: {
        this.m_abDeleted[slot] = 3;
        ctx.m_rgnDownTime[slot] = this.m_GameClock.ElapsedTime() | 0;
        ctx.m_rgnDiePos[2 * slot] = a & 0xffff;
        ctx.m_rgnDiePos[2 * slot + 1] = b & 0xffff;
        this.SendPacketExclude(packet, socket);
        break;
      }
      case 3: {
        const saver = n.Decode1();
        if (saver < MAX_SESSION_SLOTS) this.m_DynInfoCalculator.SetSaverIndex(slot, saver); // the first save feeds GetWinExp/GetDrawExp
        this.m_abDeleted[slot] = 0;
        this.SendPacketExclude(packet, socket);
        break;
      }
      case 4: {
        // the death report
        let killer = n.Decode1();
        killer = (killer << 24) >> 24; // signed char
        if (killer !== -1) this.m_DynInfoCalculator.SetKillerIndex(killer);
        packet.Encode1(killer);
        this.OnBomberDie(slot);
        const drops = n.Decode1();
        packet.Encode1(drops);
        if (drops > 0) {
          for (let i = 0; i < drops; i++) {
            const obspos = n.Decode1(); // byte 1 → the obstacle grid (+4032)
            const boxpos = n.Decode1(); // byte 2 → the box-item table (+3032)
            ctx.m_rgnObstacle[(obspos & 0xf) + 15 * (obspos >> 4)] = 0;
            ctx.m_rgnBoxItem[boxpos] = 0;
            packet.Encode1(obspos);
            packet.Encode1(boxpos);
          }
        }
        this.SendPacket(packet);
        if (this.m_abDeleted[slot] !== 4) {
          this.m_abDeleted[slot] = 1;
          ctx.m_rgnDownTime[slot] = this.m_GameClock.ElapsedTime() | 0;
        }
        return;
      }
      case 5:
        console.error("[GS] user tried to send die by server packet");
        this.SendPacketExclude(packet, socket);
        break;
      case 6:
        this.m_abDeleted[slot] = 2;
        this.SendPacketExclude(packet, socket);
        break;
      case 8: {
        const v = n.Decode1();
        const w = n.Decode1();
        packet.Encode1(v);
        packet.Encode1(w); // lst 41F1D3-41F203: both bytes echo
        this.SendPacketExclude(packet, socket);
        break;
      }
      default:
        console.error("[GS] user tried to send invalid set bomber event packet");
        return;
    }
  }

  /** CGameSession::OnSetEffect (147, FxServer.exe.c:41CA78) — the raw buffer relay. */
  OnSetEffect(n: CReceivedPacket, socket: CClientSocket): void {
    const packet = new CSendPacket(GS_ClientSend.OnEffectRes, CipherDegree.kPacketEncryptedCRC8);
    packet.EncodeBuffer(n.m_pBlock.subarray(n.m_uOffset), n.m_uLength - n.m_uOffset);
    this.SendPacketExclude(packet, socket);
  }

  /** CGameSession::OnDropObstacle (148, FxServer.exe.c:41B2E0). */
  OnDropObstacle(n: CReceivedPacket, socket: CClientSocket): void {
    const a = n.Decode1();
    const pos = n.Decode1();
    this.m_pCtx.m_rgnObstacle[(pos & 0xf) + 15 * (pos >> 4)] = 0;
    const packet = new CSendPacket(GS_ClientSend.OnDropObstacleRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(a);
    packet.Encode1(pos);
    this.SendPacketExclude(packet, socket);
  }

  /** CGameSession::OnEventItem (149, FxServer.exe.c:41F28B) — the 30 announcement. */
  OnEventItem(n: CReceivedPacket, socket: CClientSocket): void {
    const idx = n.Decode1();
    if (idx >= socket.GetUserCount()) {
      console.error(`[GS] Tried to eat event item by illegal user in the session(${this.m_nIdx})`);
      return;
    }
    const itemName = n.DecodeStr();
    const eater = socket.GetUser(idx)!;
    console.log(`[GS] Event Item(${itemName}) eaten by User(${eater.GetName()}) in the session(${this.m_nIdx})`);
    const packet = new CSendPacket(GS_ClientSend.OnSystemMsg, CipherDegree.kPacketEncryptedCRC8); // id 30 (OnEventItemMsg shares the OnSystemMsg id)
    packet.EncodeStr(eater.GetName());
    this.SendPacket(packet);
  }

  /** CGameSession::OnDestroyBox (150, FxServer.exe.c:41B376) — a plain 3-byte relay. */
  OnDestroyBox(n: CReceivedPacket, _socket: CClientSocket): void {
    const a = n.Decode1();
    const b = n.Decode1();
    const c = n.Decode1();
    const packet = new CSendPacket(GS_ClientSend.OnDestroyBoxRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(a);
    packet.Encode1(b);
    packet.Encode1(c);
    this.SendPacket(packet);
  }

  /** CGameSession::OnRequestGenerateGhost (151, FxServer.exe.c:41F3F1). */
  OnRequestGenerateGhost(n: CReceivedPacket, socket: CClientSocket): void {
    const user0 = socket.GetUser(0);
    if (!user0 || user0.GetName().length === 0) {
      console.error(`[GS] Null player sent socket. Disconnect [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    const tag = n.Decode1();
    const slot = n.Decode1();
    if (this.IsSlotInThisSocket(slot, socket) === 0) {
      console.error(`[GS] illegal user requested to Generate Ghost. disconnect [${user0.GetName()}].`);
      return;
    }
    if (slot >= MAX_SESSION_SLOTS) {
      console.error(`[GS] Illegal slot idx(OnRequestGenerateGhost). Disconnect [${user0.GetName()}].`);
      socket.PostClosePacket();
      return;
    }
    const now = CGameClock.Now();
    if (
      (this.m_dwLastGhostTime === 0 || ((now - this.m_dwLastGhostTime) >>> 0) >= this.m_nGhostFreq) &&
      this.m_GameClock.ElapsedTime() >= this.m_nGhostStart &&
      this.m_nGhostCount < MAX_SESSION_SLOTS
    ) {
      if (this.m_rgSlotGhost[slot] !== -1) {
        if (this.m_nGhostFreq === 0) return;
        if (this.m_rgGhostSlot[this.m_rgSlotGhost[slot]!] !== slot) console.error("[GS] Mapping is inconsistent ghostidx to slotidx.");
        console.error("[GS] Player having ghost tried to generate more ghost: There must be a leg.");
        console.error(
          `[GS]     - LastGhost:${this.m_dwLastGhostTime}   CurTime:${now}   Diff:${(now - this.m_dwLastGhostTime) | 0}   - GhostStart:${this.m_nGhostStart}   GhostFreq:${this.m_nGhostFreq}   GameStart:0   Elapsed:${this.m_GameClock.ElapsedTime()}`,
        );
        if (this.IsMySocket(slot, socket) === 0) console.error("[GS]     Socket Mismatch!");
        console.error(`[GS]       User[${user0.GetName()}]    slotidx:${slot}   GhostCount:${this.m_nGhostCount}`);
        console.error("[GS]     - Slot->Ghost - Ghost->Slot -");
        for (let i = 0; i < MAX_SESSION_SLOTS; i++) console.error(`[GS]       ${this.m_rgSlotGhost[i]}       ${this.m_rgGhostSlot[i]}     `);
        this.DumpLog();
        return;
      }
      let ghost = 0;
      while (ghost < MAX_SESSION_SLOTS && this.m_rgGhostSlot[ghost] !== -1) ghost++;
      if (ghost < MAX_SESSION_SLOTS) {
        this.m_dwLastGhostTime = now;
        this.m_rgGhostSlot[ghost] = slot;
        this.m_rgSlotGhost[slot] = ghost;
        this.m_nGhostCount++;
        const packet = new CSendPacket(GS_ClientSend.OnGhostGenerate, CipherDegree.kPacketEncryptedCRC8);
        packet.Encode1(ghost);
        packet.Encode1(slot | 0x80);
        packet.Encode1(tag);
        this.SendPacket(packet);
      }
    }
  }

  /** CGameSession::DumpLog (vtbl+20, 41E0D5) — the diagnostic dump; state-free. */
  DumpLog(): void {}

  /** CGameSession::OnRequestDestroyGhost (152, FxServer.exe.c:41B3FF). */
  OnRequestDestroyGhost(n: CReceivedPacket, _socket: CClientSocket): void {
    const idx = n.Decode1();
    if (idx >= MAX_SESSION_SLOTS) {
      console.error("[GS] Wrong Ghostdestroy idx input");
      return;
    }
    const slot = this.m_rgGhostSlot[idx]!;
    if (slot === -1) return;
    if (this.m_rgSlotGhost[slot] === idx) {
      this.m_rgGhostSlot[idx] = -1;
      this.m_rgSlotGhost[slot] = -1;
      this.m_nGhostCount--;
      const packet = new CSendPacket(GS_ClientSend.OnGhostDestroy, CipherDegree.kPacketEncryptedCRC8);
      packet.Encode1(idx);
      this.SendPacket(packet);
    } else {
      console.error("[GS] Ghost idx mismatch to slot idx ");
    }
  }

  /** CGameSession::OnLapFinished (154, FxServer.exe.c:36502) — the first finisher only. */
  OnLapFinished(n: CReceivedPacket, socket: CClientSocket): void {
    const slot = n.Decode1();
    const user = this.m_rgPlayer[slot];
    if (!user || user.m_pSocket !== socket) {
      console.error(`[GS] slotidx and socket doesn't match: hacking suspected [${GetInfoStr(socket)}].`);
      socket.PostClosePacket();
      return;
    }
    for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
      if (this.m_rgPlayer[i] && this.m_abDeleted[i] === 5) return;
    }
    this.m_abDeleted[slot] = 5;
  }

  /** CGameSession::OnLapInfo (155, FxServer.exe.c:41B5E9) — the 170 rank broadcast. */
  OnLapInfo(n: CReceivedPacket, _socket: CClientSocket): void {
    const slot = n.Decode1();
    if (slot >= MAX_SESSION_SLOTS) {
      console.error(`[GS] [CGameSession::OnLapInfo] User sent invalid slot idx, slotidx=${slot}`);
      return;
    }
    const lap = n.Decode1();
    const v = n.Decode1();
    const rank = ((255 - v) | ((255 - lap) << 8)) & 0xffff;
    const now = CGameClock.Now();
    this.m_rgLapTime[2 * slot] = now | 0;
    this.m_rgLapRank[2 * slot] = rank;
    this.m_rgLapCount[slot] = lap;
    // the pairwise place table (times at +12632, ranks at +12636)
    const place = new Int32Array(8).fill(1);
    let count = 0;
    for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
      if (this.m_rgPlayer[i] && !(this.m_rgLapTime[2 * i] === -1 && this.m_rgLapRank[2 * i] === -1)) count++;
    }
    // the original compares the packed u64 {time,rank} — rank is the primary key
    for (let i = 0; i < 7; i++) {
      if (!this.m_rgPlayer[i]) continue;
      const a = BigInt(this.m_rgLapRank[2 * i]! >>> 0) * 0x100000000n + BigInt(this.m_rgLapTime[2 * i]! >>> 0);
      for (let k = i + 1; k < MAX_SESSION_SLOTS; k++) {
        if (!this.m_rgPlayer[k]) continue;
        const b = BigInt(this.m_rgLapRank[2 * k]! >>> 0) * 0x100000000n + BigInt(this.m_rgLapTime[2 * k]! >>> 0);
        if (a <= b) place[k]!++;
        else place[i]!++;
      }
    }
    const packet = new CSendPacket(GS_ClientSend.OnLapInfoRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(count);
    for (let i = 0; i < MAX_SESSION_SLOTS; i++) {
      if (this.m_rgPlayer[i]) {
        // a seated slot always encodes its place/laps (place stays 1 while the
        // pair is still {−1,−1}); only truly empty slots get the 255 marker
        packet.Encode1(place[i]!);
        packet.Encode1(this.m_rgLapCount[i]!);
      } else {
        packet.Encode1(255);
        packet.Encode1(255);
      }
    }
    this.SendPacket(packet);
  }

  /** CGameSession::OnRequestAirplane (156, FxServer.exe.c:41D7C0). */
  OnRequestAirplane(n: CReceivedPacket, socket: CClientSocket): void {
    const now = CGameClock.Now();
    if (this.m_dwLastAirplaneTime + 7000 > now) return;
    const count = n.Decode1();
    if (count === 0 || count > 3) console.error(`[GS] Strange Request Airplane, nCount=${count}`);
    const packet = new CSendPacket(GS_ClientSend.OnRequestAirplaneRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode4((now + 2000) >>> 0);
    packet.Encode1(count);
    const boxes: number[] = [];
    for (let i = 0; i < count; i++) {
      const a = n.Decode1();
      const box = n.Decode1();
      const b = n.Decode1();
      const c = n.Decode1();
      if (box >= 250) {
        const user = socket.GetUser(0);
        if (user) console.error(`[GS] Invalid box idx from user[${user.GetName()}], Disconnect player`);
        socket.PostClosePacket();
        return;
      }
      packet.Encode1(a);
      packet.Encode1(box);
      packet.Encode1(b);
      packet.Encode1(c);
      boxes.push(box);
    }
    for (const box of boxes) this.m_pCtx.m_rgnBoxItem[box] = 0;
    this.m_dwLastAirplaneTime = now + 2000;
    this.SendPacket(packet);
  }

  /** CSyncGameObjMan::OnReqCreateObj (158) / OnReqDestroyObj (159). */
  OnReqCreateObj(n: CReceivedPacket, socket: CClientSocket): void {
    this.m_SyncGameObjMan.OnReqCreateObj(n, socket);
  }
  OnReqDestroyObj(n: CReceivedPacket, socket: CClientSocket): void {
    this.m_SyncGameObjMan.OnReqDestroyObj(n, socket);
  }

  /** CGameSession::OnReqEatBula (160, FxServer.exe.c:41CBB2). */
  OnReqEatBula(n: CReceivedPacket, _socket: CClientSocket): void {
    const slot = n.Decode1();
    const count = n.Decode1();
    const packet = new CSendPacket(GS_ClientSend.OnReqEatBulaRes, CipherDegree.kPacketEncryptedCRC8);
    const countOffset = packet.m_uOffset;
    packet.Encode1(0);
    if (count > 0) {
      let left = count;
      do {
        const x = n.Decode1();
        const y = n.Decode1();
        packet.Encode1(x);
        packet.Encode1(y);
        packet.Encode1(slot);
        this.m_pCtx.SetBulaState(x, y, slot);
      } while (--left !== 0);
    }
    packet.Encode1At(countOffset, count & 0xff);
    this.SendPacket(packet);
  }

  /** CGameSession::OnReqTakeHouse (161, FxServer.exe.c:41D941). */
  OnReqTakeHouse(n: CReceivedPacket, socket: CClientSocket): void {
    const slot = n.Decode1();
    const total = n.Decode1();
    const color = this.GetColor(slot); // already masked — the SetHouseState team index
    const packet = new CSendPacket(GS_ClientSend.OnReqTakeHouseRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(slot);
    const houseCountOffset = packet.m_uOffset;
    packet.Encode1(0);
    let taken = 0;
    for (let left = total; left > 0; left--) {
      const row = n.Decode1();
      const col = n.Decode1();
      if (row < 13 && col < 15 && this.m_pCtx.GetHouseState(row, col) === -1) {
        packet.Encode1(row);
        packet.Encode1(col);
        taken++;
        this.m_pCtx.SetHouseState(row, col, slot, color);
      }
    }
    packet.Encode1At(houseCountOffset, taken & 0xff);
    packet.Encode1(5);
    const boxTotal = n.Decode1();
    const boxCountOffset = packet.m_uOffset;
    packet.Encode1(0);
    for (let i = 0; i < boxTotal; i++) {
      const a = n.Decode1();
      const b = n.Decode1();
      const c = n.Decode1();
      const box = this.m_pCtx.AddBoxItem();
      if (box === -1) break;
      packet.Encode1(a);
      packet.Encode1(box);
      packet.Encode1(b);
      packet.Encode1(c);
    }
    packet.Encode1At(boxCountOffset, boxTotal & 0xff);
    this.SendPacket(packet);
    this.m_rgPlayer[slot]?.IncDecMoney(5 * taken);
  }

  /** CGameSession::OnShobuari (162, FxServer.exe.c:41CC8B) — settle the score, no packet. */
  OnShobuari(): void {
    let bestColor = -1;
    let bestScore = -1;
    let tie = 0;
    const present = new Uint8Array(8);
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      if (!this.m_rgPlayer[slot]) continue;
      const code = this.m_abDeleted[slot]!;
      if (code !== 1 && code !== 4 && this.GetColor(slot) < MAX_SESSION_SLOTS) present[this.GetColor(slot)] = 1;
    }
    for (let color = 0; color < MAX_SESSION_SLOTS; color++) {
      if (!present[color]) continue;
      const score = this.m_pCtx.m_rgnTeamScore[color]!;
      if (score > bestScore) {
        bestScore = score;
        bestColor = color;
        tie = 0;
      } else if (score === bestScore) {
        tie = 1;
      }
    }
    if (tie !== 0 || bestColor === -1) {
      for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
        if (this.m_rgPlayer[slot]) this.m_abDeleted[slot] = 7;
      }
    } else {
      for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
        if (this.m_rgPlayer[slot] && this.GetColor(slot) === bestColor && this.m_abDeleted[slot] !== 1) {
          this.m_abDeleted[slot] = 6;
        }
      }
    }
  }

  /** CGameSession::OnNotifyUDPLoss (185, 41D0BC) — tell the blamed slot to relay (54). */
  OnNotifyUDPLoss(n: CReceivedPacket, socket: CClientSocket): void {
    const slot = n.Decode1();
    if (slot >= MAX_SESSION_SLOTS) return;
    const target = this.m_rgPlayer[slot];
    if (!target || target.m_nFree !== 0) return; // CUser+20 — the live-object mark
    const user0 = socket.GetUser(0);
    const senderSlot = user0 ? user0.m_nSlotIdx : 8;
    if (senderSlot < MAX_SESSION_SLOTS) {
      const packet = new CSendPacket(GS_ClientSend.OnRequestUDPRelayRes, CipherDegree.kPacketEncryptedCRC8);
      packet.Encode1(senderSlot);
      target.m_pSocket?.SendPacket(packet);
    }
  }

  /**
   * CGameSession::OnReadyForImmediateStart (109, FxServer.exe.c:41D431).
   * The original validates the map CRC against CGameMapTmpl +88 and the four
   * attrs against CBomberAttr / m_aBomberIdx before opening the start gate
   * ("Hacking suspected" + disconnect).  Those checks are deliberately
   * dropped: the client CRCs the same FxServer.idx entry, so any drift in
   * our template parse turned into a false positive that blocked every
   * launch.  The packet fields are still decoded to keep the wire layout,
   * and the boarding guard stays (the original ignores 109 while the
   * socket's roster is not fully seated).
   */
  OnReadyForImmediateStart(n: CReceivedPacket, socket: CClientSocket): void {
    if (this.m_fPlaying === 0 || this.m_nGamePhase !== 0) return;
    n.Decode4(); // the map CRC — check removed
    const userCount = socket.GetUserCount();
    for (let i = 0; i < userCount; i++) {
      const user = socket.GetUser(i)!;
      if (!this.m_rgPlayer[user.m_nSlotIdx]) return; // still boarding
    }
    for (let i = 0; i < userCount; i++) {
      n.Decode1(); // bomberidx
      n.Decode1(); // bombcount
      n.Decode1(); // bombpower
      n.Decode1(); // speed
    }
    for (let i = 0; i < userCount; i++) {
      const slot = socket.GetUser(i)!.m_nSlotIdx;
      this.m_rgSlotState[3 * slot] = (this.m_rgSlotState[3 * slot]! & SLOTSTATE_GROUP_CLEAR) | SLOTSTATE_LAUNCH_OK;
    }
    this.DeferStartGame();
  }

  /** CGameSession::DeferStartGame (vtbl+148, 41BF1B). */
  DeferStartGame(): void {
    if (this.IsAllPlayerReadyForStart() !== 0) this.DoStartGame();
  }

  /** CGameSession::IsAllPlayerReadyForStart (31906). */
  IsAllPlayerReadyForStart(): number {
    if (this.m_nCurPlayerNum === 0) return 0;
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      const user = this.m_rgPlayer[slot];
      if (user && (this.m_rgUdpAlive[slot] === 0 || (this.m_rgSlotState[3 * slot]! & SLOTSTATE_GROUP_MASK) !== SLOTSTATE_LAUNCH_OK)) return 0;
    }
    return 1;
  }

  /** CGameSession::DoStartGame (32879) — the 150 kickoff. */
  DoStartGame(): void {
    this.m_SyncGameObjMan.Init(this);
    const tmpl = this.m_nGameMapIdx >= 0 ? CGameMapTmplList.ms_pInstance!.m_apGameMapTmpl[this.m_nGameMapIdx] : undefined;
    this.m_SyncGameObjMan.SetInitialObjNo(tmpl ? tmpl.m_nArg84 : 0);
    this.m_nObj0 = -1; // +11612
    this.m_nObj1 = -1; // +11616
    this.m_GameClock.StartGame();
    CGameSessionTable.ms_pInstance!.ClearModifiedFlag(this.m_nIdx); // the table vtbl+12
    this.m_nBombTickTime = 0; // +12552 (dword 3138)
    this.m_nGamePhase = 1;
    const packet = new CSendPacket(GS_ClientSend.OnStartGame2, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode4(this.m_dwStartSeed);
    packet.Encode4((this.m_nGameSerial ^ this.m_nGameVersion) >>> 0);
    this.m_nGameSerial = (this.m_nGameSerial + 1) >>> 0;
    // the wire carries the RAW tmpl+60/+64 seconds (FxServer.exe.c:32906 and
    // :32908 encode this+3140/this+3141 before the *= 1000 at :32911-32912
    // rescales the server-side state) — the client rescales on its own
    packet.Encode4(this.m_nGhostStart);
    packet.Encode4(this.m_nGhostFreq);
    this.m_nGameType100 = tmpl ? tmpl.m_fReBirthMap : 0; // +12728 ← tmpl+100
    this.m_nGhostStart *= 1000;
    this.m_nGhostFreq *= 1000;
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      if (!this.m_rgPlayer[slot]) this.m_rgUdpHost[slot]!.fill(0);
    }
    this.m_BanChief = new CBanChief(); // CBanChief::Init: SetCanStart(0)/SetOddSlot(0)
    this.m_dwLastAirplaneTime = 0; // +12624 (dword 3156)
    this.SendPacket(packet);
  }

  /** CGameSession::OnPacket — the room dispatch (FxServer.exe.c:37668). */
  OnPacket(n: CReceivedPacket, socket: CClientSocket): void {
    if (!this.CheckValidSocket(socket)) {
      console.error(`[GS] !this->CheckValidSocket(pSocket), CGameSession::OnPacket. Disconnect socket[${GetInfoStr(socket)}]`);
      console.error(`[GS]     User[${socket.GetUser(0)?.GetName() ?? "NULL"}], Game Session Slot Index: [${this.m_nIdx}]. CurrentPoolType=${socket.m_nPoolType}.`);
      socket.PostClosePacket();
      return;
    }
    switch (n.Decode1()) {
      case SESSION_ReceivedPacket.OnSetPlayerReady:
        this.OnSetPlayerReady(n, socket);
        break;
      case SESSION_ReceivedPacket.OnSelectMap:
        this.OnSelectMap(n, socket);
        break;
      case SESSION_ReceivedPacket.OnSelectColor:
        this.OnSelectColor(n, socket);
        break;
      case SESSION_ReceivedPacket.OnSelectBomber:
        this.OnSelectBomber(n, socket);
        break;
      case SESSION_ReceivedPacket.OnOpenCloseSlot:
        this.OnOpenCloseSlot(n, socket);
        break;
      case SESSION_ReceivedPacket.OnSetGameTypeNormal:
        this.OnSetGameTypeNormal(socket);
        break;
      case SESSION_ReceivedPacket.OnSetGameTypeMod:
        this.OnSetGameTypeMod(socket);
        break;
      case SESSION_ReceivedPacket.OnHostAskBanPlayer:
        this.OnHostAskBanPlayer(n, socket);
        break;
      case SESSION_ReceivedPacket.OnRespondToBanPlayer:
        this.OnRespondToBanPlayer(n, socket);
        break;
      case SESSION_ReceivedPacket.OnRequestStartGame:
        this.OnRequestStartGame(n, socket);
        break;
      case SESSION_ReceivedPacket.OnRequestChangeTitle:
        this.OnRequestChangeTitle(n, socket);
        break;
      case SESSION_ReceivedPacket.OnPlayEmotion:
        this.OnPlayEmotion(n, socket);
        break;
      case SESSION_ReceivedPacket.OnReadyForImmediateStart:
        this.OnReadyForImmediateStart(n, socket);
        break;
      case SESSION_ReceivedPacket.OnTeamChat:
        this.OnTeamChat(n, socket);
        break;
      case SESSION_ReceivedPacket.OnBombIgnite:
        this.OnBombIgnite(n, socket);
        break;
      case SESSION_ReceivedPacket.OnBombKickThrow:
        this.OnBombKickThrow(n, socket);
        break;
      case SESSION_ReceivedPacket.OnSetBombTimer:
        this.OnSetBombTimer(n, socket);
        break;
      case SESSION_ReceivedPacket.OnMovableBoxMove:
        this.OnMovableBoxMove(n, socket);
        break;
      case SESSION_ReceivedPacket.OnRequestEatItem:
        this.OnRequestEatItem(n, socket);
        break;
      case SESSION_ReceivedPacket.OnRequestEatObstacle:
        this.OnRequestEatObstacle(n, socket);
        break;
      case SESSION_ReceivedPacket.OnSetBomberEvent:
        this.OnSetBomberEvent(n, socket);
        break;
      case SESSION_ReceivedPacket.OnSetEffect:
        this.OnSetEffect(n, socket);
        break;
      case SESSION_ReceivedPacket.OnDropObstacle:
        this.OnDropObstacle(n, socket);
        break;
      case SESSION_ReceivedPacket.OnEventItem:
        this.OnEventItem(n, socket);
        break;
      case SESSION_ReceivedPacket.OnDestroyBox:
        this.OnDestroyBox(n, socket);
        break;
      case SESSION_ReceivedPacket.OnRequestGenerateGhost:
        this.OnRequestGenerateGhost(n, socket);
        break;
      case SESSION_ReceivedPacket.OnRequestDestroyGhost:
        this.OnRequestDestroyGhost(n, socket);
        break;
      case SESSION_ReceivedPacket.OnLapFinished:
        this.OnLapFinished(n, socket);
        break;
      case SESSION_ReceivedPacket.OnLapInfo:
        this.OnLapInfo(n, socket);
        break;
      case SESSION_ReceivedPacket.OnRequestAirplane:
        this.OnRequestAirplane(n, socket);
        break;
      case SESSION_ReceivedPacket.OnReqCreateObj:
        this.m_SyncGameObjMan.OnReqCreateObj(n, socket);
        break;
      case SESSION_ReceivedPacket.OnReqDestroyObj:
        this.m_SyncGameObjMan.OnReqDestroyObj(n, socket);
        break;
      case SESSION_ReceivedPacket.OnReqEatBula:
        this.OnReqEatBula(n, socket);
        break;
      case SESSION_ReceivedPacket.OnReqTakeHouse:
        this.OnReqTakeHouse(n, socket);
        break;
      case SESSION_ReceivedPacket.OnShobuari:
        this.OnShobuari();
        break;
      case SESSION_ReceivedPacket.OnNotifyUDPLoss:
        this.OnNotifyUDPLoss(n, socket);
        break;
      case SESSION_ReceivedPacket.OnHackingSuspected:
        this.OnHackingSuspected(n, socket);
        break;
      case SESSION_ReceivedPacket.OnNotifyUdpLossRegulator:
        // (+213 != 0 && +246 == 1) — only mid-game
        if (this.m_fPlaying !== 0 && this.m_nGamePhase === 1) this.m_UdpLossRegulator.OnNotifyUdpLoss(n, socket);
        break;
      default:
        break;
    }
  }
}

/** CClientSocket::GetInfoStr — the "%s:%d" debug tag of the original. */
function GetInfoStr(socket: CClientSocket): string {
  return socket.GetUser(0)?.GetName() ?? "NULL";
}


// ============================ CGameSessionTable ============================

/** CGameSessionTable — the 255 game-room slots (8 lock groups in the original). */
export class CGameSessionTable {
  static ms_pInstance: CGameSessionTable | null = null;

  m_apGameSession: CGameSession[] = []; // +8 (255 preallocated rooms)
  /** +1024 — the per-room flush flags (1 = created, 4 = destroyed). */
  m_acTableFlags = new Uint8Array(255);
  /** CBaseSession::LockBaseSessions — JS is single threaded; the calls only
   *  mark the critical sections the original holds. */
  static LockBaseSessions(_n: number): void {}
  static UnlockBaseSessions(_n: number): void {}

  constructor() {
    for (let i = 0; i < 255; i++) this.m_apGameSession.push(new CGameSession());
    CGameSessionTable.ms_pInstance = this;
  }

  /** CGameSessionTable::PutAllSessionInfo — packet 83 per valid room. */
  PutAllSessionInfo(socket: CClientSocket): void {
    const packet = new CSendPacket(GS_ClientSend.OnSessionSimpleInfo, CipherDegree.kPacketEncryptedCRC8);
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

  /** CGameSessionTable::OnPacket — lock, validate, then the room dispatch. */
  OnPacket(n: CReceivedPacket, socket: CClientSocket): void {
    const idx = socket.m_nSessionIdx;
    if (idx >= SESSION_IDX_MAX) {
      if (socket.m_nPoolType !== 4 && n.m_pBlock[n.m_uOffset] !== SESSION_ReceivedPacket.OnHostAskBanPlayer) {
        if (idx === 0xffff) console.log("[GS] Lobby player sent session packet (OnPacket). Don't Disconnect.");
        else if (idx === SESSION_IDX_CONNECTING) console.error("[GS] Connecting player sent session packet (OnPacket). Don't Disconnect.");
        else console.error("[GS] Invalid game session slot index (OnPacket). Don't Disconnect.");
      }
      return;
    }
    CGameSessionTable.LockBaseSessions(idx);
    const session = this.m_apGameSession[idx];
    if (session && session.fValid !== 0 && session.m_nSerialNo === socket.m_nSessionSerialNo) {
      n.m_uOffset = 0;
      session.OnPacket(n, socket);
    } else if (socket.m_nPoolType !== 4) {
      console.error(`[GS] Illegal game session (${idx}). Disconnect [${socket.GetUser(0)?.GetName() ?? "NULL"}].`);
      socket.PostClosePacket();
    }
    CGameSessionTable.UnlockBaseSessions(idx);
  }

  /** CGameSessionTable::DestroyPlayer — vtbl+48, on socket close/leave. */
  DestroyPlayer(socket: CClientSocket, fSendReset: number): void {
    if (!socket) return;
    if (!socket.GetUser(0)) return;
    const idx = socket.m_nSessionIdx;
    const serial = socket.m_nSessionSerialNo;
    if (idx >= SESSION_IDX_MAX) return;
    CGameSessionTable.LockBaseSessions(idx);
    for (let i = 0; i < socket.GetUserCount(); i++) {
      const user = socket.GetUser(i);
      if (user) {
        user.SetSessionIdx(SESSION_IDX_NONE);
        user.SetSessionSerialNo(0xffffffff);
      }
    }
    const session = this.m_apGameSession[idx]!;
    if (session && session.fValid !== 0 && session.m_nSerialNo === serial && session.DestroyPlayer(socket, fSendReset) !== 0 && session.IsEmpty() && this.CloseSession(idx, serial) !== 0) {
      if ((this.m_acTableFlags[idx]! & 1) !== 0) this.m_acTableFlags[idx] = 0;
      else this.m_acTableFlags[idx]! |= 4;
    }
    CGameSessionTable.UnlockBaseSessions(idx);
  }

  /** CBaseSessionTable::MoveToExchangeSession — a ReportError stub in FXGS. */
  MoveToExchangeSession(_socket: CClientSocket, _a3: number): void {
    console.error("[GS] CBaseSessionTable::MoveToExchangeSession(CClientSocket* pSocket1, CClientSocket* pSocket2)");
  }

  /** CGameSessionTable::CloseSession — fValid = 0 behind the serial check. */
  CloseSession(idx: number, serial: number): number {
    if (idx >= SESSION_IDX_MAX) {
      console.error("[GS] Invalid game session slot index (CloseSession)");
      return 0;
    }
    let ok = 1;
    CGameSessionTable.LockBaseSessions(idx);
    const session = this.m_apGameSession[idx]!;
    if (session && session.fValid !== 0 && session.m_nSerialNo === serial) {
      if (session.m_nCurPlayerNum !== 0) console.error("[GS] Game session closed although some players are not destroyed");
      session.fValid = 0; // CBaseSession::Destroy
    } else {
      ok = 0;
    }
    CGameSessionTable.UnlockBaseSessions(idx);
    return ok;
  }

  /** CGameSessionTable::KickImp — "Fatal Revenge". */
  KickImp(socket: CClientSocket): number {
    if (socket.m_fImpPoint === 0) return 0;
    console.error(`[GS] Fatal Revenge: Kick imp's ass [${socket.GetUser(0)?.GetName() ?? "NULL"}] !`);
    const p = new CSendPacket(GS_ClientSend.OnKickoffUser, CipherDegree.kPacketEncryptedCRC8);
    p.EncodeStr("abnormal state, disconnect user.");
    socket.SendPacketAndDestroy(p);
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

  /** CGameSessionTable::DoCreateSession (FxServer.exe.c:38917). */
  DoCreateSession(socket: CClientSocket, title: string, password: string, selects: number[], gameType: number): void {
    if (this.KickImp(socket) !== 0) return;
    const res = new CSendPacket(GS_ClientSend.OnCreateSessionRes, CipherDegree.kPacketEncryptedCRC8);
    const na = socket.GetUserCount();
    if (na <= 0) return;
    for (let i = 0; i < na; i++) {
      const user = socket.GetUser(i)!;
      if (user.GetSessionIdx() !== SESSION_IDX_NONE) {
        console.error(`[GS] User joined a session already request for creating session. Disconnect[${user.GetName()}]`);
        socket.PostClosePacket();
        res.Encode1(3);
        socket.SendPacket(res);
        return;
      }
    }
    let nb = 0;
    while (nb < 255 && this.m_apGameSession[nb] && this.m_apGameSession[nb]!.fValid !== 0) nb++;
    if (nb >= SESSION_IDX_MAX) {
      res.Encode1(2);
      socket.SendPacket(res);
      return;
    }
    CGameSessionTable.LockBaseSessions(-1);
    const session = this.m_apGameSession[nb]!;
    session.Create(socket, title, password, selects, gameType);
    this.m_acTableFlags[nb]! |= 1;
    res.Encode1(0);
    res.Encode2(nb);
    res.Encode4(session.m_nSerialNo);
    res.Encode1(gameType);
    socket.SendPacket(res);
    // vtbl+80 — the creator sees the room (their own 105s + the 112 tail)
    session.SendSessionInfoPacket(socket);
    CGameSessionTable.UnlockBaseSessions(nb);
    CGameSessionTable.UnlockBaseSessions(-1);
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

  /** CGameSessionTable::DoJoinSession (FxServer.exe.c:39015). */
  DoJoinSession(socket: CClientSocket, idx: number, serial: number, password: string, selects: number[]): void {
    if (this.KickImp(socket) !== 0) return;
    const na = socket.GetUserCount();
    const res = new CSendPacket(GS_ClientSend.OnJoinSessionRes, CipherDegree.kPacketEncryptedCRC8);
    if (idx >= SESSION_IDX_MAX) {
      console.error("[GS] Invalid game session slot index (DoJoinSession)");
      return;
    }
    CGameSessionTable.LockBaseSessions(idx);
    const session = this.m_apGameSession[idx]!;
    if (session && session.fValid !== 0 && session.m_fSupreme === 0 && session.m_nSerialNo === serial) {
      let seated = false;
      for (let i = 0; i < na; i++) {
        if (socket.GetUser(i)!.GetSessionIdx() !== SESSION_IDX_NONE) {
          seated = true;
          break;
        }
      }
      if (!seated) {
        if (CClientSocket.HasAuthority(1) === 0 && session.m_szPassword.length > 0 && session.m_szPassword !== password) {
          res.Encode1(1);
          socket.SendPacket(res);
          CGameSessionTable.UnlockBaseSessions(idx);
          return;
        }
        if (session.AddPlayerList(socket, selects) !== 0) {
          res.Encode1(0);
          socket.SendPacket(res);
          session.SendSessionInfoPacket(socket); // vtbl+80
          session.SendJoinPacket(socket); // vtbl+84
          session.SendGameType(socket);
          CGameSessionTable.UnlockBaseSessions(idx);
          return;
        }
      }
    }
    res.Encode1(2);
    socket.SendPacket(res);
    CGameSessionTable.UnlockBaseSessions(idx);
  }

  /**
   * CGameSessionTable::JoinFreeSession (42331B) — packet 82, the auto-join.
   * DoJoinFreeSession (422A05) picks its candidate from the session list at
   * +1316, which nothing in FXGS ever inserts into (only ctor/dtor/this read
   * touch +524h), so the reply is always the [E1 2] failure; the decoded
   * selects (each % (CBomberAttr total + 1)) are discarded.
   */
  JoinFreeSession(n: CReceivedPacket, socket: CClientSocket): void {
    const count = n.Decode1();
    if (count !== socket.GetUserCount()) {
      console.error("[GS] CCChannelPool::OnRequestAutoJoinSession, player count not matched!");
      socket.PostClosePacket();
      return;
    }
    const mod = (CBomberAttr.ms_pInstance?.m_nTotalCount ?? 0) + 1;
    for (let i = 0; i < count; i++) void (n.Decode1() % mod);
    if (this.KickImp(socket) !== 0) return; // the revenge kick already destroyed the socket
    for (let i = 0; i < socket.GetUserCount(); i++) {
      // every user must still be outside a session (GetSessionIdx == 0xFFFF)
      if (socket.GetUser(i)!.GetSessionIdx() !== SESSION_IDX_NONE) return;
    }
    const res = new CSendPacket(GS_ClientSend.OnJoinFreeSessionRes, CipherDegree.kPacketEncryptedCRC8);
    res.Encode1(2);
    socket.SendPacket(res);
  }

  /**
   * CGameSessionTable::OnUDPPeerInfo (421EE5) — the type-11 MTUDP check.
   * The serial argument is the session's +148 serial.
   */
  OnUDPPeerInfo(
    idx: number,
    serial: number,
    user: CUser,
    host: HOSTHANDLE,
    hosts: number[],
    ports: number[],
  ): void {
    if (idx >= 0xff) {
      console.error("[GS] Invalid game session slot index (OnUDPPeerInfo)");
      user.m_pSocket?.PostClosePacket();
      return;
    }
    const session = this.m_apGameSession[idx];
    if (session && session.fValid !== 0 && session.m_nSerialNo === serial) {
      session.OnUDPPeerInfo(user, host, hosts, ports);
    }
  }

  /**
   * CGameSessionTable::OnReadyForImmediateStart (421E72) — the type-1 MTUDP
   * check.  The session re-reads the map CRC and the per-user attributes from
   * the packet body at the offset the dispatcher left it at.
   */
  OnReadyForImmediateStart(
    idx: number,
    serial: number,
    user: CUser,
    body: CReceivedPacket,
  ): void {
    if (idx >= 0xff) {
      console.error("[GS] Invalid game session slot index (OnReadyForImmediateStart)");
      user.m_pSocket?.PostClosePacket();
      return;
    }
    const session = this.m_apGameSession[idx];
    if (session && session.fValid !== 0 && session.m_nSerialNo === serial) {
      session.OnReadyForImmediateStart(body, user.m_pSocket!);
    }
  }

  /** CBaseSessionTable vtbl+12 ClearModifiedFlag (420CC0) — flags[idx] = 0. */
  ClearModifiedFlag(n: number): void {
    this.m_acTableFlags[n] = 0;
  }

  /** CGameSessionTable::FlushModifiedInfo — the 86 sweep (timer). */
  FlushModifiedInfo(): void {
    for (const session of this.m_apGameSession) {
      if (!session || session.fValid === 0) continue;
      const packet = new CSendPacket(0, CipherDegree.kPacketEncryptedCRC8);
      if (session.MakeModifiedPacket(packet) !== 0) {
        CChannelPool.ms_pInstance?.SendAll(packet, 1);
      }
    }
  }

  /** CGameSessionTable::UpdateGameSessions (4219A2) — the per-session tick. */
  UpdateGameSessions(): void {
    for (const session of this.m_apGameSession) {
      if (!session || session.fValid === 0) continue; // +8C gate
      session.Update();
    }
  }

  /** CGameSessionTable::FlushModifiedTableInfo — the 85/87 sweep (timer).
   *  NB: no fValid gate here (unlike FlushModifiedInfo) — a just-destroyed
   *  session (fValid = 0) must still announce its 87. (FxServer.exe.c:38335) */
  FlushModifiedTableInfo(): void {
    for (let n = 0; n < 255; n++) {
      const session = this.m_apGameSession[n];
      if (!session) continue;
      const flags = this.m_acTableFlags[n]!;
      if ((flags & 1) !== 0) {
        const packet = new CSendPacket(0, CipherDegree.kPacketEncryptedCRC8);
        session.MakeCreatedPacket(packet);
        this.m_acTableFlags[n] = 0;
        this.m_acTableFlags[n]! |= 2;
        CChannelPool.ms_pInstance?.SendAll(packet, 1);
      } else if ((flags & 4) !== 0) {
        const packet = new CSendPacket(0, CipherDegree.kPacketEncryptedCRC8);
        session.MakeDestroyedPacket(packet);
        this.m_acTableFlags[n] = 0;
        CChannelPool.ms_pInstance?.SendAll(packet, 1);
      }
    }
  }
}

// ============================ CChatPool ============================

/** CChatPool — the chat handlers (CChannelPool's base). */
export class CChatPool extends CUserPool {
  /** CChatPool::SendAll — fLobbyOnly selects the lobby-stage sockets only. */
  SendAll(packet: CSendPacket, fLobbyOnly: number): void {
    for (const socket of [...this.m_setSocket]) {
      if (!socket.m_bConnected) {
        console.error(`[GS] CChatPool::FlushAll:: Not connected socket. Post Close Packet.`);
        socket.PostClosePacket();
        this.m_setSocket.delete(socket);
        continue;
      }
      if (fLobbyOnly !== 0 && socket.m_nPoolType !== 1) continue;
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
      const p = new CSendPacket(GS_ClientSend.OnSystemMsg, CipherDegree.kPacketEncryptedCRC8);
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
    const p = new CSendPacket(GS_ClientSend.OnChatMsg, CipherDegree.kPacketEncryptedCRC8);
    if (socket.GetUser(0)!.GetSessionIdx() === 0xffff) p.EncodeStr("//");
    p.EncodeStr(text);
    const idx = socket.GetUser(0)!.GetSessionIdx();
    if (idx === 0xffff) this.SendAll(p, 1);
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
      const p = new CSendPacket(GS_ClientSend.OnWhisperFail, CipherDegree.kPacketEncryptedCRC8);
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
    const p = new CSendPacket(GS_ClientSend.OnWhisperRes, CipherDegree.kPacketEncryptedCRC8);
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
    const p = new CSendPacket(GS_ClientSend.OnItemMsg, CipherDegree.kPacketEncryptedCRC8);
    p.EncodeStr(`${user.GetName()} : ${msg}`);
    const idx = socket.GetUser(0)!.GetSessionIdx();
    if (idx === 0xffff) {
      console.error("[GS] Invalid item msg: tried to send to all in the session");
      return;
    }
    CGameSessionTable.ms_pInstance!.SendPacketIntoSession(idx, socket.GetUser(0)!.GetSessionSerialNo(), p);
  }

  /** CChatPool::OnSystemMsg — packet 30 to the session or the lobby. */
  OnSystemMsg(n: CReceivedPacket, socket: CClientSocket): void {
    const msg = n.DecodeStr();
    const p = new CSendPacket(GS_ClientSend.OnSystemMsg, CipherDegree.kPacketEncryptedCRC8);
    p.EncodeStr(msg);
    const idx = socket.GetUser(0)?.GetSessionIdx() ?? SESSION_IDX_NONE;
    if (idx === 0xffff) this.SendAll(p, 1);
    else CGameSessionTable.ms_pInstance!.SendPacketIntoSession(idx, socket.GetUser(0)!.GetSessionSerialNo(), p);
  }

  /** CChatPool::OnAdminNotifyMsg — packet 31 from an operator client. */
  OnAdminNotifyMsg(n: CReceivedPacket, socket: CClientSocket): void {
    if (socket.GetUserCount() === 1 && (socket.GetUser(0)!.GetSessionIdx() === 0xffff)) {
      this.SendAdminMsg(n.DecodeStr());
    }
  }

  /** CChatPool::OnSystemCmd — packet 71 from an operator client. */
  OnSystemCmd(n: CReceivedPacket, socket: CClientSocket): void {
    if (socket.GetUserCount() === 1 && (socket.GetUser(0)!.GetSessionIdx() === 0xffff)) {
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
    const p = new CSendPacket(GS_ClientSend.OnShoutMsg, CipherDegree.kPacketEncryptedCRC8);
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

  /** CChannelPool::UpdateRankList (:6643) — after a level-up, re-sort the
   *  level-sorted lobby list (level desc, serial asc) inside the pool's
   *  critical section; the original sends nothing from here. */
  UpdateRankList(user: CUser): void {
    const idx = this.m_vtRankList.indexOf(user);
    if (idx === -1) return;
    this.m_vtRankList.splice(idx, 1);
    let at = this.m_vtRankList.length;
    for (let i = 0; i < this.m_vtRankList.length; i++) {
      const u = this.m_vtRankList[i]!;
      if (user.m_nLevel > u.m_nLevel || (user.m_nLevel === u.m_nLevel && user.GetGlobalSerialNo() < u.GetGlobalSerialNo())) {
        at = i;
        break;
      }
    }
    this.m_vtRankList.splice(at, 0, user);
  }

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
    const p = new CSendPacket(GS_ClientSend.OnChannelAnnounce, CipherDegree.kPacketEncryptedCRC8);
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
    const packet = new CSendPacket(GS_ClientSend.OnRequestUserSimpleInfoRes, CipherDegree.kPacketEncryptedCRC8);
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
    const packet = new CSendPacket(GS_ClientSend.OnGuildMemberListRes, CipherDegree.kPacketEncryptedCRC8);
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
    const packet = new CSendPacket(0, CipherDegree.kPacketEncryptedCRC8);
    CCenterProcess.ms_pInstance!.MakeChannelsStatePacket(packet);
    socket.SendPacket(packet);
    CCenterProcess.ms_pInstance!.MakeChannelsGameStatePacket(packet);
    socket.SendPacket(packet);
  }

  /** CChannelPool::OnEnterLobbyStage — packet 83; back to the lobby. */
  OnEnterLobbyStage(socket: CClientSocket): void {
    CGameSessionTable.ms_pInstance!.DestroyPlayer(socket, 0);
    socket.m_nPoolType = 1;
    const p = new CSendPacket(GS_ClientSend.OnChannelAnnounce, CipherDegree.kPacketEncryptedCRC8);
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
        const p = new CSendPacket(GS_ClientSend.OnReqConnectToSvrFail, CipherDegree.kPacketEncryptedCRC8);
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
    const p = new CSendPacket(GS_ClientSend.OnReqConnectToSvrRes, CipherDegree.kPacketEncryptedCRC8);
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
    const packet = new CSendPacket(GS_ClientSend.OnRequestMyInfoRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(idx);
    packet.EncodeStr(user.account.strName);
    packet.Encode1(user.account.Gender);
    packet.EncodeStr(user.account.Address);
    packet.EncodeStr(user.account.Profile);
    packet.EncodeStr(user.account.Birthday);
    packet.Encode1(user.account.Reveal);
    socket.SendPacket(packet);
  }

  /**
   * CChannelPool::OnRequestModifyUserInfo — packet 66 (FxServer.exe.c:5856).
   * Wire: [E1 slot][EStr name][E1 gender][EStr address][EStr profile]
   *       [EStr birthday][E1 reveal]
   * → CDBMan::ModifyUserInfo (prUpdateUserAccount @ID/@Name/@Gender/@Address/
   *   @Reveal/@Profile/@Birthday, FxServer.exe.c:11993) and reply
   *   65 [E1 result] — 1 when the stored proc ran, 0 on failure.
   */
  OnRequestModifyUserInfo(n: CReceivedPacket, socket: CClientSocket): void {
    const slot = n.Decode1();
    const user = socket.GetUser(slot);
    if (!user) return;
    const strName = n.DecodeStr();
    const gender = n.Decode1();
    const address = n.DecodeStr();
    const profile = n.DecodeStr();
    const birthday = n.DecodeStr();
    const reveal = n.Decode1();
    const result =
      this.db.prUpdateUserAccount(
        user.account.strID,
        strName,
        gender,
        address,
        reveal,
        profile,
        birthday,
      ) === 0
        ? 1
        : 0;
    if (result === 1) {
      // CDBMan::ModifyUserInfo success path: mirror onto the live account
      user.account.strName = strName;
      user.account.Gender = gender;
      user.account.Address = address;
      user.account.Profile = profile;
      user.account.Birthday = birthday;
      user.account.Reveal = reveal;
    }
    const packet = new CSendPacket(GS_ClientSend.OnRequestModifyUserInfoRes, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode1(result);
    socket.SendPacket(packet);
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
    const packet = new CSendPacket(GS_ClientSend.OnRequestUserInfoDetailRes, CipherDegree.kPacketEncryptedCRC8);
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
    const packet = new CSendPacket(GS_ClientSend.OnRequestUserLocationRes, CipherDegree.kPacketEncryptedCRC8);
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
    const packet = new CSendPacket(GS_ClientSend.OnRequestGuildInfoRes, CipherDegree.kPacketEncryptedCRC8);
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
    const packet = new CSendPacket(GS_ClientSend.OnInviteUser, CipherDegree.kPacketEncryptedCRC8);
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
    const packet = new CSendPacket(GS_ClientSend.OnUserItemList, CipherDegree.kPacketEncryptedCRC8);
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
  m_nPremiumLv = 0; // +12 (GetMapLevelLimit's premium-channel discount)

  constructor(cfg: CServerConfig) {
    CMainSystem.ms_pInstance = this;
    this.m_nGameDomain = cfg.GetNumAttribute("GameDomain");
  }

  /** CMainSystem::IsPremiumChannel — the channel type is 41. */
  static IsPremiumChannel(): boolean {
    return CMainSystem.ms_pInstance!.m_nChannelType === 41;
  }

  /** CMainSystem::OnConnEstablished — the connect-time packet 0
   *  a default-constructed (plain) CSendPacket on every server). */
  OnConnEstablished(socket: CClientSocket): void {
    const packet = new CSendPacket(GS_ClientSend.OnConnect, CipherDegree.kPacketRaw);
    packet.Encode2(CENTER_VERSION);
    packet.Encode2(CONN_HELLO_VERSION[SVRCLASS_GAME]);
    packet.Encode4(socket.m_nHeaderType);
    packet.EncodeStr(CONN_PATCH_URL);
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
  m_anChannelMaxUser: number[] = []; // +39192 (CM 3's E4 = cfg FXGSMaxUser, CxCenter 13249)
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
      // gameVersion/clientVersion default from S2S GAME_VERSION/CLIENT_VERSION
      // (FxServer.exe.c:3703 — [E2 7][E2 3])
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
    this.m_anChannelMaxUser = [];
    this.m_anChannelType = [];
    this.m_anChannelSvrClass = [];
    this.m_anChannelPort = [];
    this.m_anChannelEnterable = [];
    for (let i = 0; i < this.m_nChannels; i++) {
      this.m_aszChannelName.push(n.DecodeStr());
      this.m_anChannelMaxUser.push(n.Decode4());
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
    const p = new CSendPacket(GS_ClientSend.OnSvrReservedMsg, CipherDegree.kPacketEncryptedCRC8);
    p.Encode1(code);
    if (code === 1) p.EncodeStr(n.DecodeStr());
    user.m_pSocket?.SendPacket(p);
  }

  /** CCenterProcess::OnAdminNotifyMsg — CM 8 → client 26 to everyone. */
  OnAdminNotifyMsg(n: CReceivedPacket): void {
    const msg = n.DecodeStr();
    const p = new CSendPacket(GS_ClientSend.OnAdminNotifyMsg, CipherDegree.kPacketEncryptedCRC8);
    p.EncodeStr(msg);
    CChannelPool.ms_pInstance?.SendAll(p, 0);
  }

  /** CCenterProcess::OnSystemMsg — CM 13 → client 30 to everyone. */
  OnSystemMsg(n: CReceivedPacket): void {
    const msg = n.DecodeStr();
    const p = new CSendPacket(GS_ClientSend.OnSystemMsg, CipherDegree.kPacketEncryptedCRC8);
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
      const p = new CSendPacket(GS_ClientSend.OnRequestUserLocationRes, CipherDegree.kPacketEncryptedCRC8);
      p.Encode1(1);
      p.EncodeStr(name);
      p.Encode1(type);
      p.Encode4(sessionIdx);
      p.Encode2(SESSION_LOC_OTHER_SERVER); // the other-server marker
      asker.m_pSocket.SendPacket(p);
    } else {
      // SendUserDetailInfo → 71 (DB-backed)
      const info = this.db.prGetUserInfo(name);
      const p = new CSendPacket(GS_ClientSend.OnRequestUserInfoDetailRes, CipherDegree.kPacketEncryptedCRC8);
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
        p.Encode2(SESSION_LOC_OTHER_SERVER);
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
/**
 * CUDPPacketDispatcher::OnUDPPacket (416619) — one MTUDP frame body.
 * type 1 = the OnReadyForImmediateStart check (35 bytes), type 11 =
 * OnUDPPeerInfo (23 bytes); anything else reports and drops.
 */
export function OnUDPPacket(payload: Uint8Array, host: HOSTHANDLE): void {
  const type = payload[0];
  if (type === MTUDP_TYPE_READY_FOR_IMMEDIATE_START) {
    if (payload.length !== 35) {
      console.error(`[GS] Invalid CheckUDPPacket from the Host ${host.ip},${host.port}`);
      return;
    }
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const user = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(dv.getUint32(1, false));
    if (!user) return;
    const idx = dv.getUint16(5, false);
    const serial = dv.getUint32(7, false);
    // hosts[2]/ports[2] at 11..22 and the dword at 23 are passed by the
    // original but only re-read from the body by the session: rewind to 27.
    const body = new CReceivedPacket();
    body.SetRcvPacket(payload.subarray(27), payload.length - 27);
    CGameSessionTable.ms_pInstance!.OnReadyForImmediateStart(idx, serial, user, body);
    return;
  }
  if (type === MTUDP_TYPE_PEER_INFO) {
    if (payload.length !== 23) {
      console.error(`[GS] Invalid CheckUDPPacket from the Host ${host.ip},${host.port}`);
      return;
    }
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const user = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(dv.getUint32(1, false));
    if (!user) return;
    const idx = dv.getUint16(5, false);
    const serial = dv.getUint32(7, false);
    const hosts = [dv.getUint32(11, false), dv.getUint32(17, false)];
    const ports = [dv.getUint16(15, false), dv.getUint16(21, false)];
    CGameSessionTable.ms_pInstance!.OnUDPPeerInfo(idx, serial, user, host, hosts, ports);
    return;
  }
  console.error(`[GS] Invalid CheckUDPPacket from the Host ${host.ip},${host.port}`);
}

export async function main(cfgFile: string, dbDir: string): Promise<void> {
  const cfg = new CServerConfig();
  cfg.Init(cfgFile);
  CServerConfig.ms_pInstance = cfg;

  PacketLog.Configure("GS");
  PacketLog.Register("GS", "recv", ...PACKET_NAME_TABLES.GS.recv);
  PacketLog.Register("GS", "send", ...PACKET_NAME_TABLES.GS.send);

  // CBomberAttr / CItemAttr / CGameMapTmplList load from the IDF package
  // (FxServer.idd/.idx, CIDFMan::CIDFMan hardcodes the "FxServer" base —
  // FxServer.exe.c:13436 loads them right after CUserItemMan).  The package
  // ships in the server directory, next to the .cfg.
  new CIDFMan(require("node:path").join(require("node:path").dirname(cfgFile), "FxServer"));
  new CBomberAttr().Load();
  new CItemAttr().Load();
  new CGameMapTmplList().CreateTmplList();

  const db = new CDBMan(dbDir);
  const itemMan = new CUserItemMan();
  itemMan.Init(db);
  new CLocalUserTable();
  const mainSystem = new CMainSystem(cfg);
  const sessionTable = new CGameSessionTable();
  const connectPool = new CConnectPool(db);
  const channelPool = new CChannelPool(db);
  new CGuildTable(db);
  const center = new CCenterProcess(db);
  void mainSystem;
  void connectPool;
  void channelPool;

  // CCenterProcess::Init (FxServer.exe.c:13383) — the WinMain order is the
  // center attach (with the endless 3 s retry loop) BEFORE CListenThread.
  await center.Init(cfg);

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
        // CListenThread::Proc (FxServer.exe.c:18963-18966) — the accept packet
        // 0, then vtbl SetCipherDegree(2), then IssueReceive.  The client's
        // very first frame is already degree-2 (SES3 + CRC8), so the degree
        // must be armed before the first receive — exactly like the LS.
        mainSystem.OnConnEstablished(socket);
        socket.SetCipherDegree(CipherDegree.kPacketEncryptedCRC8);
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

  // MTUDPBase::StartupBase (42E828) — the UDP peer socket on ServerPort +
  // MTUDP_UDP_PORT_OFFSET, and CUDPPacketDispatcher::Proc (41678B) —
  // frame-split each datagram and route the launch-handshake check packets.
  const udpLogTag = PacketLog.tag; // snapshotted: the handler outlives main()
  const udpServer = Bun.udpSocket({
    hostname: "0.0.0.0",
    port: port + MTUDP_UDP_PORT_OFFSET,
    socket: {
      data: (_socket, data, port, address) => {
        if (PacketLog.ShowsClient()) PacketLog.Datagram("recv", new Uint8Array(data as Buffer), udpLogTag);
        // network order: BE Encode4 puts a.b.c.d back on the wire
        const host: HOSTHANDLE = {
          ip: String(address)
            .split(".")
            .reduce((acc: number, o) => ((acc << 8) | (Number(o) & 0xff)) >>> 0, 0),
          port: Number(port),
        };
        for (const frame of SplitDatagram(new Uint8Array(data as Buffer), host)) {
          OnUDPPacket(frame.payload, frame.host);
        }
      },
    },
  });
  console.log(`[GS] MTUDP initialized succefully (udp :${port + MTUDP_UDP_PORT_OFFSET})`);
  void udpServer;

  // the periodic CUserPool::OnTimer sweeps (once a second, like the timer thread)
  setInterval(() => {
    connectPool.DisconnectTimeoutSocket();
    channelPool.DisconnectTimeoutSocket();
  }, 1000);

  // CTimerThreadNormal::Proc (Sleep 0x190 = 400 ms) — the room 85/86/87
  // broadcasts ride this timer in the original, not the request path.
  setInterval(() => {
    sessionTable.FlushModifiedInfo();
    sessionTable.FlushModifiedTableInfo();
    sessionTable.UpdateGameSessions();
  }, 0x190);
}
