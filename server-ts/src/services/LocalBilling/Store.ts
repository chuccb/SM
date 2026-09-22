/** Port-only SQLite store for the local billing replacement. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  type CDBMan,
  EncodePassword,
  GetUserHashNo,
  USER_DB_BUSY_TIMEOUT_MS,
} from "../../db/DBMan.ts";
import { AddLocalCalendarDays } from "../../core/LocalTime.ts";
import { SHOP_PERMANENT_VALIDITY_DAYS, SHOP_PERMANENT_EXPIRY_LEVEL } from "../../FXSS/Defs.ts";
import { CDynInfoCalculator_GetLevel } from "../../common/LevelTable.ts";
import { AUTHORIZATION_MS, BILLING_ERROR, BillingError, MAX_CASH, MAX_LOCAL_INVENTORY_ROWS, RESERVATION_MS, type PurchaseRequest } from "./Defs.ts";

interface Account { ID: string; SN: number; Password: string }
interface Wallet { Account: string; SID: number; BID: number; Balance: number }
interface Stock {
  SN: number; Category: number; ItemSN: number; Unit: number; Price: number;
  MoneyType: number; IsValid: number; LimitLevel: number; LimitEx: number; ValidityPeriod: number; ValidityLevel: number;
}
interface LedgerEntry { Reference: string; Delta: number; Balance: number; Kind: "credit" | "purchase"; Created: string }
interface Grant { item: number; stock: number; units: number; category: number; limit: number }
export interface Reservation {
  Reference: string; Account: string; World: number; Serial: number; Stock: number;
  Price: number; State: "held" | "committed" | "cancelled"; Expires: number; Grants: string; Error: string;
}
const SCHEMA = `
CREATE TABLE IF NOT EXISTS LocalBillingWallet (
 Account TEXT PRIMARY KEY, SID INTEGER NOT NULL, BID INTEGER NOT NULL,
 Balance INTEGER NOT NULL DEFAULT 0 CHECK(Balance BETWEEN 0 AND ${MAX_CASH}));
CREATE TABLE IF NOT EXISTS LocalBillingAuthorization (
 Account TEXT NOT NULL, World INTEGER NOT NULL, Expires INTEGER NOT NULL,
 PRIMARY KEY(Account,World));
CREATE TABLE IF NOT EXISTS LocalBillingReservation (
 Reference TEXT PRIMARY KEY, Account TEXT NOT NULL, World INTEGER NOT NULL, Serial INTEGER NOT NULL,
 Stock INTEGER NOT NULL, Price INTEGER NOT NULL CHECK(Price BETWEEN 0 AND ${MAX_CASH}),
 State TEXT NOT NULL CHECK(State IN ('held','committed','cancelled')),
 Expires INTEGER NOT NULL, Grants TEXT NOT NULL, Error TEXT NOT NULL DEFAULT '');
CREATE UNIQUE INDEX IF NOT EXISTS LocalBillingOneHold ON LocalBillingReservation(Account) WHERE State='held';
CREATE TABLE IF NOT EXISTS LocalBillingLedger (
 Account TEXT NOT NULL, Reference TEXT NOT NULL, Delta INTEGER NOT NULL, Balance INTEGER NOT NULL,
 Kind TEXT NOT NULL, Created TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(Account,Reference));
`;

/** Wallet, holds, ledger AND granted inventory share ONE existing inventory
 * shard. SQLite WAL transactions are atomic within that file; no cross-file
 * transaction claims, no game-Money writes, no plaintext billing password DB.
 */
export class BillingStore {
  constructor(readonly db: CDBMan, readonly now: () => number = Date.now) {
    for (const shard of db.inventory) {
      shard.exec(`PRAGMA busy_timeout=${USER_DB_BUSY_TIMEOUT_MS}; PRAGMA synchronous=FULL;`);
      shard.exec(SCHEMA);
    }
  }
  private shard(name: string): Database { return this.db.inventory[GetUserHashNo(name)]; }
  private account(name: string): Account {
    if (!name || name.length > 32 || name.includes("\0")) throw new BillingError(BILLING_ERROR.authorization);
    const row = this.db.prGetUserAccount(name) as Account | null;
    if (!row || !Number.isInteger(row.SN) || row.SN <= 0 || row.SN > 0xffffffff) throw new BillingError(BILLING_ERROR.authorization);
    return row;
  }
  private wallet(name: string): Wallet {
    const row = this.shard(name).query<Wallet, [string]>("SELECT * FROM LocalBillingWallet WHERE Account=?").get(name);
    if (!row) throw new BillingError(BILLING_ERROR.authorization);
    return row;
  }
  private ensureWallet(name: string): Wallet {
    const account = this.account(name);
    const bid = randomBytes(4).readUInt32BE() & MAX_CASH;
    this.shard(name).query("INSERT OR IGNORE INTO LocalBillingWallet(Account,SID,BID) VALUES(?,?,?)")
      .run(name, account.SN, bid || 1);
    const wallet = this.wallet(name);
    if (wallet.SID !== account.SN) throw new BillingError("Account identity changed; operator review required.");
    return wallet;
  }
  authorize(account: string, password: string, character: string, world: number): Wallet {
    // Local policy: an account cannot authorize a different character.
    if (account !== character) throw new BillingError(BILLING_ERROR.authorization);
    const row = this.account(account);
    const expected = Buffer.from(row.Password, "latin1");
    const supplied = Buffer.from(EncodePassword(password), "latin1");
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new BillingError(BILLING_ERROR.authorization);
    return this.shard(account).transaction(() => {
      const wallet = this.ensureWallet(account);
      this.shard(account).query(`INSERT INTO LocalBillingAuthorization VALUES(?,?,?)
        ON CONFLICT(Account,World) DO UPDATE SET Expires=excluded.Expires`).run(account, world, this.now() + AUTHORIZATION_MS);
      return wallet;
    }).immediate();
  }
  private requireAuthorization(name: string, world: number): void {
    if (this.wallet(name).SID !== this.account(name).SN) throw new BillingError(BILLING_ERROR.authorization);
    const row = this.shard(name).query<{ Expires: number }, [string, number]>(
      "SELECT Expires FROM LocalBillingAuthorization WHERE Account=? AND World=?").get(name, world);
    if (!row || row.Expires <= this.now()) throw new BillingError(BILLING_ERROR.authorization);
  }
  private expire(db: Database): void {
    db.query("UPDATE LocalBillingReservation SET State='cancelled', Error=? WHERE State='held' AND Expires<=?")
      .run(BILLING_ERROR.expired, this.now());
  }
  private available(name: string): number {
    const held = this.shard(name).query<{ Total: number }, [string, number]>(
      "SELECT COALESCE(SUM(Price),0) AS Total FROM LocalBillingReservation WHERE Account=? AND State='held' AND Expires>?").get(name, this.now())!;
    return this.wallet(name).Balance - held.Total;
  }
  balance(name: string, world: number): number {
    this.requireAuthorization(name, world);
    return this.available(name);
  }
  /** Operator credits require a caller-provided idempotency key. No network
   * opcode credits funds, and retries with a changed amount are rejected. */
  credit(name: string, amount: number, reference: string): number {
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_CASH || !/^[\w.:-]{1,80}$/.test(reference))
      throw new BillingError("Use a positive integer amount and a stable reference (1..80 ASCII characters).");
    const db = this.shard(name);
    return db.transaction(() => {
      const wallet = this.ensureWallet(name);
      const existing = db.query<{ Delta: number; Balance: number; Kind: string }, [string, string]>(
        "SELECT Delta,Balance,Kind FROM LocalBillingLedger WHERE Account=? AND Reference=?").get(name, `credit:${reference}`);
      if (existing) {
        if (existing.Kind !== "credit" || existing.Delta !== amount) throw new BillingError("Reference already used with another amount.");
        return existing.Balance;
      }
      const balance = wallet.Balance + amount;
      if (balance > MAX_CASH) throw new BillingError("Balance would overflow.");
      db.query("UPDATE LocalBillingWallet SET Balance=? WHERE Account=?").run(balance, name);
      db.query("INSERT INTO LocalBillingLedger(Account,Reference,Delta,Balance,Kind) VALUES(?,?,?,?, 'credit')")
        .run(name, `credit:${reference}`, amount, balance);
      return balance;
    }).immediate();
  }
  inspect(name: string): { balance: number; available: number; ledger: LedgerEntry[] } {
    this.account(name);
    const row = this.shard(name).query<Wallet, [string]>("SELECT * FROM LocalBillingWallet WHERE Account=?").get(name);
    return {
      balance: row?.Balance ?? 0,
      available: row ? this.available(name) : 0,
      ledger: this.shard(name).query<LedgerEntry, [string]>("SELECT Reference,Delta,Balance,Kind,Created FROM LocalBillingLedger WHERE Account=? ORDER BY rowid DESC LIMIT 20").all(name),
    };
  }
  private stock(sn: number): Stock {
    const row = this.db.item.query<Stock, [number]>("SELECT * FROM FxStock WHERE SN=? AND IsValid=1").get(sn);
    if (!row) throw new BillingError(BILLING_ERROR.product);
    return row;
  }
  private grants(stock: Stock, name: string): Grant[] {
    // Premium tickets live in UserInfo, not this atomic settlement shard.
    // Reject rather than claim cross-WAL atomicity or charge without delivery.
    if (stock.Category === 9 || stock.LimitEx !== 0 || stock.ValidityPeriod !== 0 || stock.ValidityLevel !== 0)
      throw new BillingError(BILLING_ERROR.product);
    const rows = stock.Category === 11
      ? this.db.item.query<{ StockSN: number; Units: number }, [number]>("SELECT StockSN,Units FROM FxPackageMap WHERE PackageSN=? ORDER BY StockSN").all(stock.SN)
      : [{ StockSN: stock.SN, Units: 1 }];
    if (!rows.length || rows.length > 128) throw new BillingError(BILLING_ERROR.product);
    const level = CDynInfoCalculator_GetLevel((this.db.prGetUserDynamic(name) as { Exp: number } | null)?.Exp ?? 0);
    if (level < stock.LimitLevel) throw new BillingError(BILLING_ERROR.product);
    const grants: Grant[] = [];
    for (const row of rows) {
      const sub = this.stock(row.StockSN);
      if (level < sub.LimitLevel || sub.LimitEx !== 0 || sub.Category === 9 || (sub.Category === 11 && stock.Category === 11) || sub.ValidityPeriod !== 0 || sub.ValidityLevel !== 0)
        throw new BillingError(BILLING_ERROR.product);
      const item = this.db.item.query<{ nAttr1: number; Category: number }, [number]>("SELECT nAttr1,Category FROM FxItem WHERE SN=?").get(sub.ItemSN);
      const units = row.Units * sub.Unit;
      if (!item || [9, 100, 101].includes(item.Category) || !Number.isSafeInteger(units) || units <= 0 || units > MAX_CASH) throw new BillingError(BILLING_ERROR.product);
      if (grants.some(g => g.item === sub.ItemSN)) throw new BillingError(BILLING_ERROR.product);
      grants.push({ item: sub.ItemSN, stock: sub.SN, units, category: sub.Category, limit: item.nAttr1 });
    }
    return grants;
  }
  private checkInventory(name: string, grants: Grant[]): void {
    const db = this.shard(name);
    const level = CDynInfoCalculator_GetLevel((this.db.prGetUserDynamic(name) as { Exp: number } | null)?.Exp ?? 0);
    let rows = db.query<{ Total: number }, [string]>("SELECT COUNT(*) AS Total FROM FxUserInventory WHERE UserID=?").get(name)!.Total;
    if (level >= SHOP_PERMANENT_EXPIRY_LEVEL || rows > MAX_LOCAL_INVENTORY_ROWS) throw new BillingError(BILLING_ERROR.product);
    for (const grant of grants) {
      const existing = db.query<{ Amount: number; DateCreated: string | null; LevelCreated: number; StockSN: number }, [string, number]>(
        "SELECT Amount,DateCreated,LevelCreated,StockSN FROM FxUserInventory WHERE UserID=? AND ItemSN=?").get(name, grant.item);
      const owned = existing?.Amount ?? 0;
      if (!existing && ++rows > MAX_LOCAL_INVENTORY_ROWS) throw new BillingError(BILLING_ERROR.product);
      if (existing) {
        // Never sell permanent units into an expired/timed stack that GS will
        // delete. Do not silently extend or overwrite old entitlement metadata.
        const previousStock = this.stock(existing.StockSN);
        if (previousStock.ValidityPeriod !== 0 || previousStock.ValidityLevel !== 0 ||
            existing.LevelCreated !== SHOP_PERMANENT_EXPIRY_LEVEL ||
            !existing.DateCreated || !(Date.parse(existing.DateCreated) > this.now()))
          throw new BillingError(BILLING_ERROR.product);
      }
      const pre = db.query<{ Amount: number }, [string, number]>(
        "SELECT COALESCE(SUM(Amount),0) AS Amount FROM FxPreInventory WHERE UserID=? AND ItemSN=?").get(name, grant.item)!.Amount;
      if (owned < 0 || owned + grant.units > MAX_CASH ||
          (grant.category === 13 && owned + pre + grant.units > grant.limit) ||
          (![1, 13, 15].includes(grant.category) && owned + pre !== 0)) throw new BillingError(BILLING_ERROR.product);
    }
  }
  reserve(request: PurchaseRequest): Reservation {
    const { name, world, serial, stock: sn, price } = request;
    this.requireAuthorization(name, world);
    const stock = this.stock(sn);
    if (stock.MoneyType !== 0 || !Number.isSafeInteger(price) || price < 0 || price > MAX_CASH || price !== stock.Price)
      throw new BillingError(BILLING_ERROR.product);
    const grants = this.grants(stock, name);
    const db = this.shard(name);
    return db.transaction(() => {
      this.expire(db);
      const existing = db.query<Reservation, [string]>("SELECT * FROM LocalBillingReservation WHERE Account=? AND State='held'").get(name);
      if (existing) {
        if (existing.World !== world || existing.Serial !== serial || existing.Stock !== sn || existing.Price !== price)
          throw new BillingError(BILLING_ERROR.pending);
        return existing; // retry of the same in-flight native request
      }
      if (this.available(name) < price) throw new BillingError(BILLING_ERROR.funds);
      this.checkInventory(name, grants);
      const reference = randomBytes(16).toString("hex"); // fits native's 32-byte response scratch buffer
      db.query(`INSERT INTO LocalBillingReservation(Reference,Account,World,Serial,Stock,Price,State,Expires,Grants)
        VALUES(?,?,?,?,?,?,'held',?,?)`).run(reference, name, world, serial, sn, price, this.now() + RESERVATION_MS, JSON.stringify(grants));
      return db.query<Reservation, [string]>("SELECT * FROM LocalBillingReservation WHERE Reference=?").get(reference)!;
    }).immediate();
  }
  confirm(reference: string, world: number, serial: number, stock: number, result: number): Reservation {
    if (!/^[a-f0-9]{32}$/.test(reference)) throw new BillingError(BILLING_ERROR.expired);
    for (const db of this.db.inventory) {
      const row = db.query<Reservation, [string]>("SELECT * FROM LocalBillingReservation WHERE Reference=?").get(reference);
      if (!row) continue;
      if (row.World !== world || row.Serial !== serial || (stock !== row.Stock && !(result === 2 && stock === 0xffffffff)))
        throw new BillingError(BILLING_ERROR.expired);
      try {
        return db.transaction(() => {
          this.expire(db);
          const current = db.query<Reservation, [string]>("SELECT * FROM LocalBillingReservation WHERE Reference=?").get(reference)!;
          if (current.State !== "held") return current; // durable, replay-safe terminal result
          if (result !== 0) {
            db.query("UPDATE LocalBillingReservation SET State='cancelled',Error=? WHERE Reference=?").run(BILLING_ERROR.expired, reference);
          } else {
            const grants = JSON.parse(current.Grants) as Grant[];
            this.checkInventory(current.Account, grants);
            const account = this.account(current.Account);
            if (this.wallet(current.Account).SID !== account.SN) throw new BillingError(BILLING_ERROR.authorization);
            const expiry = AddLocalCalendarDays(this.now(), SHOP_PERMANENT_VALIDITY_DAYS).toISOString();
            const debit = db.query("UPDATE LocalBillingWallet SET Balance=Balance-? WHERE Account=? AND Balance>=?")
              .run(current.Price, current.Account, current.Price);
            if (debit.changes !== 1) throw new BillingError(BILLING_ERROR.funds);
            for (const grant of grants) db.query(`INSERT INTO FxUserInventory(UserSN,UserID,ItemSN,StockSN,Slot,Amount,DateCreated,LevelCreated,Verbose)
              VALUES(?,?,?,?,255,?,?,?,'') ON CONFLICT(UserID,ItemSN) DO UPDATE SET Amount=Amount+excluded.Amount`)
              .run(account.SN, current.Account, grant.item, grant.stock, grant.units, expiry, SHOP_PERMANENT_EXPIRY_LEVEL);
            const balance = this.wallet(current.Account).Balance;
            db.query("INSERT INTO LocalBillingLedger(Account,Reference,Delta,Balance,Kind) VALUES(?,?,?,?, 'purchase')")
              .run(current.Account, `purchase:${reference}`, -current.Price, balance);
            db.query("UPDATE LocalBillingReservation SET State='committed' WHERE Reference=?").run(reference);
          }
          return db.query<Reservation, [string]>("SELECT * FROM LocalBillingReservation WHERE Reference=?").get(reference)!;
        }).immediate();
      } catch (error) {
        // The settlement transaction rolled back, including EVERY granted row.
        // Terminal failure is recorded separately; if storage is still down,
        // this throws and the peer closes so the same reference can be retried.
        db.query("UPDATE LocalBillingReservation SET State='cancelled',Error=? WHERE Reference=? AND State='held'")
          .run(error instanceof BillingError ? error.message : BILLING_ERROR.unavailable, reference);
        return db.query<Reservation, [string]>("SELECT * FROM LocalBillingReservation WHERE Reference=?").get(reference)!;
      }
    }
    throw new BillingError(BILLING_ERROR.expired);
  }
}
