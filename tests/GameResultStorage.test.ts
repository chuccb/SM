import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CDBSession } from "../Common/DB/CDBSession.ts";
import { CDBMan, type GameResultSubmission } from "../FXGS/CDBMan.ts";
import { ResultSubmission, SeedResultUsers } from "./helpers/GameResult.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";
import vectors from "./fixtures/game-result-vectors.json";

function memory(input = ResultSubmission()) {
  const session = new CDBSession(":memory:"),
    db = new CDBMan(session);
  SeedResultUsers(db, input);
  return { session, db, input };
}
function data(db: CDBMan, input: GameResultSubmission) {
  return input.Changes.map((c) => {
    const u = db.GetUserInfo(c.Before.ID)!;
    return {
      ID: u.ID,
      Money: u.Money,
      Exp: u.Exp,
      Win: u.Win,
      Draw: u.Draw,
      Lose: u.Lose,
    };
  });
}
function receiptCount(db: CDBMan): number {
  return db.session.db
    .query<{ n: number }, []>("SELECT count(*) AS n FROM RuntimeGameResult")
    .get()!.n;
}

describe("FXGS result receipt / SQLite current schema (modern, not native storage parity)", () => {
  test("all valid frozen independent C++ packet/projection pairs commit and deduplicate", () => {
    for (const row of vectors.Cases) {
      const input = ResultSubmission(row);
      const hasNegativeCounter = input.Changes.some((c) =>
        [c.After.Win, c.After.Draw, c.After.Lose].some((v) => v < 0),
      );
      const { db, session } = memory(input);
      try {
        if (hasNegativeCounter) {
          expect(() => db.CommitGameResult(input)).toThrow();
          expect(data(db, input)).toEqual(input.Changes.map((c) => c.Before));
          expect(receiptCount(db)).toBe(0);
          continue;
        }
        expect(db.CommitGameResult(input)).toBe("committed");
        expect(db.CommitGameResult(input)).toBe("duplicate");
        expect(data(db, input)).toEqual(input.Changes.map((c) => c.After));
        const receipt = db.GetGameResultReceipt(input.RoundID)!;
        expect(receipt.RoundID).toBe(input.RoundID);
        expect(receipt.Digest).toMatch(/^[0-9a-f]{64}$/);
        expect(receipt.Packet.toString("hex")).toBe(row.Expected.Packet);
        expect(JSON.parse(receipt.Payload).Version).toBe(1);
        expect(receipt.CommittedAt).toBeGreaterThan(0);
        expect(receiptCount(db)).toBe(1);
      } finally {
        session.Close();
      }
    }
  });
  test("receipt digest/blob corruption is detected, not treated as a successful replay", () => {
    for (const field of ["Digest", "Packet"]) {
      const { session, db, input } = memory();
      try {
        db.CommitGameResult(input);
        // Deliberately simulate an operator/disk corruption after removing the
        // immutability guard; a SHA digest is NOT anti-administrator security.
        session.db.exec("DROP TRIGGER RuntimeGameResult_NoUpdate");
        if (field === "Digest")
          session.db
            .query("UPDATE RuntimeGameResult SET Digest=?")
            .run("0".repeat(64));
        else
          session.db
            .query("UPDATE RuntimeGameResult SET Packet=?")
            .run(Buffer.alloc(input.Packet.length));
        expect(() => db.GetGameResultReceipt(input.RoundID)).toThrow("Corrupt");
        expect(() => db.CommitGameResult(input)).toThrow("Corrupt");
        expect(data(db, input)).toEqual(input.Changes.map((c) => c.After));
      } finally {
        session.Close();
      }
    }
  });
  test("stale last player rolls back earlier updates and creates NO receipt", () => {
    const { session, db, input } = memory();
    try {
      const last = input.Changes.at(-1)!.Before;
      db.session.db
        .query("UPDATE FxUserDynamic SET Money=Money+1 WHERE ID=?")
        .run(last.ID);
      const before = data(db, input);
      expect(db.CommitGameResult(input)).toBe("conflict");
      expect(data(db, input)).toEqual(before);
      expect(db.GetGameResultReceipt(input.RoundID)).toBeUndefined();
      db.session.db
        .query("UPDATE FxUserDynamic SET Money=Money-1 WHERE ID=?")
        .run(last.ID);
      expect(db.CommitGameResult(input)).toBe("committed");
    } finally {
      session.Close();
    }
  });
  test("receipt INSERT failure rolls back every successful dynamic CAS", () => {
    const { session, db, input } = memory();
    try {
      session.db.exec(
        "CREATE TRIGGER FailResult BEFORE INSERT ON RuntimeGameResult BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END",
      );
      expect(() => db.CommitGameResult(input)).toThrow(
        "injected receipt failure",
      );
      expect(data(db, input)).toEqual(input.Changes.map((c) => c.Before));
      expect(receiptCount(db)).toBe(0);
      session.db.exec("DROP TRIGGER FailResult");
      expect(db.CommitGameResult(input)).toBe("committed");
    } finally {
      session.Close();
    }
  });
  test("canonical object/slot order deduplicates; detached receipt bytes cannot mutate SQL", () => {
    const { session, db, input } = memory();
    try {
      expect(db.CommitGameResult(input)).toBe("committed");
      const reordered = {
        ...input,
        Changes: input.Changes.toReversed().map((c) => ({
          ...c,
          Before: {
            Lose: c.Before.Lose,
            Draw: c.Before.Draw,
            Win: c.Before.Win,
            Exp: c.Before.Exp,
            Money: c.Before.Money,
            ID: c.Before.ID,
          },
          After: {
            Lose: c.After.Lose,
            Draw: c.After.Draw,
            Win: c.After.Win,
            Exp: c.After.Exp,
            Money: c.After.Money,
            ID: c.After.ID,
          },
        })),
      };
      expect(db.CommitGameResult(reordered)).toBe("duplicate");
      const receipt = db.GetGameResultReceipt(input.RoundID)!;
      receipt.Packet.fill(0);
      expect(db.GetGameResultReceipt(input.RoundID)!.Packet).toEqual(
        Buffer.from(input.Packet),
      );
      expect(() =>
        session.db
          .query("UPDATE RuntimeGameResult SET Digest=Digest WHERE RoundID=?")
          .run(input.RoundID),
      ).toThrow("immutable");
      expect(() =>
        session.db
          .query("DELETE FROM RuntimeGameResult WHERE RoundID=?")
          .run(input.RoundID),
      ).toThrow("immutable");
    } finally {
      session.Close();
    }
  });
  test("same key changed duration/room/packet cannot silently become a duplicate", () => {
    const { session, db, input } = memory();
    try {
      db.CommitGameResult(input);
      const changedPacket = Buffer.from(input.Packet);
      changedPacket[1] = changedPacket[1]! ^ 1; // still legal special-state byte
      for (const changed of [
        { ...input, ElapsedMilliseconds: input.ElapsedMilliseconds + 1 },
        { ...input, ChannelIndex: 1 },
        { ...input, SessionSerialNo: 92 },
        { ...input, Packet: changedPacket },
      ])
        expect(() => db.CommitGameResult(changed)).toThrow(
          "different submission",
        );
      expect(data(db, input)).toEqual(input.Changes.map((c) => c.After));
      expect(receiptCount(db)).toBe(1);
    } finally {
      session.Close();
    }
  });
  test("ABA restored account snapshots still cannot pay the same round again", () => {
    const { session, db, input } = memory();
    try {
      db.CommitGameResult(input);
      expect(
        db.UpdateUserDynamicBatch(
          input.Changes.map((c) => ({ Before: c.After, After: c.Before })),
        ),
      ).toBe(true);
      expect(db.CommitGameResult(input)).toBe("duplicate");
      expect(data(db, input)).toEqual(input.Changes.map((c) => c.Before));
      expect(receiptCount(db)).toBe(1);
    } finally {
      session.Close();
    }
  });
  test("invalid no-op / all-empty rounds also have immutable replay tombstones", () => {
    for (const name of ["single-invalid", "same-socket-invalid", "all-empty"]) {
      const row = vectors.Cases.find((r) => r.Name === name)!;
      expect(row).toBeDefined();
      const input = ResultSubmission(row);
      const { session, db } = memory(input);
      try {
        expect(db.CommitGameResult(input)).toBe("committed");
        expect(db.CommitGameResult(input)).toBe("duplicate");
        expect(data(db, input)).toEqual(input.Changes.map((c) => c.Before));
        expect(receiptCount(db)).toBe(1);
      } finally {
        session.Close();
      }
    }
  });
  test("all-five-field dynamic validation, identity and packet cross-checks fail closed", () => {
    const { session, db, input } = memory();
    const first = input.Changes[0]!;
    const replace = (c: typeof first): GameResultSubmission => ({
      ...input,
      Changes: [c, ...input.Changes.slice(1)],
    });
    const badPacket = Buffer.from(input.Packet);
    badPacket[0] = 0;
    try {
      const bad: GameResultSubmission[] = [
        { ...input, RoundID: "not-an-id" },
        { ...input, SessionIndex: 255 },
        { ...input, ChannelIndex: -1 },
        { ...input, StartTick: 0x1_0000_0000 },
        { ...input, ElapsedMilliseconds: 0.5 },
        { ...input, WinningColor: 8 },
        { ...input, Reason: "timeout" },
        { ...input, InvalidGame: true },
        { ...input, Packet: badPacket },
        { ...input, Packet: Buffer.from(input.Packet).subarray(0, -1) },
        { ...input, Changes: input.Changes.slice(1) },
        { ...input, Changes: [...input.Changes, first] },
        { ...input, CountedSlots: [1, 0] },
        { ...input, CountedSlots: [7] },
        { ...input, CountedSlots: [1, 2] },
        replace({ ...first, Before: { ...first.Before, ID: "x".repeat(17) } }),
        replace({
          ...first,
          After: { ...first.After, ID: first.After.ID.toLowerCase() },
        }),
        replace({
          ...first,
          After: { ...first.After, Money: first.After.Money + 1 },
        }),
        replace({ ...first, ExperienceDelta: -1 }),
        replace({ ...first, ExperienceDelta: 254 }),
        replace({ ...first, GlobalSerialNo: input.Changes[1]!.GlobalSerialNo }),
        replace({ ...first, Category: 99 }),
        replace({
          ...first,
          After: { ...first.After, Draw: first.After.Draw + 1 },
        }),
        replace({
          ...first,
          After: { ...first.After, Exp: first.After.Exp + 1 },
        }),
        replace({ ...first, After: { ...first.After, Win: -1 } }),
      ];
      for (const entry of bad) {
        expect(() => db.CommitGameResult(entry)).toThrow();
        expect(receiptCount(db)).toBe(0);
      }
      expect(data(db, input)).toEqual(input.Changes.map((c) => c.Before));
    } finally {
      session.Close();
    }
  });
  test("two connections + reopen keep one durable receipt, then a NEW round can commit", () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-result-receipt-")),
      path = join(dir, "users.sqlite");
    const input = ResultSubmission();
    let a: CDBSession | undefined, b: CDBSession | undefined;
    try {
      a = new CDBSession(path);
      b = new CDBSession(path);
      const da = new CDBMan(a),
        db = new CDBMan(b);
      SeedResultUsers(da, input);
      expect(da.CommitGameResult(input)).toBe("committed");
      expect(db.CommitGameResult(input)).toBe("duplicate");
      b.Close();
      b = undefined;
      a.Close();
      a = new CDBSession(path);
      const reopened = new CDBMan(a);
      expect(reopened.CommitGameResult(input)).toBe("duplicate");
      expect(receiptCount(reopened)).toBe(1);
      // New game with a new key and the prior exact starting state is distinct.
      expect(
        reopened.UpdateUserDynamicBatch(
          input.Changes.map((c) => ({ Before: c.After, After: c.Before })),
        ),
      ).toBe(true);
      expect(
        reopened.CommitGameResult({ ...input, RoundID: randomUUID() }),
      ).toBe("committed");
      expect(receiptCount(reopened)).toBe(2);
    } finally {
      b?.Close();
      a?.Close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("simultaneous independent Bun processes race on one key: one commit, one duplicate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-result-race-")),
      path = join(dir, "users.sqlite");
    const input = ResultSubmission();
    const session = new CDBSession(path);
    SeedResultUsers(new CDBMan(session), input);
    session.Close();
    const script = `import { CDBSession } from './Common/DB/CDBSession.ts';
      import { CDBMan } from './FXGS/CDBMan.ts';
      const [path, text] = process.argv.slice(1); const q=JSON.parse(text); q.Packet=Buffer.from(q.Packet,'hex');
      const s=new CDBSession(path); try { console.log(new CDBMan(s).CommitGameResult(q)); } finally { s.Close(); }`;
    const text = JSON.stringify({
      ...input,
      Packet: Buffer.from(input.Packet).toString("hex"),
    });
    const children = [0, 1].map(() =>
      Bun.spawn([process.execPath, "-e", script, path, text], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    try {
      const outputs = await Promise.all(
        children.map(async (p) => ({
          code: await p.exited,
          out: (await new Response(p.stdout).text()).trim(),
          error: await new Response(p.stderr).text(),
        })),
      );
      expect(outputs.map((r) => ({ code: r.code, error: r.error }))).toEqual([
        { code: 0, error: "" },
        { code: 0, error: "" },
      ]);
      expect(outputs.map((r) => r.out).sort()).toEqual([
        "committed",
        "duplicate",
      ]);
      const db = new CDBSession(path);
      try {
        expect(data(new CDBMan(db), input)).toEqual(
          input.Changes.map((c) => c.After),
        );
        expect(receiptCount(new CDBMan(db))).toBe(1);
      } finally {
        db.Close();
      }
    } finally {
      for (const p of children) {
        p.kill();
        await p.exited;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("simultaneous fresh/v1 open serializes migration INSIDE the immediate transaction", async () => {
    for (const version of [0, 1]) {
      const dir = mkdtempSync(join(tmpdir(), "sm-migration-race-")),
        path = join(dir, "users.sqlite");
      if (version === 1) {
        const old = new Database(path);
        old.exec(
          readFileSync(
            new URL("../Common/DB/Migrations/001_Initial.sql", import.meta.url),
            "utf8",
          ),
        );
        old.exec("PRAGMA user_version=1");
        old.close();
      }
      const script = `import { CDBSession } from './Common/DB/CDBSession.ts';
        const s=new CDBSession(process.argv[1]); try { s.IntegrityCheck();
        console.log(s.db.query('PRAGMA user_version').get().user_version); } finally { s.Close(); }`;
      const children = [0, 1].map(() =>
        Bun.spawn([process.execPath, "-e", script, path], {
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      try {
        const outputs = await Promise.all(
          children.map(async (p) => ({
            code: await p.exited,
            out: (await new Response(p.stdout).text()).trim(),
            error: await new Response(p.stderr).text(),
          })),
        );
        expect(outputs).toEqual([
          { code: 0, out: String(RuntimePolicy.SchemaVersion), error: "" },
          { code: 0, out: String(RuntimePolicy.SchemaVersion), error: "" },
        ]);
        const current = new CDBSession(path);
        try {
          expect(receiptCount(new CDBMan(current))).toBe(0);
          expect(() => current.IntegrityCheck()).not.toThrow();
        } finally {
          current.Close();
        }
      } finally {
        for (const p of children) {
          p.kill();
          await p.exited;
        }
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
  test("v1 upgrades without changing accounts, inventory, audit or dynamic values", () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-schema1-")),
      path = join(dir, "users.sqlite");
    try {
      const old = new Database(path);
      old.exec(
        readFileSync(
          new URL("../Common/DB/Migrations/001_Initial.sql", import.meta.url),
          "utf8",
        ),
      );
      old.exec(
        "PRAGMA user_version=1; INSERT INTO FxUserAccount(ID,UserHashNo,Password) VALUES('OldUser',0,'fixture'); INSERT INTO FxUserDynamic(ID,Money,Exp,Win,Draw,Lose,TicketDate) VALUES('OldUser',37,1200,7,8,9,123); INSERT INTO FxUserInventory(ID,ItemID,Amount) VALUES('OldUser',32,2); INSERT INTO RuntimeAudit(Action,Details) VALUES('fixture','preserve')",
      );
      const before = old.query("SELECT * FROM FxUserDynamic").all(),
        inventory = old.query("SELECT * FROM FxUserInventory").all();
      old.close();
      const session = new CDBSession(path);
      try {
        expect(session.db.query("PRAGMA user_version").get()).toEqual({
          user_version: RuntimePolicy.SchemaVersion,
        });
        expect(session.db.query("SELECT * FROM FxUserDynamic").all()).toEqual(
          before,
        );
        expect(session.db.query("SELECT * FROM FxUserInventory").all()).toEqual(
          inventory,
        );
        expect(
          session.db.query("SELECT Details FROM RuntimeAudit").get(),
        ).toEqual({ Details: "preserve" });
        expect(receiptCount(new CDBMan(session))).toBe(0);
        expect(() => session.IntegrityCheck()).not.toThrow();
      } finally {
        session.Close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("failed v1→v2 DDL rolls schema/version back; later correct upgrade works", () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-schema1-failure-")),
      path = join(dir, "users.sqlite");
    try {
      const old = new Database(path);
      old.exec(
        readFileSync(
          new URL("../Common/DB/Migrations/001_Initial.sql", import.meta.url),
          "utf8",
        ),
      );
      old.exec(
        "PRAGMA user_version=1; CREATE TABLE RuntimeGameResult (RoundID TEXT)",
      );
      old.close();
      expect(() => new CDBSession(path)).toThrow();
      const verify = new Database(path);
      expect(verify.query("PRAGMA user_version").get()).toEqual({
        user_version: 1,
      });
      expect(
        verify
          .query("SELECT name FROM sqlite_schema WHERE type='trigger'")
          .all(),
      ).toEqual([]);
      verify.exec("DROP TABLE RuntimeGameResult");
      verify.close();
      const good = new CDBSession(path);
      try {
        expect(() => good.IntegrityCheck()).not.toThrow();
      } finally {
        good.Close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
