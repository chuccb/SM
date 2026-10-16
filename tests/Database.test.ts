import { afterEach, expect, test } from "bun:test";
import { CDBSession } from "../Common/DB/CDBSession.ts";
import { CDBMan } from "../LS/CDBMan.ts";
import { EncodePassword } from "../Common/EncodePassword.ts";
const sessions: CDBSession[] = [];
function open() {
  const session = new CDBSession(":memory:");
  sessions.push(session);
  return new CDBMan(session);
}
afterEach(() => {
  for (const s of sessions.splice(0)) s.Close();
});
test("migrations, Argon2id auth, NOCASE IDs, exact official first-byte shard algorithm", async () => {
  const db = open();
  const alice = await db.RegisterNewUser({ ID: "Alice", Password: "pass123" });
  expect(alice.UserHashNo).toBe(97 % 6);
  expect(db.GetUserHashNo("ALICE")).toBe(db.GetUserHashNo("Alice"));
  expect((await db.InitUser("alice", "pass123"))?.TotalConn).toBe(1);
  expect(await db.InitUser("alice", "wrong")).toBeUndefined();
  expect(await db.InitUser("absent", "wrong")).toBeUndefined();
  expect(
    db.session.db
      .query<{ Password: string }, []>("SELECT Password FROM FxUserAccount")
      .get()!.Password,
  ).toStartWith("$argon2id$");
  expect(JSON.stringify(alice)).not.toContain("pass123");
  expect("Password" in alice).toBe(false);
  expect(db.ConfirmUnregisteredId("ALICE")).toBe(1);
  db.session.IntegrityCheck();
});
test("case-variant duplicate race rolls back dynamic table and leaks no half-created account", async () => {
  const db = open();
  const result = await Promise.allSettled([
    db.RegisterNewUser({ ID: "Alice", Password: "one" }),
    db.RegisterNewUser({ ID: "ALICE", Password: "two" }),
  ]);
  expect(result.filter((r) => r.status === "fulfilled").length).toBe(1);
  expect(
    db.session.db
      .query<{ count: number }, []>("SELECT count(*) count FROM FxUserAccount")
      .get()!.count,
  ).toBe(1);
  expect(
    db.session.db
      .query<{ count: number }, []>("SELECT count(*) count FROM FxUserDynamic")
      .get()!.count,
  ).toBe(1);
});
test("money cannot underflow, inventory ownership/zero-delta removal/expiry enforced", async () => {
  const db = open();
  await db.RegisterNewUser({ ID: "A", Password: "p" });
  await db.RegisterNewUser({ ID: "B", Password: "p" });
  expect(db.SetMoney("A", 500)).toBe(true);
  expect(db.SetMoney("A", -501)).toBe(false);
  expect(db.GetUserInfo("A")!.Money).toBe(500);
  const item = db.AddInventory("A", 123, 2);
  expect(db.DeleteInventory("B", item.SN)).toBe(false);
  expect(db.UpdateInventoryAmountDelta("B", item.SN, -1)).toBe(false);
  expect(db.UpdateInventoryAmountDelta("A", item.SN, -3)).toBe(false);
  expect(db.LoadInventory("A")[0]!.Amount).toBe(2);
  expect(db.UpdateInventoryAmountDelta("A", item.SN, -2)).toBe(true);
  expect(db.LoadInventory("A").length).toBe(0);
  db.AddInventory("A", 123, 1, 1);
  expect(db.LoadInventory("A", 2).length).toBe(0);
  db.session.IntegrityCheck();
});
test("original byte-sized fields and SQL bound parameters", async () => {
  const db = open();
  expect(() => db.ValidateID("\0bad")).toThrow();
  expect(() => db.ValidateID("初級".repeat(5))).toThrow();
  await db.RegisterNewUser({ ID: "x'OR'1'='1", Password: "p" });
  expect(await db.InitUser("x'OR'1'='1", "wrong")).toBeUndefined();
  expect(() => db.AddInventory("nonexistent", 1, 1)).toThrow();
  expect(() => db.SetMoney("a", NaN)).toThrow();
});

test("explicit legacy-uu imports verify, reject bad input and upgrade only after valid login", async () => {
  const db = open();
  await db.RegisterNewUser({ ID: "A", Password: "old" });
  const legacy = `legacy-uu:${EncodePassword(db.text.Encode("legacy-pass")).toString("base64")}`;
  const stored = () =>
    db.session.db
      .query<{ Password: string }, []>("SELECT Password FROM FxUserAccount")
      .get()!.Password;
  db.session.db.query("UPDATE FxUserAccount SET Password = ?").run(legacy);
  expect(await db.InitUser("A", "wrong")).toBeUndefined();
  expect(stored()).toBe(legacy);
  expect((await db.InitUser("A", "legacy-pass"))?.TotalConn).toBe(1);
  expect(stored()).toStartWith("$argon2id$");
  expect(await db.InitUser("A", "old")).toBeUndefined();
  expect((await db.InitUser("A", "legacy-pass"))?.TotalConn).toBe(2);
});
test("password reset and ban racing an awaited hash cannot authorize stale credentials", async () => {
  const db = open();
  await db.RegisterNewUser({ ID: "A", Password: "p" });
  const old = db.InitUser("A", "p");
  db.session.db.query("UPDATE FxUserAccount SET Password = 'disabled'").run();
  expect(await old).toBeUndefined();
  expect(db.GetUserInfo("A")!.TotalConn).toBe(0);
  await db.SetPassword("A", "new");
  const banned = db.InitUser("A", "new");
  db.session.db.query("UPDATE FxUserAccount SET BannedUntil = -1").run();
  expect(await banned).toBeUndefined();
  expect(db.GetUserInfo("A")!.TotalConn).toBe(0);
  db.session.db
    .query("UPDATE FxUserAccount SET Password = ?, BannedUntil = 0")
    .run(
      `legacy-uu:${EncodePassword(db.text.Encode("legacy")).toString("base64")}`,
    );
  // Already verified and read an unbanned legacy row; ban during upgrade hashing.
  const upgrading = db.InitUser("A", "legacy");
  db.session.db.query("UPDATE FxUserAccount SET BannedUntil = -1").run();
  expect(await upgrading).toBeUndefined();
  expect(db.GetUserInfo("A")!.TotalConn).toBe(0);
  db.session.db
    .query("UPDATE FxUserAccount SET BannedUntil = unixepoch() - 1")
    .run();
  expect(await db.InitUser("A", "legacy")).toBeDefined();
  expect(
    JSON.stringify(db.session.db.query("SELECT * FROM RuntimeAudit").all()),
  ).not.toContain("legacy");
});
test("registration rejects out-of-range byte flags before inserting account or dynamic rows", async () => {
  const db = open();
  for (const fields of [{ Gender: -1 }, { EmailRcv: 256 }, { Reveal: 0.5 }])
    await expect(
      db.RegisterNewUser({ ID: "A", Password: "p", ...fields }),
    ).rejects.toThrow("flag");
  expect(db.GetUserInfo("A")).toBeUndefined();
});
