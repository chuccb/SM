/** the DB row types and the item tables — CUserItemMan (the CAItem cache)
 *  and the account/inventory rows CUser loads at login. */

import { Encode1, Encode2, Encode4 } from "../core/BufferManipulator.ts";
import { CSendPacket } from "../core/Packet.ts";
import { CDBMan } from "../db/DBMan.ts";

/** CTime::GetVariantTime — the OLE automation date double. */
export function GetVariantTime(date: Date | null): number {
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
