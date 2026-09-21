/**
 * CDBMan unit tests — the CAConfig.bak seeding and the auto-registration.
 *
 * Covered:
 *  - ParseCAConfigBak against the original DB/CAConfig.bak: exactly the
 *    operator's CAMultiSvr row ("world name" @ "123", Param 0, Current 1)
 *    and the two CALoginSvr rows (port 3838, Flag 1)
 *  - CDBMan seeds both tables at construction while they are empty, with
 *    every IP rewritten to CA_CONFIG_SEED_IP; idempotent on reopen
 *  - the auto-registration path of prCAAuthUser: an unknown ID registers
 *    with the entered password (retval 0), a wrong password still fails
 *    (retval -1)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CA_CONFIG_SEED_IP, LocateCAConfigBak, ParseCAConfigBak } from "../src/db/CAConfigBak.ts";
import { CDBMan, EncodePassword, GetUserHashNo } from "../src/db/DBMan.ts";

describe("CAConfigBak", () => {
  test("the original backup yields the operator's rows", async () => {
    const bak = LocateCAConfigBak();
    expect(bak).not.toBeNull();
    const rows = ParseCAConfigBak(new Uint8Array(await Bun.file(bak!).arrayBuffer()));
    expect(rows.CAMultiSvr).toEqual([{ SN: 1, Name: "world name", IP: "123", Param: 0, Current: 1 }]);
    expect(rows.CALoginSvr).toEqual([
      { SN: 1, IP: "211.20.189.170", Port: 3838, Flag: 1 },
      { SN: 2, IP: "211.20.177.140", Port: 3838, Flag: 1 },
    ]);
    expect(rows.CAString).toEqual([
      { sn: 1, type: 0, value: "ChargeUrl", strAttr: "http://www.digicell.com.tw/opencard/money.aspx" },
    ]);
  });
});

describe("CDBMan seeding + auto-registration", () => {
  let dir: string;
  const managers: CDBMan[] = [];
  const openManager = (): CDBMan => {
    const manager = new CDBMan(dir);
    managers.push(manager);
    return manager;
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "db-test-"));
  });

  afterAll(() => {
    for (const manager of managers.toReversed()) manager.Close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("both tables are seeded at construction, IPs bound to the seed address", () => {
    const db = openManager();
    expect(db.GetMultiServers()).toEqual([{ SN: 1, Name: "world name", IP: CA_CONFIG_SEED_IP, Param: 0, Current: 1 }]);
    expect(db.GetLoginServers()).toEqual([
      { SN: 1, IP: CA_CONFIG_SEED_IP, Port: 3838, Flag: 1 },
      { SN: 2, IP: CA_CONFIG_SEED_IP, Port: 3838, Flag: 1 },
    ]);
    expect(db.GetMultiServerNotices()).toEqual([
      { sn: 1, type: 0, value: "ChargeUrl", strAttr: "http://www.digicell.com.tw/opencard/money.aspx" },
    ]);
  });

  test("reseeding is idempotent — operator edits survive a reopen", () => {
    const db = openManager();
    db.config.query("UPDATE CAMultiSvr SET Name = 'my server' WHERE SN = 1").run();
    const again = openManager();
    expect(again.GetMultiServers().length).toBe(1);
    expect(again.GetMultiServers()[0]!.Name).toBe("my server");
  });

  test("a login with an unknown ID registers and succeeds (retval 0) if meeting requirements", () => {
    const db = openManager();
    // ID < 5 fails auto-registration
    expect(db.prCAAuthUser("user", EncodePassword("password123")).retval).toBe(-1);
    // PW < 8 fails auto-registration
    expect(db.prCAAuthUser("autoreguser", EncodePassword("short")).retval).toBe(-1);

    const res = db.prCAAuthUser("autoreguser", EncodePassword("password123"));
    expect(res.retval).toBe(0);
    expect(res.FxMoney).toBe(1_000_000);
    expect(res.Fxexp).toBe(13_815_000);
    // Billing wallet should be auto-created with 900,000 Cash
    const wallet = db.inventory[GetUserHashNo("autoreguser")].query(
      "SELECT Balance FROM LocalBillingWallet WHERE Account = ?",
    ).get("autoreguser") as { Balance: number } | null;
    expect(wallet?.Balance).toBe(900_000);

    // the account is now real: reconnecting with the same password works
    expect(db.prCAAuthUser("autoreguser", EncodePassword("password123")).retval).toBe(0);
  });

  test("a wrong password for an existing account fails without touching it", () => {
    const db = openManager();
    expect(db.prCAAuthUser("autoreguser", EncodePassword("WRONGPASSWORD")).retval).toBe(-1);
    // the stored secret is unchanged — the original password still logs in
    expect(db.prCAAuthUser("autoreguser", EncodePassword("password123")).retval).toBe(0);
  });
});
