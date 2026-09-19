/**
 * CItemMan — the shop's item tables (FxShop.exe.c).
 *
 * Four (five with the bonus map) tables load from the ItemDB session
 * (CDBMan[15], CAItem):  FxItem → UserItem, FxStock → ShopItem,
 * FxString → string table, FxPackageMap, FxCouponMap, FxBonusMap.
 *
 * Three of them are ALSO kept as fully encoded packets inside the manager
 * (this+4 / this+28 / this+52), rebuilt by UpdateStringPacket /
 * UpdateShopItemPacket / UpdatePackageMapPacket: each packet is
 * [type][COSmartStream block] with the block hash kept in m_dwords 425/426/427
 * (string / shop item / package map) — those three hashes ride in client 18.
 * SendStringTable / SendShopItemList / SendPackageMap just flush the cached
 * packet at the socket (vtbl+68).
 */
import { CDBMan } from "../db/DBMan.ts";
import { CipherDegree, CSendPacket } from "../core/Packet.ts";
import { COSmartStream } from "../core/SmartStream.ts";
import { SC_SendPacket } from "../lib/PacketIDs.ts";

/** UserItem — the FxItem row (UserItem::UserItem / CRSUserItem::OnReceiveRow). */
export class UserItem {
  SN = 0;
  Category = 0;
  strAttr = "";
  nAttr1 = 0;
  nAttr2 = 0;
  nAttr3 = 0;
  strName = "";
}

/** ShopItem — the FxStock row (CRSShopItem::OnReceiveRow, 17 columns). */
export class ShopItem {
  SN = 0;
  Category = 0; // byte
  Name = "";
  ItemSN = 0;
  Unit = 0;
  DataFile = "";
  Price = 0;
  FixedPrice = 0;
  LimitLevel = 0;
  LimitEx = 0;
  ValidityPeriod = 0;
  ValidityLevel = 0;
  StringDesc = 0;
  StringUsage = 0;
  CardNo = 0; // byte
  MoneyType = 0; // byte
  zorder = 0;
}

/** FxPackageMap row (CRSPackageMap). */
export class PackageMap {
  PackageSN = 0;
  StockSN = 0;
  Units = 0;
  Validitylevel = 0;
}

/** FxBonusMap row (CRSBonusMap) — (Price, StockSN) in row order. */
export class BonusMap {
  Price = 0;
  StockSN = 0;
}

/** FxCouponMap row (CRSCouponMap). */
export class CouponMap {
  CouponSN = 0;
  ItemSN = 0;
  Units = 0;
  ValidityPeriod = 0;
  Validitylevel = 0;
}

export class CItemMan {
  /** TSingleton<CItemMan>::ms_pInstance */
  static ms_pInstance: CItemMan | null = null;

  m_mapUserItem = new Map<number, UserItem>(); // hash_map<uint, UserItem> @ +100
  m_mapShopItem = new Map<number, ShopItem>(); // hash_map<uint, ShopItem> @ +148
  m_mapString = new Map<number, string>(); // hash_map<uint, string> @ +620
  m_ltPackageMap: PackageMap[] = []; // list @ +652
  m_ltCouponMap: CouponMap[] = []; // list @ +748
  m_vtBonusMap: BonusMap[] = []; // vector @ +664 (this+166 dwords)

  m_pStringTablePacket: CSendPacket | null = null; // this+4 (type 205)
  m_pShopItemListPacket: CSendPacket | null = null; // this+28 (type 200)
  m_pPackageMapPacket: CSendPacket | null = null; // this+52 (type 213)
  m_nStringHash = 0; // dword 425
  m_nShopItemHash = 0; // dword 426
  m_nPackageMapHash = 0; // dword 427

  /** CItemMan::Init — the four startup loads; 0 on the first failure. */
  Init(db: CDBMan): number {
    if (!this.UpdateUserItemTable(db)) return 0;
    if (!this.UpdateShopItemTable(db)) return 0;
    if (!this.UpdateStringTable(db)) return 0;
    if (!this.UpdatePackageMapTable(db)) return 0;
    return 1;
  }

  /** CItemMan::UpdateUserItemTable — FxItem → m_mapUserItem. */
  UpdateUserItemTable(db: CDBMan): number {
    this.m_mapUserItem.clear();
    for (const r of db.GetFxItemRows()) {
      const item = new UserItem();
      item.SN = r.SN;
      item.Category = r.Category;
      item.strAttr = r.strAttr;
      item.nAttr1 = r.nAttr1;
      item.nAttr2 = r.nAttr2;
      item.nAttr3 = r.nAttr3;
      item.strName = r.strName;
      this.m_mapUserItem.set(r.SN, item);
    }
    return 1;
  }

  /** CItemMan::UpdateShopItemTable — FxStock (IsValid > 0) → m_mapShopItem. */
  UpdateShopItemTable(db: CDBMan): number {
    this.m_mapShopItem.clear();
    for (const r of db.GetFxStockRows()) {
      const item = new ShopItem();
      item.SN = r.SN;
      item.Category = r.Category;
      item.Name = r.Name;
      item.ItemSN = r.ItemSN;
      item.Unit = r.Unit;
      item.DataFile = r.DataFile;
      item.Price = r.Price;
      item.FixedPrice = r.FixedPrice;
      item.LimitLevel = r.LimitLevel;
      item.LimitEx = r.LimitEx;
      item.ValidityPeriod = r.ValidityPeriod;
      item.ValidityLevel = r.ValidityLevel;
      item.StringDesc = r.StringDesc;
      item.StringUsage = r.StringUsage;
      item.CardNo = r.CardNo;
      item.MoneyType = r.MoneyType;
      item.zorder = r.zorder;
      this.m_mapShopItem.set(r.SN, item);
    }
    this.UpdateShopItemPacket();
    return 1;
  }

  /** CItemMan::UpdateStringTable — FxString → m_mapString. */
  UpdateStringTable(db: CDBMan): number {
    this.m_mapString.clear();
    for (const r of db.GetFxStringRows()) this.m_mapString.set(r.SN, r.String);
    this.UpdateStringPacket();
    return 1;
  }

  /** CItemMan::UpdatePackageMapTable — FxPackageMap → m_ltPackageMap. */
  UpdatePackageMapTable(db: CDBMan): number {
    this.m_ltPackageMap = [];
    for (const r of db.GetFxPackageMapRows()) {
      const p = new PackageMap();
      p.PackageSN = r.PackageSN;
      p.StockSN = r.StockSN;
      p.Units = r.Units;
      p.Validitylevel = r.Validitylevel;
      this.m_ltPackageMap.push(p);
    }
    this.UpdatePackageMapPacket();
    return 1;
  }

  /** CItemMan::UpdateCouponMapTable — FxCouponMap → m_ltCouponMap (center p14). */
  UpdateCouponMapTable(db: CDBMan): void {
    this.m_ltCouponMap = [];
    for (const r of db.GetFxCouponMapRows()) {
      const c = new CouponMap();
      c.CouponSN = r.CouponSN;
      c.ItemSN = r.ItemSN;
      c.Units = r.Units;
      c.ValidityPeriod = r.ValidityPeriod;
      c.Validitylevel = r.Validitylevel;
      this.m_ltCouponMap.push(c);
    }
  }

  /** CItemMan::UpdateBonusMapTable — FxBonusMap → m_vtBonusMap (row order). */
  UpdateBonusMapTable(db: CDBMan): void {
    this.m_vtBonusMap = [];
    for (const r of db.GetFxBonusMapRows()) {
      const b = new BonusMap();
      b.Price = r.Price;
      b.StockSN = r.StockSN;
      this.m_vtBonusMap.push(b);
    }
  }

  /** CItemMan::AddBonusCartItem — when the billing total crosses a bonus
   *  Price, the bonus StockSN is appended to the user's cart (1 ×). */
  AddBonusCartItem(total: number, user: { m_anCart: { stockSN: number; cnt: number }[] }, a4: number): number {
    let added = 0;
    for (const row of this.m_vtBonusMap) {
      if (total >= row.Price) {
        added = 1;
        user.m_anCart[a4] = { stockSN: row.StockSN, cnt: 1 };
      }
    }
    return added;
  }

  /** CItemMan::UpdateStringPacket — cache the type 205 packet, m_nStringHash. */
  UpdateStringPacket(): void {
    const stream = new COSmartStream();
    stream.Encode2(this.m_mapString.size);
    for (const [sn, str] of this.m_mapString) {
      stream.Encode4(sn);
      stream.EncodeStr(str);
    }
    this.m_nStringHash = stream.GetHashValue();
    const packet = new CSendPacket(SC_SendPacket.OnStringTable, CipherDegree.kPacketEncryptedCRC8); // InitPacket(type) — degree 2
    packet.EncodeOSStream(stream);
    this.m_pStringTablePacket = packet;
  }

  /** CItemMan::UpdateShopItemPacket — cache the type 200 packet, m_nShopItemHash.
   *  Per entry: [E4 SN][E1 Category][EStr Name][E2 StringDesc][E2 StringUsage]
   *  [E4 ItemSN][E4 Unit][EStr DataFile][E4 Price][E4 FixedPrice][E2 LimitLevel]
   *  [E2 LimitEx][E2 ValidityPeriod][E2 ValidityLevel][E4 zorder][E1 CardNo]
   *  [E1 MoneyType]. */
  UpdateShopItemPacket(): void {
    const stream = new COSmartStream();
    stream.Encode2(this.m_mapShopItem.size);
    for (const item of this.m_mapShopItem.values()) {
      stream.Encode4(item.SN);
      stream.Encode1(item.Category);
      stream.EncodeStr(item.Name);
      stream.Encode2(item.StringDesc);
      stream.Encode2(item.StringUsage);
      stream.Encode4(item.ItemSN);
      stream.Encode4(item.Unit);
      stream.EncodeStr(item.DataFile);
      stream.Encode4(item.Price);
      stream.Encode4(item.FixedPrice);
      stream.Encode2(item.LimitLevel);
      stream.Encode2(item.LimitEx);
      stream.Encode2(item.ValidityPeriod);
      stream.Encode2(item.ValidityLevel);
      stream.Encode4(item.zorder);
      stream.Encode1(item.CardNo);
      stream.Encode1(item.MoneyType);
    }
    this.m_nShopItemHash = stream.GetHashValue();
    const packet = new CSendPacket(SC_SendPacket.OnShopItemList, CipherDegree.kPacketEncryptedCRC8); // InitPacket(type) — degree 2
    packet.EncodeOSStream(stream);
    this.m_pShopItemListPacket = packet;
  }

  /** CItemMan::UpdatePackageMapPacket — cache the type 213 packet, m_nPackageMapHash.
   *  Per entry: [E4 PackageSN][E4 StockSN][E4 Units][E4 Validitylevel]. */
  UpdatePackageMapPacket(): void {
    const stream = new COSmartStream();
    stream.Encode2(this.m_ltPackageMap.length);
    for (const p of this.m_ltPackageMap) {
      stream.Encode4(p.PackageSN);
      stream.Encode4(p.StockSN);
      stream.Encode4(p.Units);
      stream.Encode4(p.Validitylevel);
    }
    this.m_nPackageMapHash = stream.GetHashValue();
    const packet = new CSendPacket(SC_SendPacket.OnPackageMap, CipherDegree.kPacketEncryptedCRC8); // InitPacket(type) — degree 2
    packet.EncodeOSStream(stream);
    this.m_pPackageMapPacket = packet;
  }

  /** CItemMan::GetUserItem */
  GetUserItem(sn: number): UserItem | null {
    return this.m_mapUserItem.get(sn) ?? null;
  }

  /** CItemMan::GetShopItem */
  GetShopItem(sn: number): ShopItem | null {
    return this.m_mapShopItem.get(sn) ?? null;
  }

  /** CItemMan::GetPackageMapList — the package entries for a stock SN. */
  GetPackageMapList(stockSN: number): PackageMap[] {
    return this.m_ltPackageMap.filter((p) => p.PackageSN === stockSN);
  }

  /** CItemMan::GetCouponMapList — the coupon entries for a user + coupon SN. */
  GetCouponMapList(couponSN: number): CouponMap[] {
    return this.m_ltCouponMap.filter((c) => c.CouponSN === couponSN);
  }

  /** CItemMan::SendStringTable — flush the cached packet (vtbl+68). */
  SendStringTable(socket: { SendPacket(p: CSendPacket): void }): void {
    if (this.m_pStringTablePacket) socket.SendPacket(this.m_pStringTablePacket);
  }

  /** CItemMan::SendShopItemList */
  SendShopItemList(socket: { SendPacket(p: CSendPacket): void }): void {
    if (this.m_pShopItemListPacket) socket.SendPacket(this.m_pShopItemListPacket);
  }

  /** CItemMan::SendPackageMap */
  SendPackageMap(socket: { SendPacket(p: CSendPacket): void }): void {
    if (this.m_pPackageMapPacket) socket.SendPacket(this.m_pPackageMapPacket);
  }

  /** CItemMan::PutUserItemList — client 202: the whole UserItem table.
   *  [E2 count][count × (E4 SN, E1 Category, EStr strAttr, E4 nAttr1, E4 nAttr2,
   *  E4 nAttr3, EStr strName)]. */
  PutUserItemList(packet: CSendPacket): void {
    packet.Encode2(this.m_mapUserItem.size);
    for (const item of this.m_mapUserItem.values()) {
      packet.Encode4(item.SN);
      packet.Encode1(item.Category);
      packet.EncodeStr(item.strAttr);
      packet.Encode4(item.nAttr1);
      packet.Encode4(item.nAttr2);
      packet.Encode4(item.nAttr3);
      packet.EncodeStr(item.strName);
    }
  }

  /** CItemMan::MakeBonusMap — appended to client 18:
   *  [E2 count][count × (E4 Price, E4 StockSN)]. */
  MakeBonusMap(packet: CSendPacket): void {
    packet.Encode2(this.m_vtBonusMap.length);
    for (const bonus of this.m_vtBonusMap) {
      packet.Encode4(bonus.Price);
      packet.Encode4(bonus.StockSN);
    }
  }
}
