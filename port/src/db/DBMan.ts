/**
 * CDBMan — the six-database sharded layer shared by the local servers.
 *
 *   UserInfo00..05     : FxUserAccount / FxUserDynamic / TxUserDynamic
 *                        (prCAAuthUser, prCreateUser, prGetUserInfo, ...)
 *   UserInventory00..05: FxUserInventory / FxPreInventory / FxCart
 *   CAItem             : FxItem / FxStock                     (item + shop-stock definitions)
 *   CAConfig           : BillingConfig / CAMultiSvr / CALoginSvr / CAString /
 *                        FxUserOptions / FxAdvertisement / FxGuildServerList / CACommuSvr
 *   Guild              : FxGuildAccount / FxGuildDynamic / FxGuildMember / FxGuildLimit
 *
 * CDBMan::GetUserHashNo = (lowercase first byte of the account id) % 6 — the
 * single shard selector used by every user/inventory proc.
 *
 * Schema + proc semantics are taken from the MTF backups (UserInfo*.bak /
 * UserInventory*.bak / Guild.bak / CAConfig.bak / CAItem.bak) and the
 * CRS*::OnReceiveRow select lists in the decompiled servers.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** CDBMan::GetUserHashNo — lower(name[0]) % 6. */
export function GetUserHashNo(id: string): number {
  const c = id.length > 0 ? id.toLowerCase().charCodeAt(0) & 0xff : 0;
  return c % 6;
}

/**
 * EncodePassword (CxLogin.exe.c:34252) — a uuencode: a length prefix
 * ((len & 0x3F) + 32, or '`' when empty) followed by 3-byte groups packed
 * into 4 sextets; sextet 0 encodes as '`' (96), anything else as 32+v.
 */
export function EncodePassword(pw: string): string {
  const src = Buffer.from(pw, "latin1");
  const enc = (v: number) => (v === 0 ? "`" : String.fromCharCode(32 + v));
  let out = src.length > 0 ? enc(src.length & 0x3f) : "`";
  for (let i = 0; i < src.length; i += 3) {
    const b0 = src[i]!;
    const b1 = i + 1 < src.length ? src[i + 1]! : 0;
    const b2 = i + 2 < src.length ? src[i + 2]! : 0;
    out += enc(b0 >> 2);
    out += enc(((b0 & 3) << 4) | (b1 >> 4));
    out += enc(((b1 & 0xf) << 2) | (b2 >> 6));
    out += enc(b2 & 0x3f);
  }
  return out;
}

const SCHEMA_USERINFO = `
CREATE TABLE IF NOT EXISTS FxUserAccount (
  ID           TEXT PRIMARY KEY,
  SN           INTEGER NOT NULL DEFAULT 0,
  SID          INTEGER NOT NULL DEFAULT 0,
  Name         TEXT NOT NULL DEFAULT '',
  Password     TEXT NOT NULL DEFAULT '',
  Email        TEXT NOT NULL DEFAULT '',
  EmailRcv     INTEGER NOT NULL DEFAULT 0,
  Gender       INTEGER NOT NULL DEFAULT 0,
  Address      TEXT NOT NULL DEFAULT '',
  Tel          TEXT NOT NULL DEFAULT '',
  Reveal       INTEGER NOT NULL DEFAULT 0,
  Profile      TEXT NOT NULL DEFAULT '',
  PasswordQ    TEXT NOT NULL DEFAULT '',
  PasswordA    TEXT NOT NULL DEFAULT '',
  IdentityNo   TEXT NOT NULL DEFAULT '',
  Birthday     TEXT NOT NULL DEFAULT '',
  ShopCardNo   INTEGER NOT NULL DEFAULT 1,
  CommunitySvr INTEGER NOT NULL DEFAULT 0,
  GuildSn      INTEGER NOT NULL DEFAULT 0,
  TotalConn    INTEGER NOT NULL DEFAULT 0,
  LastConn     TEXT,
  Permission   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS FxUserDynamic (
  ID         TEXT PRIMARY KEY,
  Money      INTEGER NOT NULL DEFAULT 0,
  Exp        INTEGER NOT NULL DEFAULT 0,
  Win        INTEGER NOT NULL DEFAULT 0,
  Draw       INTEGER NOT NULL DEFAULT 0,
  Lose       INTEGER NOT NULL DEFAULT 0,
  TicketDate TEXT
);
CREATE TABLE IF NOT EXISTS TxUserDynamic (
  ID  TEXT PRIMARY KEY,
  Exp INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS FxUserAccount_SN ON FxUserAccount (SN);
`;

const SCHEMA_INVENTORY = `
CREATE TABLE IF NOT EXISTS FxUserInventory (
  UserSN       INTEGER NOT NULL DEFAULT 0,
  UserID       TEXT NOT NULL,
  ItemSN       INTEGER NOT NULL,
  StockSN      INTEGER NOT NULL DEFAULT 0,
  Slot         INTEGER NOT NULL DEFAULT 0,
  Amount       INTEGER NOT NULL DEFAULT 0,
  DateCreated  TEXT,
  LevelCreated INTEGER NOT NULL DEFAULT 0,
  Verbose      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (UserID, ItemSN)
);
CREATE TABLE IF NOT EXISTS FxPreInventory (
  SN             INTEGER PRIMARY KEY AUTOINCREMENT,
  UserID         TEXT NOT NULL,
  Type           INTEGER NOT NULL DEFAULT 0,
  ItemSN         INTEGER NOT NULL,
  StockSN        INTEGER NOT NULL DEFAULT 0,
  Slot           INTEGER NOT NULL DEFAULT 0,
  Amount         INTEGER NOT NULL DEFAULT 0,
  ValidityPeriod INTEGER NOT NULL DEFAULT 0,
  ValidityLevel  INTEGER NOT NULL DEFAULT 0,
  strAttr        TEXT NOT NULL DEFAULT '',
  Description    TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS FxCart (
  UserID      TEXT PRIMARY KEY,
  StockSNList TEXT NOT NULL DEFAULT ''
);
`;

const SCHEMA_CONFIG = `
CREATE TABLE IF NOT EXISTS BillingConfig (
  AttrID TEXT PRIMARY KEY,
  strVal TEXT NOT NULL DEFAULT '',
  numVal INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS CAMultiSvr (
  SN      INTEGER PRIMARY KEY,
  Name    TEXT NOT NULL DEFAULT '',
  IP      TEXT NOT NULL DEFAULT '',
  Param   INTEGER NOT NULL DEFAULT 0,
  Current INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS CALoginSvr (
  SN    INTEGER PRIMARY KEY,
  IP    TEXT NOT NULL DEFAULT '',
  Port  INTEGER NOT NULL DEFAULT 0,
  Flag  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS CAString (
  sn      INTEGER PRIMARY KEY,
  type    INTEGER NOT NULL DEFAULT 0,
  value   TEXT NOT NULL DEFAULT '',
  strAttr TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS FxUserOptions (
  NAME    TEXT PRIMARY KEY,
  VALUE   INTEGER NOT NULL DEFAULT 0,
  strAttr TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS FxAdvertisement (
  strImage TEXT NOT NULL DEFAULT '',
  Param1   INTEGER NOT NULL DEFAULT 0,
  Param2   INTEGER NOT NULL DEFAULT 0,
  Param3   INTEGER NOT NULL DEFAULT 0,
  Param4   INTEGER NOT NULL DEFAULT 0,
  Param5   INTEGER NOT NULL DEFAULT 0,
  Param6   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS FxMessage (
  Message     TEXT NOT NULL DEFAULT '',
  MessageAttr INTEGER NOT NULL DEFAULT 0,
  MessageUse  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS FxGuildServerList (
  SN   INTEGER PRIMARY KEY,
  IP   TEXT NOT NULL DEFAULT '',
  Port INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS CACommuSvr (
  SN   INTEGER PRIMARY KEY,
  Name TEXT NOT NULL DEFAULT '',
  IP   TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS BillingSvr (
  SN   INTEGER PRIMARY KEY,
  ip   TEXT NOT NULL DEFAULT '',
  port INTEGER NOT NULL DEFAULT 0
);
`;

/** FxItem / FxStock — the real column sets (CAItem.bak views + the
 *  UpdateUserItemTable / UpdateShopItemTable select filters). */
const SCHEMA_ITEM = `
CREATE TABLE IF NOT EXISTS FxItem (
  SN       INTEGER PRIMARY KEY,
  Category INTEGER NOT NULL DEFAULT 0,
  strAttr  TEXT NOT NULL DEFAULT '',
  nAttr1   INTEGER NOT NULL DEFAULT 0,
  nAttr2   INTEGER NOT NULL DEFAULT 0,
  nAttr3   INTEGER NOT NULL DEFAULT 0,
  strName  TEXT NOT NULL DEFAULT '',
  nLevel   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS FxStock (
  SN             INTEGER PRIMARY KEY,
  Category       INTEGER NOT NULL DEFAULT 0,
  Name           TEXT NOT NULL DEFAULT '',
  ItemSN         INTEGER NOT NULL DEFAULT 0,
  Unit           INTEGER NOT NULL DEFAULT 1,
  DataFile       TEXT NOT NULL DEFAULT '',
  Price          INTEGER NOT NULL DEFAULT 0,
  FixedPrice     INTEGER NOT NULL DEFAULT 0,
  LimitLevel     INTEGER NOT NULL DEFAULT 0,
  LimitEx        INTEGER NOT NULL DEFAULT 0,
  ValidityPeriod INTEGER NOT NULL DEFAULT 0,
  ValidityLevel  INTEGER NOT NULL DEFAULT 0,
  StringDesc     INTEGER NOT NULL DEFAULT 0,
  StringUsage    INTEGER NOT NULL DEFAULT 0,
  CardNo         INTEGER NOT NULL DEFAULT 0,
  MoneyType      INTEGER NOT NULL DEFAULT 0,
  zorder         INTEGER NOT NULL DEFAULT 0,
  IsValid        INTEGER NOT NULL DEFAULT 1,
  DateCreated    TEXT,
  Description    TEXT NOT NULL DEFAULT '',
  Usage          INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS FxString (
  SN     INTEGER PRIMARY KEY,
  String TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS FxPackageMap (
  PackageSN     INTEGER NOT NULL,
  StockSN       INTEGER NOT NULL,
  Units         INTEGER NOT NULL DEFAULT 1,
  Validitylevel INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS FxCouponMap (
  CouponSN       INTEGER NOT NULL,
  ItemSN         INTEGER NOT NULL,
  Units          INTEGER NOT NULL DEFAULT 1,
  ValidityPeriod INTEGER NOT NULL DEFAULT 0,
  Validitylevel  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS FxBonusMap (
  Price   INTEGER NOT NULL,
  StockSN INTEGER NOT NULL
);
`;

const SCHEMA_GUILD = `
CREATE TABLE IF NOT EXISTS FxGuildAccount (
  sn           INTEGER PRIMARY KEY AUTOINCREMENT,
  Name         TEXT NOT NULL DEFAULT '',
  Password     TEXT NOT NULL DEFAULT '',
  MasterID     TEXT NOT NULL DEFAULT '',
  Url          TEXT NOT NULL DEFAULT '',
  Active       INTEGER NOT NULL DEFAULT 0,
  Description  TEXT NOT NULL DEFAULT '',
  LevelLimit   INTEGER NOT NULL DEFAULT 0,
  Banner       INTEGER NOT NULL DEFAULT 0,
  DBNum        INTEGER NOT NULL DEFAULT 0,
  NumOfMembers INTEGER NOT NULL DEFAULT 1,
  SecurityPwd  TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS FxGuildDynamic (
  SN    INTEGER PRIMARY KEY,
  Exp   INTEGER NOT NULL DEFAULT 0,
  Point INTEGER NOT NULL DEFAULT 0,
  Win   INTEGER NOT NULL DEFAULT 0,
  Lose  INTEGER NOT NULL DEFAULT 0,
  Draw  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS FxGuildMember (
  sn      INTEGER NOT NULL,
  ID      TEXT NOT NULL,
  RegDate TEXT
);
CREATE TABLE IF NOT EXISTS FxGuildLimit (
  GuildSn INTEGER NOT NULL
);
`;

/** getdate() + @ValidityPeriod — the DateCreated/TicketDate format. */
function sqliteNowPlus(days: number): string {
  return new Date(Date.now() + days * 86400_000).toISOString();
}

export class CDBMan {
  userInfo: Database[] = [];
  inventory: Database[] = [];
  config!: Database;
  item!: Database;
  guild!: Database;

  constructor(dbDir: string, nUserDB = 6) {
    mkdirSync(dbDir, { recursive: true });
    for (let i = 0; i < nUserDB; i++) {
      this.userInfo.push(this.open(join(dbDir, `UserInfo${String(i).padStart(2, "0")}.db`), SCHEMA_USERINFO));
    }
    for (let i = 0; i < nUserDB; i++) {
      this.inventory.push(this.open(join(dbDir, `UserInventory${String(i).padStart(2, "0")}.db`), SCHEMA_INVENTORY));
    }
    this.config = this.open(join(dbDir, "CAConfig.db"), SCHEMA_CONFIG);
    this.item = this.open(join(dbDir, "CAItem.db"), SCHEMA_ITEM);
    this.guild = this.open(join(dbDir, "Guild.db"), SCHEMA_GUILD);
  }

  private open(path: string, schema: string): Database {
    const db = new Database(path, { create: true });
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(schema);
    return db;
  }

  GetUserHashNo(id: string): number {
    return GetUserHashNo(id);
  }

  /** prGetTime */
  prGetTime(): Date {
    return new Date();
  }

  // ============================ Config rowsets ============================

  /** CRSMultiServer ("CAMultiSvr") — row = _MULTISERVER { SN, Name, IP, Param, Current }. */
  GetMultiServers(): { SN: number; Name: string; IP: string; Param: number; Current: number }[] {
    return this.config
      .query("SELECT SN, Name, IP, Param, Current FROM CAMultiSvr ORDER BY SN")
      .all() as { SN: number; Name: string; IP: string; Param: number; Current: number }[];
  }

  /** CRSLoginServer ("CALoginSvr") — row = _LOGINSERVER { SN, IP, Port, Flag }. */
  GetLoginServers(): { SN: number; IP: string; Port: number; Flag: number }[] {
    return this.config
      .query("SELECT SN, IP, Port, Flag FROM CALoginSvr ORDER BY SN")
      .all() as { SN: number; IP: string; Port: number; Flag: number }[];
  }

  /** CRSMultiServerNotice ("CAString" type 0/1) — row = _MULTISERVERNOTICE. */
  GetMultiServerNotices(): { sn: number; type: number; value: string; strAttr: string }[] {
    return this.config
      .query("SELECT sn, type, value, strAttr FROM CAString WHERE type = 0 OR type = 1 ORDER BY sn")
      .all() as { sn: number; type: number; value: string; strAttr: string }[];
  }

  /** CRSOptions ("FxUserOptions") — CCenterProcess::UpdateLevelLimit. */
  GetOption(name: string): number {
    const row = this.config.query("SELECT VALUE FROM FxUserOptions WHERE NAME = ?").get(name) as
      | { VALUE: number }
      | null;
    return row ? row.VALUE & 0xff : 0;
  }

  /** CRSAdvertisement ("FxAdvertisement") — row = _Advertisement:
   *  strImage + 6 dwords (36-byte vector entry). The wire carries Param1/2,
   *  Param4 repeats the ad inside the rotation pool, Param5/6 bound the
   *  visibility hour window (Param6 < Param5 wraps past midnight). */
  GetAdvertisements(): {
    strImage: string; p1: number; p2: number; p3: number; p4: number; p5: number; p6: number;
  }[] {
    return this.config
      .query("SELECT strImage, Param1 p1, Param2 p2, Param3 p3, Param4 p4, Param5 p5, Param6 p6 FROM FxAdvertisement")
      .all() as { strImage: string; p1: number; p2: number; p3: number; p4: number; p5: number; p6: number }[];
  }

  /** CRSFxMessage ("FxMessage") — CCenterProcess::UpdateFxMessage
   *  (filter "messageuse = 1", select "messageattr , message"). */
  GetFxMessages(): { message: string; attr: number }[] {
    return this.config
      .query("SELECT MessageAttr attr, Message message FROM FxMessage WHERE MessageUse = 1")
      .all() as { message: string; attr: number }[];
  }

  /** CRSGuildServer ("FxGuildServerList") — row = _GuildSvrList { SN, strIp, nPort }. */
  GetGuildServerList(): { SN: number; IP: string; Port: number }[] {
    return this.config
      .query("SELECT SN, IP, Port FROM FxGuildServerList ORDER BY SN")
      .all() as { SN: number; IP: string; Port: number }[];
  }

  /** CRSCommuSvr ("CACommuSvr") — row = _COMMUNITYSVR { SN, Name, IP }. The
   *  table exists in the shipped DB but the LS never reads it on the wire. */

  /** CDBMan::GetPremiumSvrReward — FxUserOptions "PRECHMAPREWARD" (CChannelPool ctor). */
  GetPremiumSvrReward(): number {
    const row = this.config.query("SELECT VALUE FROM FxUserOptions WHERE NAME = 'PRECHMAPREWARD'").get() as
      | { VALUE: number }
      | null;
    return row ? row.VALUE : 0;
  }

  /** CDBMan::GetPremiumSvrLuckPro — "PRECHLUCKPRO", at least 30000. */
  GetPremiumSvrLuckPro(): number {
    const row = this.config.query("SELECT VALUE FROM FxUserOptions WHERE NAME = 'PRECHLUCKPRO'").get() as
      | { VALUE: number }
      | null;
    const v = row ? row.VALUE : 0;
    return v < 30000 ? 30000 : v;
  }

  // ============================ User procs ============================

  /**
   * prCAAuthUser — authenticates and bumps TOTALCONN/LASTCONN.
   * retval: -1 auth failure, 10 premium (TicketDate in the future), 0 ok.
   */
  prCAAuthUser(
    id: string,
    pwd: string,
  ): {
    retval: number;
    Fxexp: number;
    Txexp: number;
    FxMoney: number;
    Email: string;
    CommunitySvr: number;
    GuildSn: number;
    SID: number;
  } {
    const db = this.userInfo[GetUserHashNo(id)]!;
    const acc = db
      .query("SELECT SID, Email, GuildSn, CommunitySvr FROM FxUserAccount WHERE ID = ? AND Password = ?")
      .get(id, pwd) as
      | { SID: number; Email: string; GuildSn: number; CommunitySvr: number }
      | undefined;
    if (!acc) return { retval: -1, Fxexp: 0, Txexp: 0, FxMoney: 0, Email: "", CommunitySvr: 0, GuildSn: 0, SID: 0 };
    db.query("UPDATE FxUserAccount SET TotalConn = TotalConn + 1, LastConn = ? WHERE ID = ?").run(
      new Date().toISOString(),
      id,
    );
    const dyn = db.query("SELECT Money, Exp, TicketDate FROM FxUserDynamic WHERE ID = ?").get(id) as
      | { Money: number; Exp: number; TicketDate: string | null }
      | undefined;
    let retval = 0;
    if (dyn?.TicketDate) {
      const t = Date.parse(dyn.TicketDate);
      if (!Number.isNaN(t) && t > Date.now()) retval = 10; // premium channel enterable
    }
    return {
      retval,
      Fxexp: dyn?.Exp ?? 0,
      Txexp: 0,
      FxMoney: dyn?.Money ?? 0,
      Email: acc.Email,
      CommunitySvr: acc.CommunitySvr,
      GuildSn: acc.GuildSn,
      SID: acc.SID,
    };
  }

  /** prConfirmUnregisteredId — 1 when the id exists, 0 when free. */
  prConfirmUnregisteredId(id: string): number {
    const row = this.userInfo[GetUserHashNo(id)]!
      .query("SELECT COUNT(*) AS c FROM FxUserAccount WHERE ID = ?")
      .get(id) as { c: number };
    return row.c >= 1 ? 1 : 0;
  }

  /**
   * prCreateUser — the account insert (+ the dynamic rows).  The shipped
   * proc relies on the FxUserAccount.SN identity; SQLite has no per-column
   * identity beside the rowid, so SN is assigned as MAX(SN)+1 with SID = SN
   * (matching the original identity semantics).
   */
  prCreateUser(
    id: string,
    name: string,
    password: string,
    email: string,
    emailRcv: number,
    gender: number,
    address: string,
    tel: string,
    reveal: number,
    profile: string,
    passwordQ: string,
    passwordA: string,
    identityNo: string,
    birthday: string,
  ): number {
    const db = this.userInfo[GetUserHashNo(id)]!;
    try {
      const sn = (db.query("SELECT MAX(SN) AS m FROM FxUserAccount").get() as { m: number | null }).m ?? 0;
      db.query(
        `INSERT INTO FxUserAccount
           (ID, SN, SID, Name, Password, Email, EmailRcv, Gender, Address, Tel, Reveal, Profile,
            PasswordQ, PasswordA, IdentityNo, Birthday, ShopCardNo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? ,1)`,
      ).run(id, sn + 1, sn + 1, name, password, email, emailRcv, gender, address, tel, reveal, profile, passwordQ, passwordA, identityNo, birthday);
      db.query("INSERT INTO FxUserDynamic (ID) VALUES (?)").run(id);
      db.query("INSERT INTO TxUserDynamic (ID) VALUES (?)").run(id);
      return 0;
    } catch {
      return -1;
    }
  }

  /** prGetUserInfo — the _USERACCOUNT + _USERDYNINFO out-block. */
  prGetUserInfo(id: string):
    | { retval: -1 }
    | {
        retval: 0;
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
        Permission: number;
        ShopCardNo: number;
        CommunitySvr: number;
        Birthday: string;
        GuildSn: number;
        money: number;
        exp: number;
        win: number;
        draw: number;
        lose: number;
      } {
    const db = this.userInfo[GetUserHashNo(id)]!;
    const acc = db
      .query(
        `SELECT SN, Name, Password, Email, EmailRcv, Gender, Address, Tel, Reveal, Profile,
                TotalConn, LastConn, Permission, ShopCardNo, CommunitySvr, Birthday,
                GuildSn
         FROM FxUserAccount WHERE ID = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    const fail = { retval: -1 } as const;
    if (!acc) return fail;
    // NB: bun:sqlite keys a result column by its *declared* name (short_column_names),
    // not by the case written in the SELECT — alias explicitly to the _USERDYNINFO
    // field names the callers read.
    const dyn = db
      .query(
        `SELECT Money AS money, Exp AS exp, Win AS win, Draw AS draw, Lose AS lose
         FROM FxUserDynamic WHERE ID = ?`,
      )
      .get(id) as Record<string, number> | undefined;
    if (!dyn) return fail;
    return {
      retval: 0,
      SN: acc.SN as number,
      Name: acc.Name as string,
      Password: acc.Password as string,
      Email: acc.Email as string,
      EmailRcv: acc.EmailRcv as number,
      Gender: acc.Gender as number,
      Address: acc.Address as string,
      Tel: acc.Tel as string,
      Reveal: acc.Reveal as number,
      Profile: acc.Profile as string,
      TotalConn: acc.TotalConn as number,
      Permission: acc.Permission as number,
      ShopCardNo: acc.ShopCardNo as number,
      CommunitySvr: acc.CommunitySvr as number,
      Birthday: acc.Birthday as string,
      GuildSn: acc.GuildSn as number,
      money: dyn.money,
      exp: dyn.exp,
      win: dyn.win,
      draw: dyn.draw,
      lose: dyn.lose,
    };
  }

  /** prGetUserAccount / prGetUserDynamic */
  prGetUserAccount(id: string) {
    return this.userInfo[GetUserHashNo(id)]!.query("SELECT * FROM FxUserAccount WHERE ID = ?").get(id);
  }

  prGetUserDynamic(id: string) {
    return this.userInfo[GetUserHashNo(id)]!.query("SELECT * FROM FxUserDynamic WHERE ID = ?").get(id);
  }

  /** prGetEmail */
  prGetEmail(id: string): string {
    const db = this.userInfo[GetUserHashNo(id)]!;
    const r = db.query("SELECT Email FROM FxUserAccount WHERE ID = ?").get(id) as { Email: string } | undefined;
    return r ? r.Email : "error";
  }

  /** prUpdateUserAccount (profile modification) */
  prUpdateUserAccount(
    id: string,
    name: string,
    gender: number,
    address: string,
    reveal: number,
    profile: string,
    birthday: string,
  ): number {
    const db = this.userInfo[GetUserHashNo(id)]!;
    const info = db
      .query(
        `UPDATE FxUserAccount SET Name = ?, Gender = ?, Address = ?, Reveal = ?, Profile = ?, Birthday = ?
         WHERE ID = ?`,
      )
      .run(name, gender, address, reveal, profile, birthday, id);
    return info.changes === 1 ? 0 : -1;
  }

  /** prUpdateUserDynamic */
  prUpdateUserDynamic(id: string, money: number, exp: number, win: number, draw: number, lose: number): number {
    if (exp === 0 && draw === 0 && win === 0 && lose === 0) return -1;
    const db = this.userInfo[GetUserHashNo(id)]!;
    db.query("UPDATE FxUserDynamic SET MONEY = ?, EXP = ?, WIN = ?, DRAW = ?, LOSE = ? WHERE ID = ?").run(
      money,
      exp,
      win,
      draw,
      lose,
      id,
    );
    return 0;
  }

  /** prSetMoney (delta) */
  prSetMoney(id: string, money: number): number {
    const db = this.userInfo[GetUserHashNo(id)]!;
    const info = db.query("UPDATE FxUserDynamic SET Money = Money + ? WHERE ID = ?").run(money, id);
    return info.changes === 1 ? 0 : -1;
  }

  /** prResetMoney (absolute) */
  prResetMoney(id: string, money: number): number {
    if (money < 0) return -1;
    const db = this.userInfo[GetUserHashNo(id)]!;
    const info = db.query("UPDATE FxUserDynamic SET Money = ? WHERE ID = ?").run(money, id);
    return info.changes === 1 ? 0 : -1;
  }

  /** prSetFxExp — shop variant used after purchases. */
  prSetFxExp(id: string, exp: number): number {
    const db = this.userInfo[GetUserHashNo(id)]!;
    const info = db.query("UPDATE FxUserDynamic SET exp = exp + ? WHERE ID = ?").run(exp, id);
    return info.changes === 1 ? 0 : -1;
  }

  /** prSetPremiumTicket */
  prSetPremiumTicket(id: string, validityPeriod: number): number {
    const db = this.userInfo[GetUserHashNo(id)]!;
    const row = db.query("SELECT TicketDate FROM FxUserDynamic WHERE ID = ?").get(id) as
      | { TicketDate: string | null }
      | undefined;
    if (!row) return 0;
    const old = row.TicketDate ? Date.parse(row.TicketDate) : NaN;
    const base = !Number.isNaN(old) && old > Date.now() ? old : Date.now();
    const next = new Date(base + validityPeriod * 86400_000).toISOString();
    db.query("UPDATE FxUserDynamic SET TicketDate = ? WHERE ID = ?").run(next, id);
    return 1; // CDBMan::SetPremiumTicket returns BOOL — nonzero on success
  }

  // ========================== Inventory procs ==========================

  private invDB(id: string): Database {
    return this.inventory[GetUserHashNo(id)]!;
  }

  /** prIsValidInventory — returns Amount owned (0 when none). */
  prIsValidInventory(userID: string, itemSN: number): number {
    const r = this.invDB(userID)
      .query("SELECT Amount FROM FxUserInventory WHERE UserID = ? AND ItemSN = ?")
      .get(userID, itemSN) as { Amount: number } | undefined;
    return r ? r.Amount : 0;
  }

  /** prIsValidPreInventory — summed Amount in pre-inventory. */
  prIsValidPreInventory(userID: string, itemSN: number): number {
    const r = this.invDB(userID)
      .query("SELECT SUM(Amount) AS a FROM FxPreInventory WHERE UserID = ? AND ItemSN = ? GROUP BY ItemSN")
      .get(userID, itemSN) as { a: number | null } | undefined;
    return r && r.a != null ? r.a : 0;
  }

  /** prIsGrValidInventory */
  prIsGrValidInventory(userID: string, groupSNStart: number, groupSNEnd: number): number {
    const r = this.invDB(userID)
      .query("SELECT Amount FROM FxUserInventory WHERE UserID = ? AND ItemSN >= ? AND ItemSN <= ?")
      .get(userID, groupSNStart, groupSNEnd) as { Amount: number } | undefined;
    return r ? r.Amount : 0;
  }

  /** prIsGrValidPreInventory */
  prIsGrValidPreInventory(userID: string, groupSNStart: number, groupSNEnd: number): number {
    const r = this.invDB(userID)
      .query(
        "SELECT SUM(Amount) AS a FROM FxPreInventory WHERE UserID = ? AND ItemSN >= ? AND ItemSN <= ? GROUP BY ItemSN",
      )
      .get(userID, groupSNStart, groupSNEnd) as { a: number | null } | undefined;
    return r && r.a != null ? r.a : 0;
  }

  /** prAddInventory */
  prAddInventory(
    userSN: number,
    id: string,
    itemSN: number,
    stockSN: number,
    unit: number,
    validityPeriod: number,
    userLevel: number,
    addable: number,
  ): number {
    const db = this.invDB(id);
    if (addable === 1) {
      const info = db
        .query("UPDATE FxUserInventory SET Amount = Amount + ? WHERE UserID = ? AND ItemSN = ?")
        .run(unit, id, itemSN);
      if (info.changes === 0) {
        const ins = db
          .query(
            `INSERT INTO FxUserInventory (UserSN, UserID, ItemSN, StockSN, Amount, DateCreated, LevelCreated)
             VALUES (?,?,?,?,?,?,?)`,
          )
          .run(userSN, id, itemSN, stockSN, unit, sqliteNowPlus(validityPeriod), userLevel);
        return ins.changes === 1 ? 0 : -1;
      }
      return 0;
    }
    const exists = db
      .query("SELECT 1 FROM FxUserInventory WHERE UserID = ? AND ItemSN = ?")
      .get(id, itemSN);
    if (exists) return -2;
    const ins = db
      .query(
        `INSERT INTO FxUserInventory (UserSN, UserID, ItemSN, StockSN, Amount, DateCreated, LevelCreated)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(userSN, id, itemSN, stockSN, unit, sqliteNowPlus(validityPeriod), userLevel);
    return ins.changes === 1 ? 0 : -1;
  }

  /** prAddPreInventory (returns the new SN) */
  prAddPreInventory(
    id: string,
    type: number,
    itemSN: number,
    stockSN: number,
    amount: number,
    validityPeriod: number,
    validityLevel: number,
    strAttr = "",
    description = "",
  ): number {
    const info = this.invDB(id)
      .query(
        `INSERT INTO FxPreInventory (UserID, Type, ItemSN, StockSN, Amount, ValidityPeriod, ValidityLevel, strAttr, Description)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, type, itemSN, stockSN, amount, validityPeriod, validityLevel, strAttr, description);
    return Number(info.lastInsertRowid);
  }

  /** prDeleteInventory */
  prDeleteInventory(userID: string, itemSN: number): number {
    const info = this.invDB(userID)
      .query("DELETE FROM FxUserInventory WHERE UserID = ? AND ItemSN = ?")
      .run(userID, itemSN);
    return info.changes === 1 ? 0 : -1;
  }

  /** prLoadInventory — move a pre-inventory row into the live inventory. */
  prLoadInventory(
    preInventorySn: number,
    userID: string,
    itemSN: number,
    stockSN: number,
    _slot: number,
    unit: number,
    validityPeriod: number,
    userLevel: number,
    truncateOnly: number,
  ): number {
    const db = this.invDB(userID);
    if (truncateOnly === 0) {
      const info = db
        .query("UPDATE FxUserInventory SET Amount = Amount + ? WHERE UserID = ? AND ItemSN = ?")
        .run(unit, userID, itemSN);
      if (info.changes === 0) {
        db.query(
          `INSERT INTO FxUserInventory (UserSN, UserID, ItemSN, StockSN, Amount, DateCreated, LevelCreated)
           VALUES (0,?,?,?,?,?,?)`,
        ).run(userID, itemSN, stockSN, unit, sqliteNowPlus(validityPeriod), userLevel);
      }
    }
    db.query("DELETE FROM FxPreInventory WHERE SN = ?").run(preInventorySn);
    return 0;
  }

  /** prUpdateInventoryAmount (absolute) */
  prUpdateInventoryAmount(userID: string, itemSN: number, amount: number): number {
    const info = this.invDB(userID)
      .query("UPDATE FxUserInventory SET Amount = ? WHERE UserID = ? AND ItemSN = ?")
      .run(amount, userID, itemSN);
    return info.changes === 1 ? 0 : -1;
  }

  /** prUpdateInventoryAmountDelta */
  prUpdateInventoryAmountDelta(userID: string, itemSN: number, amount: number): number {
    const info = this.invDB(userID)
      .query("UPDATE FxUserInventory SET Amount = Amount + ? WHERE UserID = ? AND ItemSN = ?")
      .run(amount, userID, itemSN);
    return info.changes === 1 ? 0 : -1;
  }

  /** prUpdateInventorySlot */
  prUpdateInventorySlot(userID: string, itemSN: number, slot: number): number {
    const info = this.invDB(userID)
      .query("UPDATE FxUserInventory SET Slot = ? WHERE UserID = ? AND ItemSN = ?")
      .run(slot, userID, itemSN);
    return info.changes === 1 ? 0 : -1;
  }

  /** prUpdateInventoryVerbose */
  prUpdateInventoryVerbose(userID: string, itemSN: number, verbose: string): number {
    const info = this.invDB(userID)
      .query("UPDATE FxUserInventory SET Verbose = ? WHERE UserID = ? AND ItemSN = ?")
      .run(verbose, userID, itemSN);
    return info.changes === 1 ? 0 : -1;
  }

  /** prGetUserCartList */
  prGetUserCartList(id: string): { retval: number; stockSN: string } {
    const r = this.invDB(id).query("SELECT StockSNList FROM FxCart WHERE UserID = ?").get(id) as
      | { StockSNList: string }
      | undefined;
    return r ? { retval: 1, stockSN: r.StockSNList } : { retval: 0, stockSN: "" };
  }

  /** prAddUserCartList */
  prAddUserCartList(id: string, stockSNList: string): number {
    this.invDB(id)
      .query(
        `INSERT INTO FxCart (UserID, StockSNList) VALUES (?,?)
         ON CONFLICT(UserID) DO UPDATE SET StockSNList = excluded.StockSNList`,
      )
      .run(id, stockSNList);
    return 0;
  }

  /** CRSUserInventory — the live rows (InitUserInventory's select list). */
  GetUserInventoryRows(userID: string): {
    ItemSN: number;
    Slot: number;
    Amount: number;
    DateCreated: string | null;
    LevelCreated: number;
    StockSN: number;
    Verbose: string;
  }[] {
    return this.invDB(userID)
      .query("SELECT ItemSN, Slot, Amount, DateCreated, LevelCreated, StockSN, Verbose FROM FxUserInventory WHERE UserID = ?")
      .all(userID) as {
      ItemSN: number;
      Slot: number;
      Amount: number;
      DateCreated: string | null;
      LevelCreated: number;
      StockSN: number;
      Verbose: string;
    }[];
  }

  /** CRSPreInventory — the pre-inventory rows (InitPreInventory's select list). */
  GetPreInventoryRows(userID: string): {
    SN: number;
    Type: number;
    ItemSN: number;
    StockSN: number;
    Slot: number;
    Amount: number;
    Description: string;
    ValidityPeriod: number;
    ValidityLevel: number;
    strAttr: string;
  }[] {
    return this.invDB(userID)
      .query(
        `SELECT SN, Type, ItemSN, StockSN, Slot, Amount, Description, ValidityPeriod, ValidityLevel, strAttr
         FROM FxPreInventory WHERE UserID = ? ORDER BY SN`,
      )
      .all(userID) as {
      SN: number;
      Type: number;
      ItemSN: number;
      StockSN: number;
      Slot: number;
      Amount: number;
      Description: string;
      ValidityPeriod: number;
      ValidityLevel: number;
      strAttr: string;
    }[];
  }

  // ============================ Guild procs ============================

  prCreateGuild(
    id: string,
    name: string,
    password: string,
    url: string,
    description: string,
    levelLimit: number,
    banner: number,
    securityPwd: string,
  ): number {
    const db = this.guild;
    const dup = db.query("SELECT 1 FROM FxGuildAccount WHERE Name = ?").get(name);
    if (dup) return -2;
    const info = db
      .query(
        `INSERT INTO FxGuildAccount (Name, Password, MasterID, Url, Description, LevelLimit, Banner, SecurityPwd)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(name, password, id, url, description, levelLimit, banner, securityPwd);
    return info.changes === 1 ? 0 : -1;
  }

  prActivateGuild(sn: number, securityPwd: string): number {
    const info = this.guild
      .query("UPDATE FxGuildAccount SET Active = 1 WHERE sn = ? AND SecurityPwd = ?")
      .run(sn, securityPwd);
    return info.changes === 1 ? 0 : -1;
  }

  prDeleteGuild(sn: number, securityPwd: string): number {
    const info = this.guild
      .query("DELETE FROM FxGuildAccount WHERE sn = ? AND SecurityPwd = ?")
      .run(sn, securityPwd);
    return info.changes === 1 ? 0 : -1;
  }

  prGetGuildAccount(sn: number) {
    return this.guild.query("SELECT * FROM FxGuildAccount WHERE sn = ?").get(sn);
  }

  prGetGuildDynamic(sn: number) {
    return this.guild.query("SELECT * FROM FxGuildDynamic WHERE SN = ?").get(sn);
  }

  prGetGuildMember(sn: number) {
    return this.guild.query("SELECT ID, RegDate FROM FxGuildMember WHERE sn = ? ORDER BY RegDate").all(sn);
  }

  prGetGuildMemberCount(sn: number): number {
    const r = this.guild.query("SELECT COUNT(*) AS c FROM FxGuildMember WHERE sn = ?").get(sn) as { c: number };
    return r.c;
  }

  /** prGetGuildSimpleInfo */
  prGetGuildSimpleInfo(sn: number) {
    return this.guild
      .query("SELECT Name, MasterID, MarkRevision FROM FxGuildAccount WHERE sn = ?")
      .get(sn);
  }

  /** prGetGuildSimpleInfo2 — CGuildTable::Insert / CDBMan::InitGuild. */
  prGetGuildSimpleInfo2(sn: number): { retval: number; Name: string; MasterID: string; MarkRevision: number } {
    const r = this.guild
      .query("SELECT Name, MasterID, MarkRevision FROM FxGuildAccount WHERE sn = ?")
      .get(sn) as { Name: string; MasterID: string; MarkRevision: number } | undefined;
    if (!r) return { retval: -1, Name: "", MasterID: "", MarkRevision: 0 };
    return { retval: 0, ...r };
  }

  /** prUpdateGuildDynamic (@ExpInc/@WinInc/@DrawInc/@LoseInc deltas) */
  prUpdateGuildDynamic(sn: number, expInc: number, winInc: number, drawInc: number, loseInc: number): number {
    const info = this.guild
      .query(
        `UPDATE FxGuildDynamic SET Exp = Exp + ?, Win = Win + ?, Lose = Lose + ?, Draw = Draw + ?
         WHERE SN = ?`,
      )
      .run(expInc, winInc, loseInc, drawInc, sn);
    return info.changes === 1 ? 0 : -1;
  }

  prUpdateGuildAccount(sn: number, name: string, url: string, description: string, levelLimit: number, banner: number): number {
    const info = this.guild
      .query("UPDATE FxGuildAccount SET Name = ?, Url = ?, Description = ?, LevelLimit = ?, Banner = ? WHERE sn = ?")
      .run(name, url, description, levelLimit, banner, sn);
    return info.changes === 1 ? 0 : -1;
  }

  /** prGetGuildList */
  prGetGuildList(_OT: number, _flagIdx: string, _flagIdx2: number, _rownum: number) {
    return this.guild
      .query(
        `SELECT sn, Name, MasterID, NumOfMembers, LevelLimit FROM FxGuildAccount WHERE Active = 1
         ORDER BY sn LIMIT ?`,
      )
      .all(_rownum);
  }

  // ============================ CAItem procs ============================

  /** The FxStock rowset (CRSShopItem order). */
  GetShopStock(): {
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
  }[] {
    return this.item
      .query(
        `SELECT SN, Category, Name, Description, ItemSN, Unit, DataFile, Price,
                LimitLevel, LimitEx, ValidityPeriod, ValidityLevel
         FROM FxStock ORDER BY SN`,
      )
      .all() as {
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
    }[];
  }

  /** The FxItem rowset (CRSUserItem order). */
  GetItemInfo(): {
    SN: number;
    Category: number;
    strAttr: string;
    nAttr1: number;
    nAttr2: number;
    nAttr3: number;
    strName: string;
  }[] {
    return this.item
      .query("SELECT SN, Category, strAttr, nAttr1, nAttr2, nAttr3, strName FROM FxItem ORDER BY SN")
      .all() as {
      SN: number;
      Category: number;
      strAttr: string;
      nAttr1: number;
      nAttr2: number;
      nAttr3: number;
      strName: string;
    }[];
  }

  // ============================ CAConfig procs ============================

  prGetRowset(db: Database, table: string, where: string): unknown[] {
    return db.query(`SELECT * FROM ${table} WHERE ${where}`).all();
  }

  prGetRowsetCols2(db: Database, table: string, where: string, columnSet: string): unknown[] {
    return db.query(`SELECT ${columnSet} FROM ${table} WHERE ${where}`).all();
  }

  /** CRSUserItem ("FxItem") — UpdateUserItemTable's select filter. */
  GetFxItemRows(): { SN: number; Category: number; strAttr: string; nAttr1: number; nAttr2: number; nAttr3: number; strName: string }[] {
    return this.item
      .query("SELECT SN, Category, strAttr, nAttr1, nAttr2, nAttr3, strName FROM FxItem ORDER BY SN")
      .all() as never;
  }

  /** CRSShopItem ("FxStock") — UpdateShopItemTable's 17-column select, WHERE IsValid > 0. */
  GetFxStockRows(): {
    SN: number; Category: number; Name: string; ItemSN: number; Unit: number; DataFile: string;
    Price: number; FixedPrice: number; LimitLevel: number; LimitEx: number; ValidityPeriod: number;
    ValidityLevel: number; StringDesc: number; StringUsage: number; CardNo: number; MoneyType: number; zorder: number;
  }[] {
    return this.item
      .query(
        `SELECT SN, Category, Name, ItemSN, Unit, DataFile, Price, FixedPrice, LimitLevel, LimitEx,
                ValidityPeriod, ValidityLevel, StringDesc, StringUsage, CardNo, MoneyType, zorder
         FROM FxStock WHERE IsValid > 0 ORDER BY SN`,
      )
      .all() as never;
  }

  /** CRSString ("FxString") — UpdateStringTable's select filter. */
  GetFxStringRows(): { SN: number; String: string }[] {
    return this.item.query("SELECT SN, String FROM FxString ORDER BY SN").all() as never;
  }

  /** CRSPackageMap ("FxPackageMap") — UpdatePackageMapTable's select filter. */
  GetFxPackageMapRows(): { PackageSN: number; StockSN: number; Units: number; Validitylevel: number }[] {
    return this.item
      .query("SELECT PackageSN, StockSN, Units, Validitylevel FROM FxPackageMap ORDER BY PackageSN")
      .all() as never;
  }

  /** CRSCouponMap ("FxCouponMap") — UpdateCouponMapTable's select filter. */
  GetFxCouponMapRows(): { CouponSN: number; ItemSN: number; Units: number; ValidityPeriod: number; Validitylevel: number }[] {
    return this.item
      .query("SELECT CouponSN, ItemSN, Units, ValidityPeriod, Validitylevel FROM FxCouponMap ORDER BY CouponSN")
      .all() as never;
  }

  /** CRSBonusMap ("FxBonusMap") — UpdateBonusMapTable's select filter. */
  GetFxBonusMapRows(): { Price: number; StockSN: number }[] {
    return this.item.query("SELECT Price, StockSN FROM FxBonusMap ORDER BY StockSN").all() as never;
  }

  /** CRSBillingSvr ("BillingSvr" on CAConfig) — CBillingProcess::UpdateBillingSvrList. */
  GetBillingSvrs(): { SN: number; ip: string; port: number }[] {
    return this.config.query("SELECT SN, ip, port FROM BillingSvr ORDER BY SN").all() as never;
  }

  /** CDBMan::GetUserInfo (prGetUserInfoShop) — the shop's _USERACCOUNT fill; the
   *  @money/@win/@draw/@lose out-params come from FxUserDynamic. */
  prGetUserInfoShop(id: string):
    | null
    | { SN: number; Name: string; Password: string; Email: string; EmailRcv: number; Gender: number;
        Address: string; Tel: string; Reveal: number; Profile: string; TotalConn: number;
        LastConn: string | null; Permission: number; ShopCardNo: number; CommunitySvr: number;
        money: number; win: number; draw: number; lose: number } {
    const row = this.userInfo[GetUserHashNo(id)]!
      .query(
        `SELECT a.SN, a.Name, a.Password, a.Email, a.EmailRcv, a.Gender, a.Address, a.Tel, a.Reveal,
                a.Profile, a.TotalConn, a.LastConn, a.Permission, a.ShopCardNo, a.CommunitySvr,
                COALESCE(d.Money, 0) AS money, COALESCE(d.Win, 0) AS win,
                COALESCE(d.Draw, 0) AS draw, COALESCE(d.Lose, 0) AS lose
         FROM FxUserAccount a LEFT JOIN FxUserDynamic d ON d.ID = a.ID WHERE a.ID = ?`,
      )
      .get(id) as never;
    return (row ?? null) as never;
  }

  /** CDBMan::GetFxInventoryRows — the CUser inventory load (CRSInventory select). */
  GetFxInventoryRows(id: string): { SN: number; ItemSN: number; StockSN: number; Slot: number; Amount: number; Verbose: string; DateCreated: string | null }[] {
    return this.inventory[GetUserHashNo(id)]!
      .query(
        `SELECT SN, ItemSN, StockSN, Slot, Amount, Verbose, DateCreated
         FROM FxUserInventory WHERE UserID = ? ORDER BY SN`,
      )
      .all() as never;
  }

  /** CDBMan::AddNewInventory (shop variant) — prAddInventory with the shop arg
   *  set.  The @UserSN lookup runs on the user shard, the row lands on the
   *  inventory shard (two separate databases).  Returns 1 on success, 0 on
   *  failure — CDBMan::AddNewInventory's convention. */
  prAddInventoryShop(id: string, itemSN: number, stockSN: number, unit: number, validityPeriod: number, userLevel: number): number {
    const acc = this.userInfo[GetUserHashNo(id)]!
      .query("SELECT COALESCE(SN, 0) AS UserSN FROM FxUserAccount WHERE ID = ?")
      .get(id) as { UserSN: number } | undefined;
    if (!acc) return 0;
    const r = this.inventory[GetUserHashNo(id)]!
      .query(
        `INSERT INTO FxUserInventory (UserSN, UserID, ItemSN, StockSN, Slot, Amount, DateCreated, LevelCreated, Verbose)
         VALUES (?, ?, ?, ?, 255, ?, datetime('now'), ?, '')
         ON CONFLICT(UserID, ItemSN) DO UPDATE SET Amount = Amount + excluded.Amount
         RETURNING ItemSN`,
      )
      .get(acc.UserSN, id, itemSN, stockSN, unit, userLevel) as { ItemSN: number } | undefined;
    return r ? 1 : 0;
  }

  prGetStringAttr(attrId: string): { retval: number; strVal: string } {
    const r = this.config.query("SELECT strVal FROM BillingConfig WHERE AttrID = ?").get(attrId) as
      | { strVal: string }
      | undefined;
    return r ? { retval: 0, strVal: r.strVal } : { retval: -1, strVal: "" };
  }
}
