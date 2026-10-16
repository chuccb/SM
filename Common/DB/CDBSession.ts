import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { ExecuteSQLiteScript } from "./SQLiteScript.ts";
import { InitializeSQLiteConnection } from "./SQLiteInitialization.ts";
import { RuntimePolicy } from "../RuntimePolicy.ts";

/** SQLite replacement for the Win32/OLEDB CDBSession. Only bound queries in callers. */
export class CDBSession {
  readonly db: Database;
  private closed = false;
  constructor(readonly path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    try {
      if (path !== ":memory:") chmodSync(path, 0o600);
      InitializeSQLiteConnection(this.db, path !== ":memory:");
      this.Migrate();
    } catch (error) {
      this.db.close(false);
      this.closed = true;
      throw error;
    }
  }
  private Migrate(): void {
    this.db
      .transaction(() => {
        const version = this.db
          .query<{ user_version: number }, []>("PRAGMA user_version")
          .get()!.user_version;
        if (version > RuntimePolicy.SchemaVersion)
          throw new Error(
            `SQLite schema ${version} is newer than this server (${RuntimePolicy.SchemaVersion})`,
          );
        // Ordered, transactional upgrades: a v1 database must not be treated as
        // already current when adding result/money/house/inventory receipts. No destructive recreate/export step.
        const migrations = [
          "001_Initial.sql",
          "002_GameResult.sql",
          "003_MoneyPickup.sql",
          "004_HouseClaim.sql",
          "005_SpecialItemUse.sql",
          "006_UserItemCatalog.sql",
        ];
        for (
          let next = version + 1;
          next <= RuntimePolicy.SchemaVersion;
          next++
        ) {
          const name = migrations[next - 1];
          if (!name) throw new Error(`Missing SQLite migration ${next}`);
          ExecuteSQLiteScript(
            this.db,
            readFileSync(
              new URL(`./Migrations/${name}`, import.meta.url),
              "utf8",
            ),
          );
          this.db.exec(`PRAGMA user_version = ${next}`);
        }
      })
      .immediate();
  }
  IntegrityCheck(): void {
    const result = this.db
      .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
      .all();
    if (result.some((row) => row.integrity_check !== "ok"))
      throw new Error("SQLite integrity check failed");
    if (this.db.query("PRAGMA foreign_key_check").all().length)
      throw new Error("SQLite foreign-key check failed");
  }
  Close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close(false);
    }
  }
}
