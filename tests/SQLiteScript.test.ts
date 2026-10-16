import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import {
  ExecuteSQLiteScript,
  SplitSQLiteStatements,
} from "../Common/DB/SQLiteScript.ts";

// Modern migration-script regression tests, NOT execution of any backup SQL.
test("quoted strings/identifiers, escaped quotes and semicolons in BOTH comment forms never split trusted SQLite statements", () => {
  const sql = `-- CREATE TRIGGER fake BEGIN; ignored\nCREATE TABLE "table;one" ([semi;column] TEXT DEFAULT 'a;it''s', \`tick;col\` INTEGER); /* ; ' BEGIN END */\nINSERT INTO "table;one"(\`tick;col\`) VALUES(1); -- trailing;comment`;
  const parts = SplitSQLiteStatements(sql);
  expect(parts).toHaveLength(2);
  const d = new Database(":memory:");
  try {
    ExecuteSQLiteScript(d, sql);
    expect(d.query('SELECT * FROM "table;one"').get()).toEqual({
      "semi;column": "a;it's",
      "tick;col": 1,
    });
  } finally {
    d.close();
  }
});

test("CREATE TRIGGER BEGIN/END includes ALL inner statements and nested CASE/END; body SQL runs only when explicitly triggered", () => {
  const sql = `CREATE TABLE t(n INTEGER,v TEXT);CREATE TABLE log(v TEXT);
 CREATE TRIGGER test AFTER INSERT ON t BEGIN
 INSERT INTO log VALUES(CASE WHEN NEW.n=1 THEN 'case;END' ELSE CASE WHEN NEW.n=2 THEN 'nested;case' ELSE 'other' END END);
 UPDATE t SET v='BEGIN;END' WHERE n=NEW.n;
 END;
 INSERT INTO t(n) VALUES(1);INSERT INTO t(n) VALUES(2);`;
  expect(SplitSQLiteStatements(sql)).toHaveLength(5);
  const d = new Database(":memory:");
  try {
    ExecuteSQLiteScript(d, sql);
    expect(d.query("SELECT v FROM log ORDER BY rowid").all()).toEqual([
      { v: "case;END" },
      { v: "nested;case" },
    ]);
    expect(d.query("SELECT v FROM t ORDER BY n").all()).toEqual([
      { v: "BEGIN;END" },
      { v: "BEGIN;END" },
    ]);
  } finally {
    d.close();
  }
});

test("TEMP/TEMPORARY TRIGGER, comments before trigger tokens, quoted END identifiers, and statement without final semicolon remain intact", () => {
  for (const temp of ["TEMP", "TEMPORARY"]) {
    const d = new Database(":memory:");
    try {
      const sql = `CREATE TABLE t(n INTEGER);CREATE ${temp} /* ; END; */ TRIGGER "end;name" AFTER INSERT ON t BEGIN UPDATE t SET n=2; END; INSERT INTO t VALUES(1)`;
      expect(SplitSQLiteStatements(sql)).toHaveLength(3);
      ExecuteSQLiteScript(d, sql);
      expect(d.query("SELECT n FROM t").get()).toEqual({ n: 2 });
    } finally {
      d.close();
    }
  }
  expect(SplitSQLiteStatements(";--only;comment\n/*'quote;*/;;")).toEqual([]);
});

test("unterminated quoted tokens/comments/triggers and NUL reject BEFORE executing the first valid statement", () => {
  for (const bad of [
    "'unfinished",
    '"unfinished',
    "`unfinished",
    "[unfinished",
    "/*unfinished",
    "CREATE TRIGGER nope AFTER INSERT ON t BEGIN SELECT 1;",
    "\0",
  ]) {
    const d = new Database(":memory:");
    try {
      expect(() =>
        ExecuteSQLiteScript(d, "CREATE TABLE t(n INTEGER);" + bad),
      ).toThrow();
      expect(
        d.query("SELECT name FROM sqlite_master WHERE name='t'").all(),
      ).toEqual([]);
    } finally {
      d.close();
    }
  }
});

test("intermediate ALTER RENAME error is NOT masked by later valid SQL; one ROOT transaction rolls back DDL, rows and version together", () => {
  const d = new Database(":memory:");
  try {
    d.exec(
      "CREATE TABLE t(a INTEGER,b INTEGER,nAttr2 INTEGER);INSERT INTO t VALUES(1,2,3);PRAGMA user_version=5",
    );
    const sql =
      "ALTER TABLE t RENAME COLUMN a TO SN; UPDATE t SET SN=99;ALTER TABLE t RENAME COLUMN b TO nAttr2;ALTER TABLE t RENAME COLUMN nAttr2 TO last;PRAGMA user_version=6";
    expect(() =>
      d.transaction(() => ExecuteSQLiteScript(d, sql)).immediate(),
    ).toThrow("duplicate");
    expect(d.query("PRAGMA user_version").get()).toEqual({ user_version: 5 });
    expect(d.query("SELECT * FROM t").get()).toEqual({ a: 1, b: 2, nAttr2: 3 });
    expect(d.inTransaction).toBe(false);
  } finally {
    d.close();
  }
});

test("executor never owns/commits an outer transaction; caller may roll back after an otherwise successful complete script", () => {
  const d = new Database(":memory:");
  try {
    d.exec("BEGIN IMMEDIATE");
    ExecuteSQLiteScript(
      d,
      "CREATE TABLE t(n INTEGER);INSERT INTO t VALUES(1);",
    );
    expect(d.inTransaction).toBe(true);
    d.exec("ROLLBACK");
    expect(
      d.query("SELECT name FROM sqlite_master WHERE name='t'").all(),
    ).toEqual([]);
  } finally {
    d.close();
  }
});

test("ALL SIX real repository migrations execute with individually prepared statements including complete immutable/closure triggers", () => {
  const d = new Database(":memory:");
  try {
    for (const name of [
      "001_Initial",
      "002_GameResult",
      "003_MoneyPickup",
      "004_HouseClaim",
      "005_SpecialItemUse",
      "006_UserItemCatalog",
    ]) {
      const sql = readFileSync(`Common/DB/Migrations/${name}.sql`, "utf8");
      expect(SplitSQLiteStatements(sql).length).toBeGreaterThan(0);
      d.transaction(() => ExecuteSQLiteScript(d, sql)).immediate();
    }
    expect(d.query("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    expect(
      d
        .query("PRAGMA table_info(FxItem)")
        .all()
        .map((r: any) => r.name),
    ).toEqual([
      "SN",
      "Category",
      "strAttr",
      "nAttr1",
      "nAttr2",
      "nAttr3",
      "strName",
    ]);
    expect(
      d
        .query(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name='RuntimeSpecialItemUse_ClosedRound'",
        )
        .all(),
    ).toHaveLength(1);
  } finally {
    d.close();
  }
});
