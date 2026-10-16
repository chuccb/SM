import type { Database } from "bun:sqlite";

/** Modern trusted-migration utility, NOT an importer for supplied backup SQL.
 * SQLite scripts need quote/comment/CREATE TRIGGER boundaries, NOT split(';').
 * Ordinary CREATE [TEMP|TEMPORARY] TRIGGER BEGIN..END and nested CASE..END are
 * supported. No SQL is evaluated while splitting; reject unfinished lexical
 * constructs before executing even the first statement. This is deliberately
 * not a complete SQL grammar or an authorization boundary for untrusted SQL. */
export function SplitSQLiteStatements(sql: string): readonly string[] {
  if (sql.includes("\0")) throw new Error("NUL in SQLite migration script");
  const result: string[] = [],
    prefix: string[] = [];
  let start = 0,
    i = 0,
    meaningful = false,
    trigger = false,
    body = false,
    cases = 0;
  const word = (s: string) => {
    const upper = s.toUpperCase();
    meaningful = true;
    if (prefix.length < 3) {
      prefix.push(upper);
      trigger =
        prefix[0] === "CREATE" &&
        (prefix[1] === "TRIGGER" ||
          ((prefix[1] === "TEMP" || prefix[1] === "TEMPORARY") &&
            prefix[2] === "TRIGGER"));
    }
    if (trigger) {
      if (!body && upper === "BEGIN") body = true;
      else if (body) {
        if (upper === "CASE") cases++;
        else if (upper === "END") {
          if (cases) cases--;
          else body = false;
        }
      }
    }
  };
  const finish = (end: number) => {
    if (meaningful) result.push(sql.slice(start, end).trim());
    start = end;
    meaningful = false;
    trigger = false;
    body = false;
    cases = 0;
    prefix.length = 0;
  };
  while (i < sql.length) {
    const c = sql[i]!,
      next = sql[i + 1];
    if (c === "-" && next === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n" && sql[i] !== "\r") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) throw new Error("Unterminated SQLite block comment");
      i = end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      meaningful = true;
      i++;
      let ended = false;
      while (i < sql.length) {
        if (sql[i] === close) {
          if (c !== "[" && sql[i + 1] === close) {
            i += 2;
            continue;
          }
          i++;
          ended = true;
          break;
        }
        i++;
      }
      if (!ended) throw new Error("Unterminated SQLite quoted token");
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const at = i++;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i]!)) i++;
      word(sql.slice(at, i));
      continue;
    }
    if (c === ";" && !body) {
      finish(i + 1);
      i++;
      continue;
    }
    if (!/\s/.test(c) && c !== ";") meaningful = true;
    i++;
  }
  if (body || cases) throw new Error("Unterminated SQLite trigger body");
  finish(sql.length);
  return Object.freeze(result);
}

/** Bun1.4.3 exec(multiSQL) can mask an intermediate ALTER RENAME error if later
 * statements succeed. Prepare/run/finalize EACH statement so errors propagate
 * to the caller's ROOT transaction. This function does not start/commit one. */
export function ExecuteSQLiteScript(db: Database, sql: string): void {
  const statements = SplitSQLiteStatements(sql);
  for (const sql of statements) {
    const statement = db.prepare(sql);
    try {
      statement.run();
    } finally {
      statement.finalize();
    }
  }
}
