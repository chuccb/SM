/** A23: native first-byte shard selection and safe migration of old port rows. */
import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { BillingStore } from "../src/LocalBilling/Store.ts";
import {
  CDBMan,
  EncodePassword,
  GetLegacyPortUserHashNo,
  GetUserHashNo,
} from "../src/db/DBMan.ts";
import { inspectUserShardLayout, migrateUserShards } from "../src/db/UserShardMigration.ts";

function withDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "user-shards-"));
  try { run(directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

function initialize(directory: string, billing = true): void {
  const db = new CDBMan(directory);
  try { if (billing) new BillingStore(db); }
  finally { db.Close(); }
}

function openShard(directory: string, family: "UserInfo" | "UserInventory", shard: number): Database {
  return new Database(join(directory, `${family}${String(shard).padStart(2, "0")}.db`), {
    readwrite: true,
    create: false,
  });
}

function insertMisplacedFixture(directory: string, id = "\xc0migrate"): { source: number; target: number } {
  const source = GetLegacyPortUserHashNo(id);
  const target = GetUserHashNo(id);
  expect(source).not.toBe(target);
  const info = openShard(directory, "UserInfo", source);
  const inventory = openShard(directory, "UserInventory", source);
  const guild = new Database(join(directory, "Guild.db"), { readwrite: true, create: false });
  try {
    info.query("INSERT INTO FxUserAccount(ID,SN,SID,Name,Password,Email,GuildSn) VALUES(?,?,?,?,?,?,?)")
      .run(id, 42, 42, id, EncodePassword("pw"), "old@example.test", 77);
    info.query("INSERT INTO FxUserDynamic(ID,Money,Exp,Win,Draw,Lose,TicketDate) VALUES(?,?,?,?,?,?,?)")
      .run(id, 700, 8, 3, 2, 1, "2099-01-02T03:04:05.000Z");
    info.query("INSERT INTO TxUserDynamic(ID,Exp) VALUES(?,?)").run(id, 9);
    inventory.query(`INSERT INTO FxUserInventory
      (UserSN,UserID,ItemSN,StockSN,Slot,Amount,DateCreated,LevelCreated,Verbose)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(42, id, 101, 201, 7, 3, "2099-02-03T04:05:06.000Z", 2000, "owned");
    inventory.query(`INSERT INTO FxPreInventory
      (SN,UserID,Type,ItemSN,StockSN,Slot,Amount,ValidityPeriod,ValidityLevel,strAttr,Description)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(77, id, 4, 102, 202, 8, 5, 30, 6, "attr", "pending");
    inventory.query("INSERT INTO FxCart(UserID,StockSNList) VALUES(?,?)").run(id, "201,202");
    inventory.query("INSERT INTO LocalBillingWallet(Account,SID,BID,Balance) VALUES(?,?,?,?)")
      .run(id, 42, 90, 1000);
    inventory.query("INSERT INTO LocalBillingAuthorization(Account,World,Expires) VALUES(?,?,?)")
      .run(id, 1, 4_000_000_000_000);
    inventory.query(`INSERT INTO LocalBillingReservation
      (Reference,Account,World,Serial,Stock,Price,State,Expires,Grants,Error)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run("ref-migrated", id, 1, 5, 201, 10, "committed", 4_000_000_000_000, "[]", "");
    inventory.query(`INSERT INTO LocalBillingLedger
      (Account,Reference,Delta,Balance,Kind,Created) VALUES(?,?,?,?,?,?)`)
      .run(id, "purchase:ref-migrated", -10, 990, "purchase", "2026-09-21 00:00:00");
    guild.query("INSERT INTO FxGuildAccount(sn,Name,MasterID) VALUES(77,'raw-byte-guild',?)").run(id);
    guild.query("INSERT INTO FxGuildMember(sn,ID,RegDate) VALUES(77,?,'2026-09-21')").run(id);
  } finally {
    guild.close();
    inventory.close();
    info.close();
  }
  return { source, target };
}

function count(directory: string, family: "UserInfo" | "UserInventory", shard: number, table: string, owner: string, id: string): number {
  const db = openShard(directory, family, shard);
  try {
    return (db.query<{ total: number }, [string]>(`SELECT COUNT(*) AS total FROM "${table}" WHERE "${owner}"=?`).get(id)!).total;
  } finally { db.close(); }
}

function copyAccountRows(directory: string, id: string, source: number, target: number): void {
  const from = openShard(directory, "UserInfo", source);
  const to = openShard(directory, "UserInfo", target);
  try {
    for (const table of ["FxUserAccount", "FxUserDynamic", "TxUserDynamic"] as const) {
      const row = from.query<Record<string, string | number | null>, [string]>(`SELECT * FROM ${table} WHERE ID=?`).get(id)!;
      const columns = Object.keys(row);
      to.query(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
        .run(...Object.values(row));
    }
  } finally {
    to.close();
    from.close();
  }
}

function peCode(executable: "LS/CxLogin.exe" | "FXGS/FxServer.exe" | "FXSS/FxShop.exe", va: number, length: number): Buffer {
  const pe = readFileSync(join(import.meta.dir, "..", "..", executable));
  const nt = pe.readUInt32LE(0x3c);
  const optional = nt + 24;
  const rva = va - pe.readUInt32LE(optional + 28);
  const sections = optional + pe.readUInt16LE(nt + 20);
  for (let index = 0; index < pe.readUInt16LE(nt + 6); index++) {
    const section = sections + index * 40;
    const start = pe.readUInt32LE(section + 12);
    const rawSize = pe.readUInt32LE(section + 16);
    if (rva < start || rva + length > start + rawSize) continue;
    const offset = pe.readUInt32LE(section + 20) + rva - start;
    return pe.subarray(offset, offset + length);
  }
  throw new Error(`No raw PE section for VA ${va.toString(16)}`);
}

describe("CDBMan::GetUserHashNo", () => {
  test("all three shipped binaries pin unsigned-byte, ASCII-only folding and divisor six", () => {
    const common = "8b4424048b080fb60183f8417c0883f85a7f0383c02099b906000000f7f98bc2c20400";
    expect(peCode("LS/CxLogin.exe", 0x40a280, 35).toString("hex")).toBe(common);
    expect(peCode("FXSS/FxShop.exe", 0x4081b0, 35).toString("hex")).toBe(common);
    expect(peCode("FXGS/FxServer.exe", 0x408e41, 33).toString("hex")).toBe(
      "8b4424048b000fb60083f8417c0883f85a7f0383c020996a0659f7f98bc2c20400",
    );
  });

  test("every non-NUL raw first byte follows the native formula", () => {
    for (let byte = 1; byte <= 0xff; byte++) {
      const folded = byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
      expect(GetUserHashNo(String.fromCharCode(byte) + "account")).toBe(folded % 6);
    }
    expect(GetUserHashNo("Alpha")).toBe(GetUserHashNo("alpha"));
    expect(GetUserHashNo("\xc0\xa1big5")).toBe(0);
    expect(GetLegacyPortUserHashNo("\xc0\xa1big5")).toBe(2);
    expect(GetUserHashNo("")).toBe(0); // explicit safe port boundary, not a native account fixture
  });

  test("the old Unicode selector differs only on the 30 raw Latin-1 uppercase bytes", () => {
    const differing = Array.from({ length: 0xff }, (_, index) => index + 1)
      .filter(byte => {
        const id = String.fromCharCode(byte) + "id";
        return GetLegacyPortUserHashNo(id) !== GetUserHashNo(id);
      });
    expect(differing).toEqual([
      ...Array.from({ length: 0xd6 - 0xc0 + 1 }, (_, index) => 0xc0 + index),
      ...Array.from({ length: 0xde - 0xd8 + 1 }, (_, index) => 0xd8 + index),
    ]);
  });

  test("registration, account reads, inventory and local billing share the native shard", () => withDirectory(directory => {
    const id = "\xc0\xa1new-user"; // raw two-byte Big5 carrier, not Unicode U+ text
    const target = GetUserHashNo(id);
    const legacy = GetLegacyPortUserHashNo(id);
    const db = new CDBMan(directory);
    try {
      const store = new BillingStore(db);
      expect(db.prCAAuthUser(id, EncodePassword("password123")).retval).toBe(0); // required auto-registration
      expect(db.prGetUserAccount(id)).toBeDefined();
      expect(db.prAddInventoryShop(id, 101, 201, 2, 30, 2000, true)).toBe(1);
      expect(store.credit(id, 50, "a23-credit")).toBe(900_050);
      expect(db.userInfo[target]!.query("SELECT ID FROM FxUserAccount WHERE ID=?").get(id)).toBeDefined();
      expect(db.inventory[target]!.query("SELECT UserID FROM FxUserInventory WHERE UserID=?").get(id)).toBeDefined();
      expect(db.inventory[target]!.query("SELECT Account FROM LocalBillingWallet WHERE Account=?").get(id)).toBeDefined();
      expect(db.userInfo[legacy]!.query("SELECT ID FROM FxUserAccount WHERE ID=?").get(id)).toBeNull();
      expect(db.inventory[legacy]!.query("SELECT UserID FROM FxUserInventory WHERE UserID=?").get(id)).toBeNull();
    } finally { db.Close(); }
  }));

  test("login never hides an old-shard account behind a blank auto-registration", () => withDirectory(directory => {
    const id = "\xc0legacy-login";
    const native = GetUserHashNo(id);
    const legacy = GetLegacyPortUserHashNo(id);
    const db = new CDBMan(directory);
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      db.userInfo[legacy]!.query("INSERT INTO FxUserAccount(ID,SN,SID,Name,Password) VALUES(?,?,?,?,?)")
        .run(id, 10, 10, id, EncodePassword("password123"));
      expect(db.prConfirmUnregisteredId(id)).toBe(1);
      expect(db.prCreateUser(id, id, EncodePassword("password123"), "", 0, 0, "", "", 0, "", "", "", "", "")).toBe(-1);
      expect(db.prCAAuthUser(id, EncodePassword("password123")).retval).toBe(-1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("pre-A23 shard formula"));
      expect(db.userInfo[legacy]!.query("SELECT ID FROM FxUserAccount WHERE ID=?").get(id)).toBeDefined();
      expect(db.userInfo[native]!.query("SELECT ID FROM FxUserAccount WHERE ID=?").get(id)).toBeNull();
    } finally {
      error.mockRestore();
      db.Close();
    }
  }));
});

describe("offline user shard migration", () => {
  test("moves account, orphan companions, inventory, cart and all local-billing rows after a verified backup", () => withDirectory(directory => {
    initialize(directory);
    const id = "\xc0migrate";
    const { source, target } = insertMisplacedFixture(directory, id);
    const before = inspectUserShardLayout(directory);
    expect(before.status).toBe("ready");
    expect(before.misplacedAccounts).toBe(1); // deduplicated across both DB families
    expect(before.legacyFormulaAccounts).toBe(1);
    expect(before.misplacedRows).toBe(10);
    expect(before.destinationCopies).toBe(10);
    expect(before.sourceDeletes).toBe(10);

    const backup = join(directory, "a23-backup");
    const migrated = migrateUserShards(directory, backup);
    expect(migrated.status).toBe("migrated");
    expect(migrated.verifiedClean).toBeTrue();
    expect(migrated.backupDirectory).toBe(backup);
    expect(existsSync(join(backup, "manifest.json"))).toBeTrue();
    expect(JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8")).files).toHaveLength(12);
    expect(inspectUserShardLayout(directory).status).toBe("clean");
    expect(count(directory, "UserInfo", source, "FxUserAccount", "ID", id)).toBe(0);
    expect(count(directory, "UserInfo", target, "FxUserAccount", "ID", id)).toBe(1);
    expect(count(directory, "UserInventory", source, "LocalBillingLedger", "Account", id)).toBe(0);
    expect(count(directory, "UserInventory", target, "LocalBillingLedger", "Account", id)).toBe(1);

    const old = new Database(join(backup, `UserInfo${String(source).padStart(2, "0")}.db`), { readonly: true });
    try { expect(old.query("SELECT ID FROM FxUserAccount WHERE ID=?").get(id)).toBeDefined(); }
    finally { old.close(); }

    const reopened = new CDBMan(directory);
    try {
      const store = new BillingStore(reopened);
      const authenticated = reopened.prCAAuthUser(id, EncodePassword("pw"));
      expect(authenticated.retval).toBe(10); // migrated future premium ticket
      expect(authenticated.GuildSn).toBe(77);
      expect(reopened.prGetGuildMember(77)).toEqual([{ ID: id, RegDate: "2026-09-21" }]);
      expect(reopened.inventory[target]!.query(
        "SELECT ItemSN,StockSN,Amount,Verbose FROM FxUserInventory WHERE UserID=?",
      ).all(id)).toEqual([{ ItemSN: 101, StockSN: 201, Amount: 3, Verbose: "owned" }]);
      expect(reopened.prIsValidPreInventory(id, 102)).toBe(5);
      expect(store.inspect(id)).toEqual(expect.objectContaining({ balance: 1000 }));
    } finally { reopened.Close(); }
  }));

  test("moves incomplete user-info and inventory families independently", () => withDirectory(directory => {
    initialize(directory, false);
    const dynamicID = "\xc0dynamic-only";
    const inventoryID = "\xd8inventory-only";
    const dynamicSource = GetLegacyPortUserHashNo(dynamicID);
    const inventorySource = GetLegacyPortUserHashNo(inventoryID);
    const dynamic = openShard(directory, "UserInfo", dynamicSource);
    const inventory = openShard(directory, "UserInventory", inventorySource);
    try {
      dynamic.query("INSERT INTO FxUserDynamic(ID,Money) VALUES(?,?)").run(dynamicID, 91);
      inventory.query("INSERT INTO FxCart(UserID,StockSNList) VALUES(?,?)").run(inventoryID, "7,8");
    } finally { inventory.close(); dynamic.close(); }
    const report = migrateUserShards(directory, join(directory, "split-backup"));
    expect(report.status).toBe("migrated");
    expect(report.misplacedAccounts).toBe(2);
    expect(count(directory, "UserInfo", GetUserHashNo(dynamicID), "FxUserDynamic", "ID", dynamicID)).toBe(1);
    expect(count(directory, "UserInventory", GetUserHashNo(inventoryID), "FxCart", "UserID", inventoryID)).toBe(1);
  }));

  test("preflights every conflict and writes neither source, target nor backup", () => withDirectory(directory => {
    initialize(directory, false);
    const id = "\xc0conflict";
    const source = GetLegacyPortUserHashNo(id);
    const target = GetUserHashNo(id);
    const old = openShard(directory, "UserInfo", source);
    const current = openShard(directory, "UserInfo", target);
    try {
      old.query("INSERT INTO FxUserAccount(ID,SN,SID,Name,Email) VALUES(?,?,?,?,?)")
        .run(id, 42, 42, id, "source@example.test");
      current.query("INSERT INTO FxUserAccount(ID,SN,SID,Name,Email) VALUES(?,?,?,?,?)")
        .run(id, 43, 43, id, "target@example.test");
    } finally { current.close(); old.close(); }
    const backup = join(directory, "must-not-exist");
    const report = migrateUserShards(directory, backup);
    expect(report.status).toBe("conflict");
    expect(report.conflicts.some(conflict => conflict.table === "FxUserAccount")).toBeTrue();
    expect(existsSync(backup)).toBeFalse();
    expect(count(directory, "UserInfo", source, "FxUserAccount", "ID", id)).toBe(1);
    expect(count(directory, "UserInfo", target, "FxUserAccount", "ID", id)).toBe(1);
  }));

  test("detects shard-local serial and pre-inventory key collisions before any move", () => withDirectory(directory => {
    initialize(directory, false);
    const id = "\xc0unique-conflict";
    const source = GetLegacyPortUserHashNo(id);
    const target = GetUserHashNo(id);
    const sourceInfo = openShard(directory, "UserInfo", source);
    const targetInfo = openShard(directory, "UserInfo", target);
    const sourceInventory = openShard(directory, "UserInventory", source);
    const targetInventory = openShard(directory, "UserInventory", target);
    try {
      sourceInfo.query("INSERT INTO FxUserAccount(ID,SN,SID,Name) VALUES(?,?,?,?)").run(id, 60, 60, id);
      targetInfo.query("INSERT INTO FxUserAccount(ID,SN,SID,Name) VALUES('foreign',60,60,'foreign')").run();
      sourceInventory.query("INSERT INTO FxPreInventory(SN,UserID,ItemSN) VALUES(77,?,1)").run(id);
      targetInventory.query("INSERT INTO FxPreInventory(SN,UserID,ItemSN) VALUES(77,'foreign',2)").run();
    } finally {
      targetInventory.close();
      sourceInventory.close();
      targetInfo.close();
      sourceInfo.close();
    }
    const backup = join(directory, "collision-backup");
    const report = migrateUserShards(directory, backup);
    expect(report.status).toBe("conflict");
    expect(report.conflicts.some(conflict => conflict.table === "FxUserAccount" && conflict.reason.includes("SN"))).toBeTrue();
    expect(report.conflicts.some(conflict => conflict.table === "FxPreInventory" && conflict.reason.includes("primary-key"))).toBeTrue();
    expect(existsSync(backup)).toBeFalse();
    expect(count(directory, "UserInfo", source, "FxUserAccount", "ID", id)).toBe(1);
    expect(count(directory, "UserInventory", source, "FxPreInventory", "UserID", id)).toBe(1);
  }));

  test("an exact copy left by interruption is resumed by source-only cleanup", () => withDirectory(directory => {
    initialize(directory, false);
    const id = "\xc0resume";
    const { source, target } = insertMisplacedFixtureWithBaseTables(directory, id);
    copyAccountRows(directory, id, source, target);
    const before = inspectUserShardLayout(directory);
    expect(before.status).toBe("ready");
    expect(before.destinationCopies).toBe(0);
    expect(before.sourceDeletes).toBe(3);
    const report = migrateUserShards(directory, join(directory, "resume-backup"));
    expect(report.status).toBe("migrated");
    expect(count(directory, "UserInfo", source, "FxUserAccount", "ID", id)).toBe(0);
    expect(count(directory, "UserInfo", target, "FxUserAccount", "ID", id)).toBe(1);
  }));

  test("a clean second run is idempotent and does not create an unnecessary backup", () => withDirectory(directory => {
    initialize(directory, false);
    const backup = join(directory, "unused-backup");
    const report = migrateUserShards(directory, backup);
    expect(report.status).toBe("clean");
    expect(report.verifiedClean).toBeTrue();
    expect(existsSync(backup)).toBeFalse();
  }));
});

function insertMisplacedFixtureWithBaseTables(directory: string, id: string): { source: number; target: number } {
  const source = GetLegacyPortUserHashNo(id);
  const target = GetUserHashNo(id);
  const db = openShard(directory, "UserInfo", source);
  try {
    db.query("INSERT INTO FxUserAccount(ID,SN,SID,Name,Password) VALUES(?,?,?,?,?)")
      .run(id, 51, 51, id, EncodePassword("pw"));
    db.query("INSERT INTO FxUserDynamic(ID,Money) VALUES(?,?)").run(id, 17);
    db.query("INSERT INTO TxUserDynamic(ID,Exp) VALUES(?,?)").run(id, 19);
  } finally { db.close(); }
  return { source, target };
}
