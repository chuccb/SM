/** A03: real SQLite failure/commit/visibility tests and independent-process
 * contention. These assert atomicity, not unverified SQL Server identity gaps.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CDBMan, EncodePassword, GetUserHashNo, USER_DB_BUSY_TIMEOUT_MS } from "../src/db/DBMan.ts";
import type { RegistrationCommand, RegistrationReply } from "./fixtures/account-registration-worker.ts";

const accountTables = ["FxUserAccount", "FxUserDynamic", "TxUserDynamic"] as const;
let dir: string;
let db: CDBMan;
let connections: Database[];
let workers: Bun.Subprocess[];

function openManager() {
  const manager = new CDBMan(dir);
  connections.push(...manager.userInfo, ...manager.inventory, manager.config, manager.item, manager.guild);
  return manager;
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sm-registration-"));
  connections = [];
  workers = [];
  db = openManager();
});
afterEach(async () => {
  for (const worker of workers) worker.kill();
  await Promise.all(workers.map((worker) => worker.exited));
  for (const connection of connections) connection.close();
  rmSync(dir, { recursive: true, force: true });
});

function shard(id = "atomic") { return db.userInfo[GetUserHashNo(id)]!; }
function create(id = "atomic", password = EncodePassword("fixture"), manager = db) {
  return manager.prCreateUser(id, "display", password, "mail", 1, 1, "address", "tel", 1,
    "profile", "question", "answer", "identity", "2000-01-01");
}
function counts(connection: Database, id = "atomic") {
  return accountTables.map((table) => connection.query<{ n: number }, [string]>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE ID=?`,
  ).get(id)!.n);
}
function state(connection: Database) {
  return accountTables.map((table) => connection.query(`SELECT * FROM ${table} ORDER BY ID`).all());
}
function fault(table: typeof accountTables[number], timing: "BEFORE" | "AFTER", action = "FAIL") {
  // TEMP makes the injected fault connection-local; no production DB is used.
  shard().exec(`CREATE TEMP TRIGGER registration_fault ${timing} INSERT ON ${table}
    BEGIN SELECT RAISE(${action}, 'registration fixture'); END`);
}
function dropFault() { shard().exec("DROP TRIGGER registration_fault"); }

async function worker() {
  const queued: RegistrationReply[] = [];
  let pending: ((reply: RegistrationReply) => void) | undefined;
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/account-registration-worker.ts"), dir], {
    stdin: "ignore", stdout: "ignore", stderr: "pipe",
    ipc(message: RegistrationReply) {
      if (pending) {
        const resolve = pending;
        pending = undefined;
        resolve(message);
      } else queued.push(message);
    },
  });
  workers.push(child);
  const exited = child.exited.then(async (code) => {
    const error = await new Response(child.stderr).text();
    throw new Error(`registration worker exited ${code}: ${error}`);
  });
  // Observe exit even if no next() is pending, without an unhandled rejection.
  exited.catch(() => {});
  async function next() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await Promise.race([
        queued.length ? Promise.resolve(queued.shift()!) : new Promise<RegistrationReply>((resolve) => { pending = resolve; }),
        exited,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("worker reply timeout")), 8000); }),
      ]);
      if (reply.kind === "error") throw new Error(reply.error);
      return reply;
    } finally { clearTimeout(timer); }
  }
  expect(await next()).toEqual({ kind: "ready" });
  return {
    process: child,
    next,
    send(command: RegistrationCommand) { child.send(command); },
    async run(command: RegistrationCommand) { child.send(command); return next(); },
  };
}

describe("prCreateUser atomic transaction", () => {
  test("all six shards: full account fields, companions, local serials, and reopen", () => {
    for (const prefix of "abcdef") {
      const id = `${prefix}account`;
      expect(create(id)).toBe(0);
      expect(counts(shard(id), id)).toEqual([1, 1, 1]);
      expect(shard(id).query("PRAGMA busy_timeout").get()).toEqual({ timeout: USER_DB_BUSY_TIMEOUT_MS });
      expect(db.prGetUserAccount(id)).toMatchObject({
        ID: id, SN: 1, SID: 1, Name: "display", Password: EncodePassword("fixture"),
        Email: "mail", EmailRcv: 1, Gender: 1, Address: "address", Tel: "tel", Reveal: 1,
        Profile: "profile", PasswordQ: "question", PasswordA: "answer", IdentityNo: "identity",
        Birthday: "2000-01-01", ShopCardNo: 1, TotalConn: 0, LastConn: null,
      });
      expect(db.prGetUserInfo(id)).toMatchObject({ retval: 0, money: 0, exp: 0, win: 0, draw: 0, lose: 0 });
    }
    const reopened = openManager();
    for (const prefix of "abcdef") {
      const id = `${prefix}account`;
      expect(reopened.prCAAuthUser(id, EncodePassword("fixture"))).toMatchObject({ retval: 0, SID: 1 });
    }
  });

  test("duplicate ID leaves every existing value and credential unchanged", () => {
    expect(create()).toBe(0);
    shard().exec("UPDATE FxUserDynamic SET Money=9,Exp=3000,Win=4,Draw=5,Lose=6");
    const before = state(shard());
    expect(create("atomic", EncodePassword("replacement"))).toBe(-1);
    expect(state(shard())).toEqual(before);
    expect(shard().inTransaction).toBe(false);
  });

  for (const table of accountTables) for (const timing of ["BEFORE", "AFTER"] as const) {
    test(`${timing} ${table} failure rolls back all inserts; same ID can retry`, () => {
      expect(create("anchor")).toBe(0);
      const before = state(shard());
      fault(table, timing);
      expect(create()).toBe(-1);
      expect(state(shard())).toEqual(before);
      expect(counts(shard())).toEqual([0, 0, 0]);
      expect(shard().inTransaction).toBe(false);
      dropFault();
      expect(create()).toBe(0);
      expect(counts(shard())).toEqual([1, 1, 1]);
    });
  }

  for (const table of ["FxUserDynamic", "TxUserDynamic"] as const) {
    test(`pre-existing ${table} conflict preserves the orphan, not a new half-account`, () => {
      shard().query(`INSERT INTO ${table} (ID,Exp) VALUES (?,77)`).run("atomic");
      const before = state(shard());
      expect(create()).toBe(-1);
      expect(state(shard())).toEqual(before);
      expect(db.prConfirmUnregisteredId("atomic")).toBe(0);
      expect(shard().inTransaction).toBe(false);
    });
  }

  test("SQL itself aborting the transaction is safe to handle", () => {
    fault("TxUserDynamic", "AFTER", "ROLLBACK");
    expect(create()).toBe(-1);
    expect(counts(shard())).toEqual([0, 0, 0]);
    expect(shard().inTransaction).toBe(false);
    dropFault();
    expect(create()).toBe(0);
  });

  test("serial read failure leaves no open transaction or inserted rows", () => {
    shard().exec("ALTER TABLE FxUserAccount RENAME TO unavailable_account");
    expect(create()).toBe(-1);
    expect(shard().inTransaction).toBe(false);
    shard().exec("ALTER TABLE unavailable_account RENAME TO FxUserAccount");
    expect(counts(shard())).toEqual([0, 0, 0]);
    expect(create()).toBe(0);
  });

  test("COMMIT failure rolls back even after all three INSERTs completed", () => {
    shard().exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE commit_parent (ID INTEGER PRIMARY KEY);
      CREATE TABLE commit_child (Parent INTEGER REFERENCES commit_parent(ID) DEFERRABLE INITIALLY DEFERRED);
      CREATE TEMP TRIGGER fail_commit AFTER INSERT ON TxUserDynamic
        BEGIN INSERT INTO commit_child VALUES (1); END;`);
    expect(create()).toBe(-1);
    expect(counts(shard())).toEqual([0, 0, 0]);
    expect(shard().query("SELECT * FROM commit_child").all()).toEqual([]);
    expect(shard().inTransaction).toBe(false);
    shard().exec("DROP TRIGGER fail_commit");
    expect(create()).toBe(0);
  });

  test("another connection never sees the intermediate INSERTs", () => {
    const reader = openManager().userInfo[GetUserHashNo("atomic")]!;
    const observations: number[][] = [];
    const query = shard().query.bind(shard());
    const restoreStatements: (() => void)[] = [];
    const querySpy = spyOn(shard(), "query").mockImplementation(
      <Row, Params extends SQLQueryBindings | SQLQueryBindings[]>(sql: string) => {
        const statement = query<Row, Params>(sql);
        if (sql.startsWith("INSERT INTO ")) {
          const run = statement.run.bind(statement);
          const runSpy = spyOn(statement, "run").mockImplementation((...params) => {
            const result = run(...params); // real INSERT, before the enclosing COMMIT
            observations.push(counts(reader));
            return result;
          });
          restoreStatements.push(() => runSpy.mockRestore());
        }
        return statement;
      },
    );
    try {
      expect(create()).toBe(0);
      expect(observations).toEqual([[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
      expect(counts(reader)).toEqual([1, 1, 1]);
    } finally {
      for (const restore of restoreStatements) restore();
      querySpy.mockRestore();
    }
  });
});

describe("required automatic registration", () => {
  for (const table of accountTables) {
    test(`${table} failure cannot leave a login-capable half-account`, () => {
      fault(table, "AFTER");
      expect(db.prCAAuthUser("atomic", EncodePassword("fixture123")).retval).toBe(-1);
      expect(counts(shard())).toEqual([0, 0, 0]);
      dropFault();
      expect(db.prCAAuthUser("atomic", EncodePassword("fixture123")).retval).toBe(0);
      expect(counts(shard())).toEqual([1, 1, 1]);
      expect(db.prGetUserAccount("atomic")).toMatchObject({ Password: EncodePassword("fixture123"), TotalConn: 1 });
      const before = state(shard());
      expect(db.prCAAuthUser("atomic", EncodePassword("wrong12345")).retval).toBe(-1);
      expect(state(shard())).toEqual(before);
    });
  }

  for (const passwordMatches of [true, false]) {
    test(`another creator wins before INSERT; password matches=${passwordMatches}`, () => {
      const other = openManager();
      const original = db.prCreateUser.bind(db);
      const createSpy = spyOn(db, "prCreateUser").mockImplementation((...args) => {
        expect(create("atomic", EncodePassword("winner123"), other)).toBe(0);
        return original(...args); // the actual duplicate INSERT fails and rolls back
      });
      try {
        const result = db.prCAAuthUser("atomic", EncodePassword(passwordMatches ? "winner123" : "loser123"));
        expect(result.retval).toBe(passwordMatches ? 0 : -1);
        expect(createSpy).toHaveBeenCalledTimes(1);
        expect(db.prGetUserAccount("atomic")).toMatchObject({
          Password: EncodePassword("winner123"), TotalConn: passwordMatches ? 1 : 0,
        });
        expect(counts(shard())).toEqual([1, 1, 1]);
      } finally { createSpy.mockRestore(); }
    });
  }

  test("another creator wins before the existence check; re-read credentials, not just ID", () => {
    const other = openManager();
    const query = shard().query.bind(shard());
    const querySpy = spyOn(shard(), "query").mockImplementation(
      <Row, Params extends SQLQueryBindings | SQLQueryBindings[]>(sql: string) => {
        if (sql === "SELECT 1 FROM FxUserAccount WHERE ID = ?") {
          expect(create("atomic", EncodePassword("winner123"), other)).toBe(0);
        }
        return query<Row, Params>(sql);
      },
    );
    try {
      expect(db.prCAAuthUser("atomic", EncodePassword("winner123")).retval).toBe(0);
      expect(counts(shard())).toEqual([1, 1, 1]);
    } finally { querySpy.mockRestore(); }
  });
});

describe("independent-process SQLite contention", () => {
  test("wait for the writer BEFORE MAX(SN); observe its committed serial", async () => {
    const holder = await worker();
    expect(await holder.run({ kind: "hold", id: "anchor", releaseAfterMs: 150, createWhileLocked: true }))
      .toEqual({ kind: "locked" });
    expect(create()).toBe(0);
    expect(db.prGetUserAccount("atomic")).toMatchObject({ SN: 2, SID: 2 });
    expect(await holder.next()).toEqual({ kind: "released" });
    expect(counts(shard())).toEqual([1, 1, 1]);
  });

  test("lock timeout leaves nothing; other shards work and retry succeeds after release", async () => {
    const holder = await worker();
    expect(await holder.run({ kind: "hold", id: "anchor" })).toEqual({ kind: "locked" });
    shard().exec("PRAGMA busy_timeout=40"); // exercise timeout without waiting 5 seconds
    expect(create()).toBe(-1);
    expect(counts(shard())).toEqual([0, 0, 0]);
    expect(shard().inTransaction).toBe(false);
    expect(create("bother")).toBe(0);
    expect(await holder.run({ kind: "release" })).toEqual({ kind: "released" });
    expect(create()).toBe(0);
  });

  test("process death before commit cannot publish a partial account", async () => {
    const holder = await worker();
    expect(await holder.run({ kind: "hold", id: "atomic", createWhileLocked: true })).toEqual({ kind: "locked" });
    expect(counts(shard())).toEqual([0, 0, 0]);
    holder.process.kill("SIGKILL");
    await holder.process.exited;
    expect(counts(shard())).toEqual([0, 0, 0]);
    expect(create()).toBe(0);
  });

  test("four processes allocate 80 unique shard-local serials without transient failures", async () => {
    const clients = [];
    for (let i = 0; i < 4; i++) clients.push(await worker());
    const replies = await Promise.all(clients.map((client, i) => client.run({
      kind: "create", accounts: Array.from({ length: 20 }, (_, j) => ({ id: `a${i}_${j}`, password: "fixture" })),
    })));
    for (const reply of replies) expect(reply).toEqual({ kind: "result", results: Array(20).fill(0) });
    const accounts = shard().query<{ SN: number; SID: number }, []>("SELECT SN,SID FROM FxUserAccount ORDER BY SN").all();
    expect(accounts.map((row) => row.SN)).toEqual(Array.from({ length: 80 }, (_, i) => i + 1));
    expect(accounts.every((row) => row.SN === row.SID)).toBe(true);
    expect(state(shard()).map((rows) => rows.length)).toEqual([80, 80, 80]);
  });

  for (const mode of ["duplicate", "same-password", "different-password"] as const) {
    test(`four concurrent requests: ${mode}`, async () => {
      const clients = [];
      for (let i = 0; i < 4; i++) clients.push(await worker());
      const replies = await Promise.all(clients.map((client, i) => client.run({
        kind: mode === "duplicate" ? "create" : "authenticate",
        accounts: [{ id: "atomic", password: mode === "different-password" ? `secret123_${i}` : "fixture123" }],
      })));
      const results = replies.map((reply) => {
        if (reply.kind !== "result") throw new Error(`Unexpected reply ${reply.kind}`);
        return reply.results[0]!;
      });
      const successCount = mode === "same-password" ? 4 : 1;
      expect(results.filter((code) => code === 0)).toHaveLength(successCount);
      expect(results.filter((code) => code === -1)).toHaveLength(4 - successCount);
      expect(counts(shard())).toEqual([1, 1, 1]);
      expect(db.prGetUserAccount("atomic")).toMatchObject({ TotalConn: mode === "duplicate" ? 0 : successCount });
      if (mode === "different-password") {
        const winner = results.indexOf(0);
        expect(db.prGetUserAccount("atomic")).toMatchObject({ Password: EncodePassword(`secret123_${winner}`) });
      }
    });
  }
});
