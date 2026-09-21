/** Native source unit: FX/FxServer/User.cpp. */
import { CSendPacket } from "../core/Packet.ts";
import type { CClientSocket } from "./ClientSocket.ts";
import { CDBMan, type _USERDYNINFO } from "../db/DBMan.ts";
import { CDynInfoCalculator_GetLevel, kLevelTableSize } from "../shared/LevelTable.ts";
import { INVENTORY_SLOT_NONE, ItemCategory } from "../shared/Item.ts";
import {
  CHANNEL_TYPE_GUILD,
  DYN_FLUSH_BURST,
  MAX_PRE_INVENTORY_ROWS,
  SESSION_IDX_NONE,
  USER_MONEY_MAX,
} from "./Defs.ts";
import { CUserItemMan } from "./ItemMan.ts";
import { PreInventory, UserInventory, type _USERACCOUNT } from "./Recordsets.ts";
import { EncodeVariantTime } from "../core/VariantTime.ts";
import { CMainSystem } from "./MainSystem.ts";
import { CGuildTable } from "./Guild.ts";

/** _mbscmp equality on ANSI byte carriers: case-sensitive, NUL-terminated. */
function sameItemName(left: string, right: string): boolean {
  return left.split("\0", 1)[0] === right.split("\0", 1)[0];
}

// ============================ CUser ============================

/** CUser — one logged-in player (0x7DC bytes in the original). */
export class CUser {
  m_strName: string;
  account: _USERACCOUNT;
  dyn: _USERDYNINFO; // +196; numeric members start at byte +208
  m_pSocket: CClientSocket | null;
  m_nFree = 0; // +20 (CSafeObject::m_nFree — 0 while the user object is live)
  m_nSlotIdx = -1; // byte +1960
  m_nGlobalSerialNo = 0; // byte +1964 (CUser::SetGlobalSerialNo)
  m_nGuildSN = 0; // byte +1972 (CUser::SetGuildSerialNo; filled from the p7 tail)
  // Descriptive TS dirty-flag names; offsets here are bytes, not DWORD indices.
  m_fDynInfoModified = 0; // +1976: money/exp/win/draw/lose, not just money
  m_fLevelModified = 0; // +1980: level changed, not every exp change
  m_nLevel = 0; // byte +1984
  private m_nFakeLevel = 0; // +1988: Get/SetFakeLevel (not real level or authorization)
  private m_fLevelIcon = 0; // +1992: SetLevelIcon display flag
  private m_nLevelIconSn = 0; // +1996: GetLevelIconSn
  private m_nGame = 0; // +2000: unsigned IncGame/GetGame counter
  m_fPremiumTicket = 0; // +2004 byte
  private m_fClientInitialized = 0; // +2008: IsClientInitialized, independent of games
  m_vtInventory: UserInventory[] = [];
  m_apPreInventory: (PreInventory | null)[] = new Array(MAX_PRE_INVENTORY_ROWS).fill(null);
  m_nPreInventoryCount = 0; // +1920

  constructor(socket: CClientSocket) {
    this.m_strName = "";
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

  /** CUser::HasAuthority (0041688A) is a literal zero-return stub. */
  HasAuthority(_authority: number): number {
    return 0;
  }

  GetName(): string {
    return this.m_strName;
  }

  SetName(strName: string): void {
    this.m_strName = strName;
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

  /** Native GetFakeLevel / SetFakeLevel (00403134 / 00408DF1). */
  GetFakeLevel(): number { return this.m_nFakeLevel; }
  SetFakeLevel(level: number): void { this.m_nFakeLevel = level | 0; }

  /** Native GetLevelIconSn / SetLevelIcon (0040313B / 00408DFE). */
  GetLevelIconSn(): number { return this.m_nLevelIconSn; }
  SetLevelIcon(enabled: number, sn: number): void {
    this.m_fLevelIcon = enabled | 0;
    this.m_nLevelIconSn = sn | 0;
  }

  /** Native GetAuthencode / SetAuthenCode (00408E22 / 00408148).
   * The asymmetrical spelling is from the supplied symbols. */
  GetAuthencode(): number { return this.m_fPremiumTicket & 0xff; }
  SetAuthenCode(code: number): void { this.m_fPremiumTicket = code & 0xff; }

  /** CUser::GetLookLevel — level + bonus clamped to 1..kLevelTableSize.
   *  The official compares directly against the same 450 the level table
   *  is sized by (FxServer.exe.c:26980, `if (n450 > 450) return 450;`). */
  GetLookLevel(): number {
    const n = (this.m_nLevel + this.m_nFakeLevel) | 0;
    if (n < 1) return 1;
    if (n > kLevelTableSize) return kLevelTableSize;
    return n;
  }

  /** IncWin/Draw/Lose (0041D1C1..0041D219) mutate the SAME _USERDYNINFO
   *  read by detail packets and WriteUserDynInfo; no parallel counters. */
  IncWin(): void {
    this.dyn.win = (this.dyn.win + 1) | 0;
    this.m_fDynInfoModified = 1;
  }
  IncDraw(): void {
    this.dyn.draw = (this.dyn.draw + 1) | 0;
    this.m_fDynInfoModified = 1;
  }
  IncLose(): void {
    this.dyn.lose = (this.dyn.lose + 1) | 0;
    this.m_fDynInfoModified = 1;
  }

  /** CUser::IncGame (41D245) — bumps the dyn burst counter (+2000). */
  IncGame(): void {
    this.m_nGame = (this.m_nGame + 1) >>> 0;
  }

  /** CUser::GetGame (0041691C) — unsigned games since the last flush. */
  GetGame(): number {
    return this.m_nGame;
  }

  /** CUser::IsClientInitialized / SetClientInitialized (00408155/0040815C). */
  IsClientInitialized(): number {
    return this.m_fClientInitialized;
  }
  SetClientInitialized(initialized: number): void {
    this.m_fClientInitialized = initialized | 0;
  }

  /** CUser::GetSelfidx (FxServer.exe.c:26610) — this user's index inside its socket. */
  GetSelfidx(): number {
    const socket = this.m_pSocket;
    if (!socket) return -1;
    for (let i = 0; i < socket.GetUserCount(); i++) if (socket.GetUser(i) === this) return i;
    return -1;
  }

  /** CUser::IncDecMoney — native signed add first, then clamp. */
  IncDecMoney(value: number): void {
    const money = (this.dyn.money + value) | 0;
    this.dyn.money = Math.max(0, Math.min(USER_MONEY_MAX, money));
    this.m_fDynInfoModified = 1;
  }

  /** CUser::IncDecExp — returns +1 levelup / -1 leveldown / 0. */
  IncDecExp(value: number): number {
    const old = this.m_nLevel;
    this.dyn.exp = Math.max(0, (this.dyn.exp + value) | 0);
    this.m_fDynInfoModified = 1;
    this.SetLevel();
    if (this.m_nLevel !== old) {
      this.m_fLevelModified = 1;
      return this.m_nLevel > old ? 1 : -1;
    }
    return 0;
  }

  /** CUser::DeferFlushModifiedInfo (00417603) — snapshot/reset under the
   *  native lock, then write outside it. JS execution here is synchronous.
   *  The original clears dirty state even when WriteUserDynInfo fails. */
  DeferFlushModifiedInfo(db: CDBMan, fForce: number): void {
    if (fForce === 0 && this.GetGame() < DYN_FLUSH_BURST) return;
    const info = this.m_fDynInfoModified !== 0 ? { ...this.dyn } : null;
    this.m_nGame = 0;
    this.m_fDynInfoModified = 0;
    this.m_fLevelModified = 0;
    if (info) db.WriteUserDynInfo(info);
  }

  /** CUser::AddInventory */
  AddInventory(inv: UserInventory): void {
    this.m_vtInventory.push(inv);
  }

  /** CUser::GetUserInventory */
  GetUserInventory(ItemSN: number): UserInventory | null {
    return this.m_vtInventory.find((i) => i.ItemSN === ItemSN) ?? null;
  }

  /** CUser::GetUserInventoryFromAll — exact resource-name comparison (_mbscmp), not the display name. */
  GetUserInventoryFromAll(name: string): UserInventory | null {
    return this.m_vtInventory.find((i) => sameItemName(i.strAttr, name)) ?? null;
  }

  /** CUser::HasFunctionalItem (category 2). */
  HasFunctionalItem(name: string): boolean {
    return this.m_vtInventory.some((i) => i.Type === ItemCategory.Functional && sameItemName(i.strAttr, name));
  }

  /** CUser::GetInventoryLoaded — equipped (SlotByte != 0xFF) of a category. */
  GetInventoryLoaded(n: number): UserInventory | null {
    return this.m_vtInventory.find((i) => i.Type === n && i.SlotByte !== INVENTORY_SLOT_NONE) ?? null;
  }

  /** CUser::GetSlotDecorationLoaded (category 10). */
  GetSlotDecorationLoaded(i: number): UserInventory | null {
    return this.m_vtInventory.find((x) => x.Type === ItemCategory.SlotDecoration && x.nAttr2 === i && x.SlotByte !== INVENTORY_SLOT_NONE) ?? null;
  }

  /** CUser::GetCharDecoLoaded (category 12). */
  GetCharDecoLoaded(i: number): UserInventory | null {
    return this.m_vtInventory.find((x) => x.Type === ItemCategory.CharDeco && x.nAttr2 === i && x.SlotByte !== INVENTORY_SLOT_NONE) ?? null;
  }

  /** CUser::AppendSimpleInfoPacket — the shared rank/guild/list entry. */
  AppendSimpleInfoPacket(packet: CSendPacket): void {
    packet.EncodeStr(this.m_strName);
    packet.Encode1(this.account.Gender);
    // CUser::AppendSimpleInfoPacket (FxServer.exe.c:27122) — the look level
    // rides through vtbl+24 = Encode2 (CSendPacketBase vtable 0x492198:
    // +20 E1 / +24 E2 / +28 E4 / +32 EStr), NOT Encode4.
    packet.Encode2(this.GetLookLevel());
    if (this.m_fLevelIcon !== 0) packet.Encode4(this.m_nLevelIconSn);
    else packet.Encode4(0);
    packet.Encode4(this.m_nGuildSN);
    if (CMainSystem.ms_pInstance!.m_nChannelType === CHANNEL_TYPE_GUILD) {
      const guild = CGuildTable.ms_pInstance?.FindGuildFromSerialNo(this.m_nGuildSN);
      if (guild) {
        packet.Encode2(guild.m_nMarkRevision);
        return;
      }
    }
    packet.Encode2(0);
  }

  /** CUser::MakeUserInventoryPacket — packet 201 per-user body.
   * The vector count is E4: FxServer.exe.lst:00416C40–00416C41 calls the
   * send-packet vtable at +0x1C, which is Encode4 (004921B4), not Encode2. */
  MakeUserInventoryPacket(packet: CSendPacket): void {
    packet.Encode4(this.m_vtInventory.length);
    for (const inv of this.m_vtInventory) {
      packet.Encode4(inv.ItemSN);
      packet.Encode1(inv.SlotByte);
      packet.Encode4(inv.Amount);
      packet.EncodeStr(inv.Verbose);
      // CTime::GetVariantTime — an 8-byte OLE date
      packet.EncodeBuffer(EncodeVariantTime(inv.DateCreated));
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
