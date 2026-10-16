import { expect, test } from "bun:test";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { CTextCodec } from "../Common/CTextCodec.ts";
import { CDBSession } from "../Common/DB/CDBSession.ts";
import { CDBMan } from "../LS/CDBMan.ts";
import { UpgradeLegacyUserItem } from "../Common/UserItem.ts";
import { CUserItemMan } from "../FXGS/CUserItemMan.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { Received } from "./helpers/Clients.ts";
function temporary() {
  mkdirSync(".analysis/tests", { recursive: true });
  return mkdtempSync(".analysis/tests/cli-");
}
function run(path: string, args: string[], stdin?: string) {
  return runRaw(["--db", path, ...args], stdin);
}
function runRaw(args: string[], stdin?: string) {
  const result = Bun.spawnSync(
    [process.execPath, "run", "Tools/Database.ts", ...args],
    {
      ...(stdin === undefined ? {} : { stdin: Buffer.from(stdin) }),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    code: result.exitCode,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
  };
}
test("real CLI: schema, stdin-only account/password management, signed money deltas and private DB mode", async () => {
  const dir = temporary();
  const path = `${dir}/CA.sqlite`;
  try {
    expect(run(path, ["init"]).code).toBe(0);
    const create = run(
      path,
      ["create-user", "TestUser", "--password-stdin"],
      "fixture-old\n",
    );
    expect(create.code).toBe(0);
    expect(JSON.parse(create.out).ID).toBe("TestUser");
    expect(create.out).not.toContain("fixture-old");
    expect(create.err).toBe("");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(run(path, ["money", "TestUser", "123"]).code).toBe(0);
    expect(run(path, ["money", "TestUser", "-124"]).code).toBe(1);
    expect(run(path, ["exp", "TestUser", "321"]).code).toBe(0);
    expect(
      run(
        path,
        ["set-password", "TestUser", "--password-stdin"],
        "fixture-new\r\n",
      ).code,
    ).toBe(0);
    const listed = run(path, ["list-users"]);
    expect(listed.code).toBe(0);
    const rows = JSON.parse(listed.out);
    expect(rows[0].Money).toBe(123);
    expect(rows[0].Exp).toBe(321);
    expect(listed.out).not.toContain("Password");
    const session = new CDBSession(path);
    try {
      const db = new CDBMan(session);
      expect(await db.InitUser("TestUser", "fixture-old")).toBeUndefined();
      expect(await db.InitUser("TestUser", "fixture-new")).toBeDefined();
    } finally {
      session.Close();
    }
    expect(run(path, ["check"]).code).toBe(0);
    expect(run(path, ["create-user", "MissingInput"]).code).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
test("real CLI: a malformed/duplicate FxItem import rolls back the complete batch; opaque columns survive", () => {
  const dir = temporary();
  const path = `${dir}/CA.sqlite`;
  const file = `${dir}/items.json`;
  // Synthetic test definition only, never shipped as actual official stock/pricing.
  const item = {
    ItemID: 123,
    Type: 4,
    TmplName: "Item/Fixture",
    OpaqueColumn3: -17,
    OpaqueColumn4: 0xffffffff,
    OpaqueColumn5: 9,
    Verbose: "fixture",
  };
  try {
    writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, kind: "FxItem", rows: [item, item] }),
    );
    expect(run(path, ["import-items", file]).code).toBe(1);
    let session = new CDBSession(path);
    try {
      expect(new CDBMan(session).GetUserItemList()).toEqual([]);
    } finally {
      session.Close();
    }
    writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, kind: "FxItem", rows: [item] }),
    );
    expect(run(path, ["import-items", file]).code).toBe(0);
    session = new CDBSession(path);
    try {
      const db = new CDBMan(session);
      expect(db.GetUserItemList()).toEqual([UpgradeLegacyUserItem(item)]);
      const packet = new CSendPacket(202);
      new CUserItemMan(db).PutUserItemList(packet);
      const p = Received(packet);
      expect(p.Decode1()).toBe(202);
      expect(p.Decode2()).toBe(1);
      expect(p.Decode4()).toBe(123);
      expect(p.Decode1()).toBe(4);
      expect(p.DecodeStr()).toBe("Item/Fixture");
      expect(p.Decode4()).toBe(-17 >>> 0);
      expect(p.Decode4()).toBe(0xffffffff);
      expect(p.Decode4()).toBe(9);
      expect(p.DecodeStr()).toBe("fixture");
      p.AssertEnd();
    } finally {
      session.Close();
    }
    writeFileSync(file, JSON.stringify({ rows: [item] }));
    expect(run(path, ["import-items", file]).code).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("real CLI: ban/unban and notice operate locally without exposing an HTTP admin API", async () => {
  const dir = temporary();
  const path = `${dir}/CA.sqlite`;
  try {
    expect(
      run(path, ["create-user", "A", "--password-stdin"], "fixture\n").code,
    ).toBe(0);
    expect(run(path, ["ban", "A", "forever"]).code).toBe(0);
    expect(run(path, ["notice", "maintenance"]).code).toBe(0);
    let session = new CDBSession(path);
    try {
      const db = new CDBMan(session);
      expect(await db.InitUser("A", "fixture")).toBeUndefined();
      expect(db.GetOption("Notice")).toBe("maintenance");
    } finally {
      session.Close();
    }
    expect(run(path, ["ban", "A", "off"]).code).toBe(0);
    session = new CDBSession(path);
    try {
      expect(await new CDBMan(session).InitUser("A", "fixture")).toBeDefined();
    } finally {
      session.Close();
    }
    expect(run(path, ["ban", "Absent", "forever"]).code).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);

test("real CLI: --config controls encoding/database, --db overrides it, malformed options fail before opening a DB", async () => {
  const dir = temporary();
  const configured = `${dir}/configured.sqlite`;
  const override = `${dir}/override.sqlite`;
  const configPath = `${dir}/Server.toml`;
  try {
    const template = readFileSync("Config/Server.toml", "utf8");
    expect(template).toContain('Database = "var/CA.sqlite"');
    expect(template).toContain('Encoding = "big5"');
    writeFileSync(
      configPath,
      template
        .replace(
          'Database = "var/CA.sqlite"',
          `Database = ${JSON.stringify(configured)}`,
        )
        .replace('Encoding = "big5"', 'Encoding = "utf8"'),
    );
    for (const options of [
      ["--config"],
      ["--db"],
      ["--db", override, "--db", override, "init"],
      ["--config", configPath, "--config", configPath, "init"],
      ["--unknown", override, "init"],
      ["--db", "--config", configPath, "init"],
    ]) {
      expect(runRaw(options).code).toBe(1);
      expect(existsSync(configured)).toBe(false);
      expect(existsSync(override)).toBe(false);
    }
    const created = runRaw(
      ["--config", configPath, "create-user", "UTF8User", "--password-stdin"],
      "fixture-🔐\n",
    );
    expect(created.code).toBe(0);
    expect(created.err).toBe("");
    expect(created.out).not.toContain("fixture-🔐");
    expect(existsSync(configured)).toBe(true);
    const session = new CDBSession(configured);
    try {
      const db = new CDBMan(session, new CTextCodec("utf8"));
      expect(await db.InitUser("UTF8User", "fixture-🔐")).toBeDefined();
    } finally {
      session.Close();
    }
    expect(
      runRaw(["--config", configPath, "--db", override, "init"]).code,
    ).toBe(0);
    const overridden = new CDBSession(override);
    try {
      expect(new CDBMan(overridden).ConfirmUnregisteredId("UTF8User")).toBe(0);
    } finally {
      overridden.Close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
