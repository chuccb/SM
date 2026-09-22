/** Native source unit: FX/FxServer/Recordsets.cpp.
 *
 * UserItem, UserInventory, PreInventory, and ShopItem constructors are emitted
 * by FxServer.map's Recordsets.obj. _USERACCOUNT is the shared prGetUserInfo
 * row block consumed by RSUserAccount.cpp and remains a declaration here.
 */
import { INVENTORY_SLOT_NONE } from "../common/Item.ts";

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

/** UserInventory — one owned item (84 bytes in the original). */
export class UserInventory {
  ItemSN = 0; // +0
  StockSn = 0; // +4
  Type = 0; // +8 (the FxItem category)
  strAttr = ""; // +12: FxItem.strAttr (resource/functional name), NOT strName
  nAttr1 = 0; // +24
  nAttr2 = 0; // +28: also the decoration-kind index; one source of truth
  nAttr3 = 0; // +32
  SlotByte = INVENTORY_SLOT_NONE; // +36: DB Slot byte; not the kind index
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
