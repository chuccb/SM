import { timingSafeEqual } from "node:crypto";
import { CDBSession } from "./CDBSession.ts";
import type {
  NewUserFields,
  _USERINFO,
  _USERINVENTORY,
  UserItem,
  UserDynamicChange,
} from "./Rows.ts";
import {
  DatabaseLayout,
  UserFieldSize,
  ConfirmIdResult,
  IntegerRange,
} from "../OfficialValues.ts";
import { CopyUserItem } from "../UserItem.ts";
import { RuntimePolicy } from "../RuntimePolicy.ts";
import { DefaultTextCodec, type CTextCodec } from "../CTextCodec.ts";
import { CProtocolError } from "../CProtocolError.ts";
import { EncodePassword } from "../EncodePassword.ts";

import type { _SYSTEMTIME } from "../Calendar.ts";
import {
  ConvertDBTimeToSystemTime,
  ConvertSystemTimeToDBTime,
  type tagDBTIMESTAMP,
} from "./NativeCalendar.ts";

const UserInfoQuery = `SELECT a.SID,a.ID,a.UserHashNo,a.Name,a.Email,a.EmailRcv,a.Gender,a.Address,a.Tel,a.Reveal,a.Profile,a.PasswordQ,a.IdentityNo,a.Birthday,a.CommunitySvr,a.GuildSn,a.Authority,a.TotalConn,a.LastConn,a.CreatedAt,a.BannedUntil,d.Money,d.Exp,d.Win,d.Draw,d.Lose,d.TicketDate FROM FxUserAccount a JOIN FxUserDynamic d USING(ID) WHERE a.ID = ?`;
export class CDBManBase {
  constructor(
    readonly session: CDBSession,
    readonly text: CTextCodec = DefaultTextCodec,
  ) {}
  /** Native field-copy cores ONLY; no schema/Unix reinterpretation or SQL. */
  ConvertDBTimeToSystemTime(
    time: Readonly<tagDBTIMESTAMP>,
    observedWeekday: number | null = null,
  ): Readonly<_SYSTEMTIME> {
    return ConvertDBTimeToSystemTime(time, observedWeekday);
  }
  ConvertSystemTimeToDBTime(
    time: Readonly<_SYSTEMTIME>,
  ): Readonly<tagDBTIMESTAMP> {
    return ConvertSystemTimeToDBTime(time);
  }
  GetUserHashNo(id: string): number {
    let first = this.text.Encode(id)[0];
    if (first === undefined) throw new CProtocolError("Empty user ID");
    if (first >= 0x41 && first <= 0x5a) first += 32;
    return first % DatabaseLayout.UserShardCount;
  }
  ValidateID(id: string): void {
    const bytes = this.text.Encode(id);
    if (
      !bytes.length ||
      bytes.length > UserFieldSize.ID ||
      /[\x00-\x20\x7f]/.test(id)
    )
      throw new CProtocolError("Invalid legacy-byte user ID");
  }
  ValidatePassword(password: string): void {
    const size = this.text.Encode(password).length;
    if (
      !size ||
      size > RuntimePolicy.MaxPasswordBytes ||
      password.includes("\0")
    )
      throw new CProtocolError("Invalid password size");
  }
  ConfirmUnregisteredId(id: string): number {
    this.ValidateID(id);
    return this.session.db
      .query("SELECT SID FROM FxUserAccount WHERE ID = ?")
      .get(id)
      ? ConfirmIdResult.Exists
      : ConfirmIdResult.Available;
  }
  /** prCreateUser replacement. Hash BEFORE transaction; uniqueness is checked by SQLite. */
  async RegisterNewUser(fields: NewUserFields): Promise<_USERINFO> {
    this.ValidateID(fields.ID);
    this.ValidatePassword(fields.Password);
    for (const [name, limit] of Object.entries(UserFieldSize)) {
      if (name === "EncodedPassword" || name === "ID") continue;
      const value = fields[name as keyof NewUserFields];
      if (
        typeof value === "string" &&
        (value.includes("\0") || this.text.Encode(value).length > limit)
      )
        throw new CProtocolError(`User field ${name} exceeds original limit`);
    }
    for (const name of ["EmailRcv", "Gender", "Reveal"] as const) {
      const value = fields[name];
      if (
        value !== undefined &&
        (!Number.isInteger(value) || value < 0 || value > 255)
      )
        throw new CProtocolError(`Invalid user flag ${name}`);
    }
    const password = await Bun.password.hash(
      fields.Password,
      RuntimePolicy.PasswordHash,
    );
    const answer = fields.PasswordA
      ? await Bun.password.hash(fields.PasswordA, RuntimePolicy.PasswordHash)
      : "";
    return this.session.db
      .transaction(() => {
        this.session.db
          .query(
            `INSERT INTO FxUserAccount (ID,UserHashNo,Password,Name,Email,EmailRcv,Gender,Address,Tel,Reveal,Profile,PasswordQ,PasswordA,IdentityNo,Birthday) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            fields.ID,
            this.GetUserHashNo(fields.ID),
            password,
            fields.Name ?? fields.ID,
            fields.Email ?? "",
            fields.EmailRcv ?? 0,
            fields.Gender ?? 0,
            fields.Address ?? "",
            fields.Tel ?? "",
            fields.Reveal ?? 0,
            fields.Profile ?? "",
            fields.PasswordQ ?? "",
            answer,
            fields.IdentityNo ?? "",
            fields.Birthday ?? "",
          );
        this.session.db
          .query("INSERT INTO FxUserDynamic (ID) VALUES (?)")
          .run(fields.ID);
        const user = this.GetUserInfo(fields.ID)!;
        this.Audit("prCreateUser", user.SID, "{}");
        return user;
      })
      .immediate();
  }
  /** prCAAuthUser: no SQL injection, original password bypasses are NOT reproduced. */
  async InitUser(id: string, password: string): Promise<_USERINFO | undefined> {
    this.ValidateID(id);
    this.ValidatePassword(password);
    const row = this.session.db
      .query<
        { Password: string },
        [string]
      >("SELECT Password FROM FxUserAccount WHERE ID = ?")
      .get(id);
    if (!row) {
      // Dummy hash verification reduces the trivial absent-user timing signal.
      await Bun.password.verify(password, await this.dummyHash());
      return undefined;
    }
    const valid = row.Password.startsWith("$argon2")
      ? await Bun.password.verify(password, row.Password)
      : this.verifyLegacy(password, row.Password);
    if (!valid) return undefined;
    // Password can be reset while Argon is running. Compare the stored hash again atomically.
    const user = this.GetUserInfo(id);
    if (
      !user ||
      user.BannedUntil === -1 ||
      user.BannedUntil > Math.floor(Date.now() / 1000)
    )
      return undefined;
    const replacement = row.Password.startsWith("legacy-uu:")
      ? await Bun.password.hash(password, RuntimePolicy.PasswordHash)
      : row.Password;
    const updated = this.session.db
      .query(
        "UPDATE FxUserAccount SET Password = ?, TotalConn = TotalConn + 1, LastConn = unixepoch() WHERE ID = ? AND Password = ? AND (BannedUntil = 0 OR (BannedUntil > 0 AND BannedUntil <= unixepoch()))",
      )
      .run(replacement, id, row.Password);
    if (!updated.changes) return undefined;
    return this.GetUserInfo(id);
  }
  async SetPassword(id: string, password: string): Promise<void> {
    this.ValidateID(id);
    this.ValidatePassword(password);
    const hash = await Bun.password.hash(password, RuntimePolicy.PasswordHash);
    if (
      !this.session.db
        .query("UPDATE FxUserAccount SET Password = ? WHERE ID = ?")
        .run(hash, id).changes
    )
      throw new CProtocolError("Unknown user");
    this.Audit("cli:reset-password", this.GetUserInfo(id)!.SID, "{}");
  }
  private static dummy: Promise<string> | undefined;
  private dummyHash(): Promise<string> {
    return (CDBManBase.dummy ??= Bun.password.hash(
      crypto.randomUUID(),
      RuntimePolicy.PasswordHash,
    ));
  }
  private verifyLegacy(password: string, stored: string): boolean {
    // Only imported databases can contain this explicitly tagged reversible legacy format.
    if (!stored.startsWith("legacy-uu:")) return false;
    const expected = Buffer.from(stored.slice(10), "base64");
    const actual = EncodePassword(this.text.Encode(password));
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }
  GetUserInfo(id: string): _USERINFO | undefined {
    return (
      this.session.db.query<_USERINFO, [string]>(UserInfoQuery).get(id) ??
      undefined
    );
  }
  GetUserInfoShop(id: string): _USERINFO | undefined {
    return this.GetUserInfo(id);
  }
  GetUserBySID(sid: number): _USERINFO | undefined {
    const row = this.session.db
      .query<
        { ID: string },
        [number]
      >("SELECT ID FROM FxUserAccount WHERE SID = ?")
      .get(sid);
    return row ? this.GetUserInfo(row.ID) : undefined;
  }
  LoadInventory(
    id: string,
    now = Math.floor(Date.now() / 1000),
  ): _USERINVENTORY[] {
    return this.session.db
      .query<
        _USERINVENTORY,
        [string, number]
      >("SELECT * FROM FxUserInventory WHERE ID = ? AND (ExpireDate = 0 OR ExpireDate > ?) ORDER BY SN")
      .all(id, now);
  }
  AddInventory(
    id: string,
    itemID: number,
    amount: number,
    expiry = 0,
    verbose = "",
  ): _USERINVENTORY {
    this.positive(amount);
    this.u32(itemID);
    this.u32(expiry);
    if (
      this.text.Encode(verbose).length > RuntimePolicy.MaxInventoryVerboseBytes
    )
      throw new CProtocolError("Inventory verbose too long");
    const result = this.session.db
      .query(
        "INSERT INTO FxUserInventory (ID,ItemID,Amount,ExpireDate,Verbose) VALUES (?,?,?,?,?)",
      )
      .run(id, itemID, amount, expiry, verbose);
    return this.session.db
      .query<
        _USERINVENTORY,
        [number]
      >("SELECT * FROM FxUserInventory WHERE SN = ?")
      .get(Number(result.lastInsertRowid))!;
  }
  DeleteInventory(id: string, sn: number): boolean {
    return (
      this.session.db
        .query("DELETE FROM FxUserInventory WHERE ID = ? AND SN = ?")
        .run(id, sn).changes === 1
    );
  }
  UpdateInventoryAmountDelta(id: string, sn: number, delta: number): boolean {
    if (!Number.isSafeInteger(delta) || Math.abs(delta) > 0x7fffffff)
      throw new CProtocolError("Invalid amount delta");
    return this.session.db
      .transaction(() => {
        const row = this.session.db
          .query<
            { Amount: number },
            [string, number]
          >("SELECT Amount FROM FxUserInventory WHERE ID = ? AND SN = ?")
          .get(id, sn);
        if (!row || row.Amount + delta < 0 || row.Amount + delta > 0x7fffffff)
          return false;
        if (row.Amount + delta === 0) return this.DeleteInventory(id, sn);
        this.session.db
          .query(
            "UPDATE FxUserInventory SET Amount = Amount + ? WHERE ID = ? AND SN = ?",
          )
          .run(delta, id, sn);
        return true;
      })
      .immediate();
  }
  UpdateInventorySlot(id: string, sn: number, slot: number): boolean {
    if (!Number.isInteger(slot) || slot < 0 || slot > 255)
      throw new CProtocolError("Invalid inventory slot");
    return (
      this.session.db
        .query("UPDATE FxUserInventory SET Slot = ? WHERE ID = ? AND SN = ?")
        .run(slot, id, sn).changes === 1
    );
  }
  UpdateInventoryVerbose(id: string, sn: number, verbose: string): boolean {
    if (
      this.text.Encode(verbose).length > RuntimePolicy.MaxInventoryVerboseBytes
    )
      throw new CProtocolError("Inventory verbose too long");
    return (
      this.session.db
        .query("UPDATE FxUserInventory SET Verbose = ? WHERE ID = ? AND SN = ?")
        .run(verbose, id, sn).changes === 1
    );
  }
  /** prSetMoney adds a signed delta, not an absolute assignment (backup text + FXSS call). */
  SetMoney(id: string, delta: number): boolean {
    if (!Number.isInteger(delta) || Math.abs(delta) > 0x7fffffff)
      throw new CProtocolError("Invalid money delta");
    return (
      this.session.db
        .query(
          "UPDATE FxUserDynamic SET Money = Money + ? WHERE ID = ? AND Money + ? BETWEEN 0 AND 2147483647",
        )
        .run(delta, id, delta).changes === 1
    );
  }
  SetFxExp(id: string, exp: number): boolean {
    this.u31(exp);
    return (
      this.session.db
        .query("UPDATE FxUserDynamic SET Exp = ? WHERE ID = ?")
        .run(exp, id).changes === 1
    );
  }
  UpdateUserDynamic(
    id: string,
    money: number,
    exp: number,
    win: number,
    draw: number,
    lose: number,
  ): boolean {
    for (const n of [money, exp, win, draw, lose]) this.u31(n);
    return (
      this.session.db
        .query(
          "UPDATE FxUserDynamic SET Money = ?,Exp = ?,Win = ?,Draw = ?,Lose = ? WHERE ID = ?",
        )
        .run(money, exp, win, draw, lose, id).changes === 1
    );
  }
  /** Modern SQLite replacement primitive, NOT native multi-user atomicity.
   * Native WriteUserDynInfo 00408FD2 writes absolute values one user at a time.
   * Compare ALL five prior values (including unchanged Money) to avoid lost
   * concurrent updates. Conflict returns false and rolls back the WHOLE batch;
   * SQL/constraint failures propagate after rollback. No memory/packet effects.
   * This is NOT a durable round receipt, ABA defense or exactly-once lifecycle.
   */
  UpdateUserDynamicBatch(changes: readonly UserDynamicChange[]): boolean {
    if (!changes.length || changes.length > RuntimePolicy.MaxDynamicBatchUsers)
      throw new CProtocolError("Invalid dynamic update batch size");
    const ids = new Set<string>();
    for (const change of changes) {
      if (!change?.Before || !change.After)
        throw new CProtocolError("Missing dynamic update snapshots");
      const { Before, After } = change;
      this.ValidateID(Before.ID);
      if (Before.ID !== After.ID)
        throw new CProtocolError("Dynamic update cannot change user ID");
      // SQLite NOCASE folds ASCII only; JS Unicode toLowerCase is different.
      const key = Before.ID.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
      if (ids.has(key))
        throw new CProtocolError("Duplicate dynamic update user");
      ids.add(key);
      for (const state of [Before, After])
        for (const value of [
          state.Money,
          state.Exp,
          state.Win,
          state.Draw,
          state.Lose,
        ])
          this.u31(value);
    }
    const conflict = Symbol("dynamic snapshot conflict");
    const update = this.session.db.query(`UPDATE FxUserDynamic
      SET Money = ?, Exp = ?, Win = ?, Draw = ?, Lose = ?
      WHERE ID = ? AND Money = ? AND Exp = ? AND Win = ? AND Draw = ? AND Lose = ?`);
    try {
      return this.session.db
        .transaction(() => {
          for (const { Before, After } of changes) {
            const result = update.run(
              After.Money,
              After.Exp,
              After.Win,
              After.Draw,
              After.Lose,
              Before.ID,
              Before.Money,
              Before.Exp,
              Before.Win,
              Before.Draw,
              Before.Lose,
            );
            if (result.changes !== 1) throw conflict;
          }
          return true;
        })
        .immediate();
    } catch (error) {
      if (error === conflict) return false;
      throw error;
    }
  }
  GetUserItemList(): UserItem[] {
    return this.session.db
      .query<UserItem, []>(
        "SELECT SN,Category,strAttr,nAttr1,nAttr2,nAttr3,strName FROM FxItem ORDER BY SN",
      )
      .all()
      .map((row) => ({ ...CopyUserItem(row, this.text) }));
  }
  SetOption(name: string, value: string): void {
    this.session.db
      .query(
        "INSERT INTO FxUserOptions VALUES (?,?) ON CONFLICT(Name) DO UPDATE SET Value = excluded.Value",
      )
      .run(name, value);
  }
  GetOption(name: string): string | undefined {
    return this.session.db
      .query<
        { Value: string },
        [string]
      >("SELECT Value FROM FxUserOptions WHERE Name = ?")
      .get(name)?.Value;
  }
  Audit(action: string, sid: number | null, details: string): void {
    this.session.db
      .query("INSERT INTO RuntimeAudit(Action,SID,Details) VALUES (?,?,?)")
      .run(action, sid, details);
  }
  private positive(n: number): void {
    this.u31(n);
    if (!n) throw new CProtocolError("Positive amount required");
  }
  protected u31(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0 || n > IntegerRange.Int32Maximum)
      throw new CProtocolError("Integer outside signed DB range");
  }
  protected u32(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0 || n > IntegerRange.UInt32Maximum)
      throw new CProtocolError("Integer outside u32 range");
  }
}
