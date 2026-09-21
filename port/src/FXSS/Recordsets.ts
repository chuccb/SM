/** Native source unit: FX/FxShop/Recordsets.cpp.
 * Their corresponding CRS* readers populate these row values from CAItem. */

/** _USERACCOUNT — the prGetUserInfoShop out-parameter block. */
export interface _USERACCOUNT {
  SN: number;
  Name: string;
  Password: string;
  Email: string;
  EmailRcv: number;
  Gender: number;
  Address: string;
  Tel: string;
  Reveal: number;
  Profile: string;
  TotalConn: number;
  LastConn: string | null;
  Permission: number;
  money: number;
  win: number;
  draw: number;
  lose: number;
  ShopCardNo: number;
  CommunitySvr: number;
}

/** _USERDYNINFO — the prGetUserDynamic out-parameter block. */
export interface _USERDYNINFO {
  Exp: number;
  Money: number;
  Win: number;
  Draw: number;
  Lose: number;
  PremiumDate: string | null;
}

/** UserInventory — the FxUserInventory row owned by CRSUserInventory. */
export class UserInventory {
  SN = 0;
  Slot = 0;
  ItemSN = 0;
  Verbose = "";
  dateAcquired: Date | null = null;
}

/** UserItem — the FxItem row (CRSUserItem::OnReceiveRow). */
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
  Category = 0;
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
  CardNo = 0;
  MoneyType = 0;
  zorder = 0;
}

/** FxPackageMap row (CRSPackageMap). */
export class PackageMap {
  PackageSN = 0;
  StockSN = 0;
  Units = 0;
  Validitylevel = 0;
}

/** FxBonusMap row (CRSBonusMap). */
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
