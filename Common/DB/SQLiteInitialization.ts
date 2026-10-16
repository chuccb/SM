import { type Database, SQLiteError } from "bun:sqlite";
import { RuntimePolicy } from "../RuntimePolicy.ts";
import { ExecuteSQLiteScript } from "./SQLiteScript.ts";

/** Modern synchronous STARTUP ports, not financial transaction retry hooks.
 * SetJournalMode must ONLY set the connection busy timeout and WAL pragma;
 * migrations, account writes, receipts and callbacks with effects are excluded. */
export interface SQLiteJournalInitializationPorts {
  readonly SetJournalMode: (busyTimeoutMs: number) => unknown;
  readonly RestoreBusyTimeout: () => void;
  readonly Now: () => number;
  readonly Wait: (milliseconds: number) => void;
}

/** SQLITE_BUSY may bypass SQLite's busy handler while acquiring the exclusive
 * journal-mode lock (lock upgrades must not deadlock). Retry this ONE idempotent
 * startup pragma only, within ONE monotonic busy budget. No outer transaction,
 * arbitrary SQL retry, silent DELETE-mode fallback or financial replay. */
export function InitializeSQLiteJournalMode(
  ports: SQLiteJournalInitializationPorts,
  expected: "wal" | "memory",
): void {
  const set = ports.SetJournalMode,
    restore = ports.RestoreBusyTimeout,
    now = ports.Now,
    wait = ports.Wait;
  if (
    ![set, restore, now, wait].every((f) => typeof f === "function") ||
    (expected !== "wal" && expected !== "memory")
  )
    throw new Error("Invalid SQLite journal initialization ports/profile");
  const budget = RuntimePolicy.BusyTimeoutMs,
    delay = RuntimePolicy.SQLiteJournalModeRetryDelayMs;
  let previous = -Infinity;
  const readTime = () => {
    const n = now.call(ports);
    if (!Number.isFinite(n) || n < 0 || n < previous)
      throw new Error("Invalid SQLite journal initialization clock");
    previous = n;
    return n;
  };
  const start = readTime(),
    deadline = start + budget;
  if (!Number.isFinite(deadline) || deadline <= start)
    throw new Error("Invalid SQLite journal initialization deadline");
  // A faulty trusted clock/wait adapter must not turn a startup loop infinite.
  const maxAttempts = Math.ceil(budget / delay) + 1;
  let lastBusy: SQLiteError | undefined;
  try {
    let initialized = false;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const remaining = deadline - readTime();
      if (remaining <= 0) {
        if (lastBusy) throw lastBusy;
        throw new Error("SQLite journal initialization deadline exceeded");
      }
      let mode: unknown;
      try {
        mode = set.call(ports, Math.min(budget, Math.ceil(remaining)));
      } catch (error) {
        // SQLite result codes: primary BUSY = 5, low byte of extended errno.
        // LOCKED (6), IOERR, CORRUPT, constraints and JS adapter errors fail now.
        // Bun's instanceof check is name-based, not unforgeable authority.
        // These ports are TRUSTED and the production callback only runs WAL.
        if (
          !(error instanceof SQLiteError) ||
          !Number.isSafeInteger(error.errno) ||
          error.errno < 0 ||
          (error.errno & 0xff) !== 5
        )
          throw error;
        lastBusy = error;
        const remaining = deadline - readTime();
        if (remaining <= 0 || attempt + 1 === maxAttempts) throw error;
        wait.call(ports, Math.min(delay, remaining));
        continue;
      }
      if (mode !== expected)
        throw new Error("SQLite journal initialization mode mismatch");
      // A successful pragma really selected the required mode. A BUSY did
      // not imply success, and :memory: is explicitly NOT advertised as WAL.
      initialized = true;
      break;
    }
    if (!initialized)
      throw new Error("SQLite journal initialization attempts exhausted");
  } catch (error) {
    // The constructor will close a failed connection. Restoration is best
    // effort then; preserve the ORIGINAL error if even cleanup is rejected.
    try {
      restore.call(ports);
    } catch {}
    throw error;
  }
  // A restore failure is NOT a retryable SetJournalMode failure.
  restore.call(ports);
}

/** Per-connection invariants before trusted migrations. All statements finalize
 * individually; there is no Bun multi-statement exec error masking. */
export function InitializeSQLiteConnection(
  db: Database,
  fileBacked: boolean,
): void {
  if (db.inTransaction)
    throw new Error("SQLite initialization requires no outer transaction");
  ExecuteSQLiteScript(
    db,
    `PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${RuntimePolicy.BusyTimeoutMs}; PRAGMA trusted_schema = OFF;`,
  );
  const restore = () =>
    ExecuteSQLiteScript(
      db,
      `PRAGMA busy_timeout = ${RuntimePolicy.BusyTimeoutMs}`,
    );
  InitializeSQLiteJournalMode(
    {
      SetJournalMode(timeout) {
        ExecuteSQLiteScript(db, `PRAGMA busy_timeout = ${timeout}`);
        const statement = db.prepare<{ journal_mode: string }, []>(
          "PRAGMA journal_mode = WAL",
        );
        try {
          return statement.get()?.journal_mode;
        } finally {
          statement.finalize();
        }
      },
      RestoreBusyTimeout: restore,
      Now: () => performance.now(),
      Wait: (milliseconds) => Bun.sleepSync(milliseconds),
    },
    fileBacked ? "wal" : "memory",
  );
  ExecuteSQLiteScript(db, "PRAGMA synchronous = FULL");
}
