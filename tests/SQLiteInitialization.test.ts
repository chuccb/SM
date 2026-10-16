import { expect, test } from "bun:test";
import { Database, SQLiteError } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CDBSession } from "../Common/DB/CDBSession.ts";
import {
  InitializeSQLiteConnection,
  InitializeSQLiteJournalMode,
  type SQLiteJournalInitializationPorts,
} from "../Common/DB/SQLiteInitialization.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";

function sqliteError(errno = 5): SQLiteError {
  // POLICY MODEL ONLY: Bun disallows constructing SQLiteError and its real
  // errno is readonly. Model result codes through the prototype, explicitly
  // not an execution oracle. The real-lock test below obtains native BUSY.
  // This is a startup error filter, NOT a JS-object authenticity boundary.
  return Object.create(SQLiteError.prototype, {
    name: { value: "SQLiteError" },
    message: { value: `modeled SQLite error ${errno}` },
    errno: { value: errno },
  }) as SQLiteError;
}
function fake() {
  let time = 0,
    restores = 0;
  const timeouts: number[] = [],
    waits: number[] = [];
  const ports: SQLiteJournalInitializationPorts = {
    SetJournalMode(timeout) {
      timeouts.push(timeout);
      return "wal";
    },
    RestoreBusyTimeout() {
      restores++;
    },
    Now: () => time,
    Wait(milliseconds) {
      waits.push(milliseconds);
      time += milliseconds;
    },
  };
  return {
    ports,
    timeouts,
    waits,
    restores: () => restores,
    advance: (n: number) => (time += n),
  };
}

test("startup verifies the actual WAL/memory mode and restores the configured timeout once", () => {
  for (const mode of ["wal", "memory"] as const) {
    const f = fake();
    InitializeSQLiteJournalMode(
      {
        ...f.ports,
        SetJournalMode(timeout) {
          f.ports.SetJournalMode(timeout);
          return mode;
        },
      },
      mode,
    );
    expect(f.timeouts).toEqual([RuntimePolicy.BusyTimeoutMs]);
    expect(f.waits).toEqual([]);
    expect(f.restores()).toBe(1);
  }
});

test("only the WAL pragma retries modeled primary/extended SQLiteError BUSY codes, with decreasing timeouts", () => {
  const f = fake(),
    errors = [sqliteError(5), sqliteError(261), sqliteError(517)];
  InitializeSQLiteJournalMode(
    {
      ...f.ports,
      SetJournalMode(timeout) {
        f.ports.SetJournalMode(timeout);
        const error = errors.shift();
        if (error) throw error;
        return "wal";
      },
    },
    "wal",
  );
  const b = RuntimePolicy.BusyTimeoutMs,
    d = RuntimePolicy.SQLiteJournalModeRetryDelayMs;
  expect(f.timeouts).toEqual([b, b - d, b - 2 * d, b - 3 * d]);
  expect(f.waits).toEqual([d, d, d]);
  expect(f.restores()).toBe(1);
});

test("modeled busy-handler time shares ONE budget; exhaustion preserves the last BUSY error", () => {
  const f = fake(),
    error = sqliteError();
  expect(() =>
    InitializeSQLiteJournalMode(
      {
        ...f.ports,
        SetJournalMode(timeout) {
          f.ports.SetJournalMode(timeout);
          f.advance(Math.min(1900, timeout));
          throw error;
        },
      },
      "wal",
    ),
  ).toThrow(error);
  const d = RuntimePolicy.SQLiteJournalModeRetryDelayMs,
    b = RuntimePolicy.BusyTimeoutMs;
  expect(f.timeouts).toEqual([b, b - 1900 - d, b - 3800 - 2 * d]);
  expect(f.waits).toEqual([d, d]);
  expect(f.restores()).toBe(1);
});

test("perpetual immediate BUSY and a broken nonadvancing trusted clock cannot loop indefinitely", () => {
  for (const clockAdvances of [true, false]) {
    const f = fake(),
      error = sqliteError(),
      waits: number[] = [];
    expect(() =>
      InitializeSQLiteJournalMode(
        {
          ...f.ports,
          SetJournalMode(timeout) {
            f.ports.SetJournalMode(timeout);
            throw error;
          },
          Wait(milliseconds) {
            waits.push(milliseconds);
            if (clockAdvances) f.advance(milliseconds);
          },
        },
        "wal",
      ),
    ).toThrow(error);
    expect(f.timeouts.length).toBeLessThanOrEqual(
      Math.ceil(
        RuntimePolicy.BusyTimeoutMs /
          RuntimePolicy.SQLiteJournalModeRetryDelayMs,
      ) + 1,
    );
    expect(waits.reduce((a, b) => a + b, 0)).toBe(RuntimePolicy.BusyTimeoutMs);
    expect(f.restores()).toBe(1);
  }
});

test("LOCKED, IOERR, CORRUPT, constraints, JS errors and message-only BUSY never retry", () => {
  for (const error of [
    sqliteError(6),
    sqliteError(10),
    sqliteError(11),
    sqliteError(19),
    sqliteError(787),
    new Error("database is locked"),
    Object.assign(new Error("database is locked"), {
      code: "SQLITE_BUSY",
      errno: 5,
    }),
    sqliteError(-251),
    sqliteError(NaN),
    sqliteError(5.5),
  ]) {
    const f = fake();
    expect(() =>
      InitializeSQLiteJournalMode(
        {
          ...f.ports,
          SetJournalMode(timeout) {
            f.ports.SetJournalMode(timeout);
            throw error;
          },
        },
        "wal",
      ),
    ).toThrow(error);
    expect(f.timeouts).toEqual([RuntimePolicy.BusyTimeoutMs]);
    expect(f.waits).toEqual([]);
    expect(f.restores()).toBe(1);
  }
});

test("there is no silent DELETE-mode or malformed/missing result fallback", () => {
  for (const mode of [
    "delete",
    "memory",
    undefined,
    null,
    { journal_mode: "wal" },
  ]) {
    const f = fake();
    expect(() =>
      InitializeSQLiteJournalMode(
        {
          ...f.ports,
          SetJournalMode(timeout) {
            f.ports.SetJournalMode(timeout);
            return mode;
          },
        },
        "wal",
      ),
    ).toThrow("mode mismatch");
    expect(f.timeouts).toEqual([RuntimePolicy.BusyTimeoutMs]);
    expect(f.waits).toEqual([]);
    expect(f.restores()).toBe(1);
  }
});

test("invalid/backward/throwing clocks fail closed without an unbounded retry or a mode success", () => {
  for (const readings of [
    [NaN],
    [-1],
    [Infinity],
    [Number.MAX_VALUE],
    [0, -1],
    [0, 0, NaN],
    [0, 0, -1],
  ]) {
    const f = fake(),
      values = [...readings];
    expect(() =>
      InitializeSQLiteJournalMode(
        {
          ...f.ports,
          Now: () => values.shift() ?? NaN,
          SetJournalMode(timeout) {
            f.ports.SetJournalMode(timeout);
            throw sqliteError();
          },
        },
        "wal",
      ),
    ).toThrow("SQLite journal initialization");
    expect(f.timeouts.length).toBeLessThanOrEqual(1);
    expect(f.waits).toEqual([]);
  }
  const error = new Error("clock unavailable"),
    f = fake();
  expect(() =>
    InitializeSQLiteJournalMode(
      {
        ...f.ports,
        Now: () => {
          throw error;
        },
      },
      "wal",
    ),
  ).toThrow(error);
  expect(f.timeouts).toEqual([]);
});

test("wait/restore BUSY is NOT a WAL attempt, and cleanup failure cannot hide the original error", () => {
  const error = sqliteError();
  for (const phase of ["wait", "restore"] as const) {
    const f = fake();
    let restores = 0;
    expect(() =>
      InitializeSQLiteJournalMode(
        {
          ...f.ports,
          SetJournalMode(timeout) {
            f.ports.SetJournalMode(timeout);
            if (phase === "wait") throw sqliteError();
            return "wal";
          },
          Wait: () => {
            throw error;
          },
          RestoreBusyTimeout() {
            restores++;
            if (phase === "restore") throw error;
          },
        },
        "wal",
      ),
    ).toThrow(error);
    expect(f.timeouts).toHaveLength(1);
    expect(restores).toBe(1);
  }
  const f = fake(),
    original = new Error("permanent pragma failure");
  expect(() =>
    InitializeSQLiteJournalMode(
      {
        ...f.ports,
        SetJournalMode: () => {
          throw original;
        },
        RestoreBusyTimeout: () => {
          throw new Error("cleanup failed");
        },
      },
      "wal",
    ),
  ).toThrow(original);
});

test("real memory/file connections enforce the mode, FK/FULL/trusted-schema/timeout and schema6 invariants", () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-sqlite-initialization-"));
  try {
    for (const path of [":memory:", join(dir, "users.sqlite")]) {
      const session = new CDBSession(path);
      try {
        expect(session.db.query("PRAGMA journal_mode").get()).toEqual({
          journal_mode: path === ":memory:" ? "memory" : "wal",
        });
        expect(session.db.query("PRAGMA foreign_keys").get()).toEqual({
          foreign_keys: 1,
        });
        expect(session.db.query("PRAGMA synchronous").get()).toEqual({
          synchronous: 2,
        });
        expect(session.db.query("PRAGMA trusted_schema").get()).toEqual({
          trusted_schema: 0,
        });
        expect(session.db.query("PRAGMA busy_timeout").get()).toEqual({
          timeout: RuntimePolicy.BusyTimeoutMs,
        });
        expect(session.db.query("PRAGMA user_version").get()).toEqual({
          user_version: RuntimePolicy.SchemaVersion,
        });
        session.IntegrityCheck();
      } finally {
        session.Close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real initializer refuses an outer transaction BEFORE changing any connection setting", () => {
  const db = new Database(":memory:");
  try {
    db.exec("BEGIN");
    expect(() => InitializeSQLiteConnection(db, false)).toThrow(
      "no outer transaction",
    );
    expect(db.inTransaction).toBe(true);
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 0 });
    db.exec("ROLLBACK");
  } finally {
    db.close();
  }
});

async function* lines(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader(),
    decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        yield pending.slice(0, end);
        pending = pending.slice(end + 1);
      }
    }
    pending += decoder.decode();
    if (pending) yield pending;
  } finally {
    reader.releaseLock();
  }
}

test("real reader lock produces genuine WAL SQLITE_BUSY; release allows the SAME constructor to finish", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-wal-reader-lock-")),
    path = join(dir, "users.sqlite"),
    reader = new Database(path);
  // Explicit rollback-mode read transaction holds a shared file lock. No
  // synthetic busy exception; only its native busy handler is set to zero so
  // this deterministic regression models SQLite's immediate-BUSY path.
  reader.exec(
    "CREATE TABLE probe(v INTEGER); INSERT INTO probe VALUES(77); BEGIN",
  );
  reader.query("SELECT v FROM probe").get();
  const script = `import { Database } from 'bun:sqlite';
    import { CDBSession } from './Common/DB/CDBSession.ts';
    const nativePrepare = Database.prototype.prepare;
    let sawBusy = false;
    Database.prototype.prepare = function(sql, ...args) {
      const statement = nativePrepare.call(this, sql, ...args);
      if (/^PRAGMA journal_mode\\s*=\\s*WAL;?$/i.test(sql.trim())) {
        const timeout = nativePrepare.call(this, 'PRAGMA busy_timeout = 0');
        try { timeout.run(); } finally { timeout.finalize(); }
        for (const method of ['get','run']) {
          const original = statement[method];
          statement[method] = function(...values) {
            try { return original.apply(this, values); }
            catch (error) {
              if ((error.errno & 255) === 5 && !sawBusy) {
                sawBusy = true; console.log('busy');
              }
              throw error;
            }
          };
        }
      }
      return statement;
    };
    const session = new CDBSession(process.argv[1]);
    try {
      session.IntegrityCheck();
      console.log(JSON.stringify({ sawBusy,
        mode: session.db.query('PRAGMA journal_mode').get().journal_mode,
        timeout: session.db.query('PRAGMA busy_timeout').get().timeout,
        version: session.db.query('PRAGMA user_version').get().user_version,
        probe: session.db.query('SELECT v FROM probe').get().v }));
    } finally { session.Close(); }`;
  const child = Bun.spawn([process.execPath, "-e", script, path], {
      stdout: "pipe",
      stderr: "pipe",
    }),
    output = lines(child.stdout),
    errors = new Response(child.stderr).text();
  try {
    expect((await output.next()).value).toBe("busy");
    expect(reader.inTransaction).toBe(true);
    reader.exec("ROLLBACK");
    const result = (await output.next()).value;
    expect(await child.exited).toBe(0);
    expect(await errors).toBe("");
    expect(JSON.parse(result!)).toEqual({
      sawBusy: true,
      mode: "wal",
      timeout: RuntimePolicy.BusyTimeoutMs,
      version: RuntimePolicy.SchemaVersion,
      probe: 77,
    });
    expect((await output.next()).done).toBe(true);
  } finally {
    child.kill();
    await child.exited;
    await output.return(undefined);
    if (reader.inTransaction) reader.exec("ROLLBACK");
    reader.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

test("four phase-aligned Bun processes migrate fresh/v1 files without partial schema or duplicate receipts", async () => {
  for (const version of [0, 1]) {
    for (let round = 0; round < 4; round++) {
      const dir = mkdtempSync(join(tmpdir(), "sm-wal-migration-barrier-")),
        path = join(dir, "users.sqlite");
      if (version) {
        const old = new Database(path);
        try {
          old.exec(
            readFileSync(
              new URL(
                "../Common/DB/Migrations/001_Initial.sql",
                import.meta.url,
              ),
              "utf8",
            ),
          );
          old.exec("PRAGMA user_version=1");
        } finally {
          old.close();
        }
      }
      const script = `import { CDBSession } from './Common/DB/CDBSession.ts';
        console.log('ready'); await Bun.stdin.text();
        const s = new CDBSession(process.argv[1]);
        try { s.IntegrityCheck(); console.log(s.db.query('PRAGMA user_version').get().user_version); }
        finally { s.Close(); }`;
      const children = Array.from({ length: 4 }, () =>
          Bun.spawn([process.execPath, "-e", script, path], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          }),
        ),
        streams = children.map((p) => lines(p.stdout)),
        errors = children.map((p) => new Response(p.stderr).text());
      try {
        await Promise.all(
          streams.map(async (s) =>
            expect((await s.next()).value).toBe("ready"),
          ),
        );
        for (const p of children) p.stdin.end();
        expect(await Promise.all(children.map((p) => p.exited))).toEqual([
          0, 0, 0, 0,
        ]);
        expect(await Promise.all(errors)).toEqual(["", "", "", ""]);
        for (const s of streams) {
          expect((await s.next()).value).toBe(
            String(RuntimePolicy.SchemaVersion),
          );
          expect((await s.next()).done).toBe(true);
        }
        const check = new CDBSession(path);
        try {
          check.IntegrityCheck();
          for (const table of [
            "RuntimeGameResult",
            "RuntimeMoneyPickup",
            "RuntimeHouseClaim",
            "RuntimeSpecialItemUse",
          ]) {
            expect(
              check.db.query(`SELECT count(*) AS n FROM ${table}`).get(),
            ).toEqual({ n: 0 });
          }
        } finally {
          check.Close();
        }
      } finally {
        for (const p of children) p.kill();
        await Promise.all(children.map((p) => p.exited));
        await Promise.all(streams.map((s) => s.return(undefined)));
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
}, 30_000);
