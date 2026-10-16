export interface _USERACCOUNT {
  SID: number;
  ID: string;
  UserHashNo: number;
  Name: string;
  Email: string;
  EmailRcv: number;
  Gender: number;
  Address: string;
  Tel: string;
  Reveal: number;
  Profile: string;
  PasswordQ: string;
  IdentityNo: string;
  Birthday: string;
  CommunitySvr: number;
  GuildSn: number;
  Authority: number;
  TotalConn: number;
  LastConn: number | null;
  CreatedAt: number;
  BannedUntil: number;
}
export interface _USERDYNAMIC {
  ID: string;
  Money: number;
  Exp: number;
  Win: number;
  Draw: number;
  Lose: number;
  TicketDate: number;
}
/** prUpdateUserDynamic native _USERDYNINFO fields; TicketDate is NOT written. */
export type _USERDYNINFO = Pick<
  _USERDYNAMIC,
  "ID" | "Money" | "Exp" | "Win" | "Draw" | "Lose"
>;
/** Modern SQLite optimistic batch entry, not a recovered stored procedure. */
export interface UserDynamicChange {
  readonly Before: Readonly<_USERDYNINFO>;
  readonly After: Readonly<_USERDYNINFO>;
}
export interface _USERINFO extends _USERACCOUNT, _USERDYNAMIC {}
export interface _USERINVENTORY {
  SN: number;
  ID: string;
  ItemID: number;
  Slot: number;
  Amount: number;
  ExpireDate: number;
  Verbose: string;
  CreatedAt: number;
}
/** Native FxItem column names:0040F9FA select /00411EE1 rowset.
 * Independent of ShopItem pricing and CItemAttr's resource Type. */
export interface UserItem {
  SN: number;
  Category: number;
  strAttr: string;
  nAttr1: number;
  nAttr2: number;
  nAttr3: number;
  strName: string;
}
export interface NewUserFields {
  ID: string;
  Password: string;
  Name?: string;
  Email?: string;
  EmailRcv?: number;
  Gender?: number;
  Address?: string;
  Tel?: string;
  Reveal?: number;
  Profile?: string;
  PasswordQ?: string;
  PasswordA?: string;
  IdentityNo?: string;
  Birthday?: string;
}
