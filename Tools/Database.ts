import { readFileSync } from "node:fs";
import { CDBSession } from "../Common/DB/CDBSession.ts";
import { CDBMan } from "../LS/CDBMan.ts";
import { CServerConfig } from "../Common/CServerConfig.ts";
import { CTextCodec } from "../Common/CTextCodec.ts";
import { DecodeUserItemExport } from "../Common/UserItem.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";

const Help = `Usage: bun run db [--config path] [--db path] <command>
  init | check
  create-user ID --password-stdin
  set-password ID --password-stdin
  list-users [limit]
  money ID signed-delta
  exp ID absolute-exp
  ban ID until-unix-seconds|forever|off
  notice text
  import-items exported-FxItem.json
Password input is UTF-8 on stdin. One trailing newline is removed; never pass a password in argv.
Item import accepts {schemaVersion:2,kind:"FxItem",rows:[...]} native-named logical exports; version1 uses an explicit legacy alias adapter.
It does not restore .BAK/.DAT or fabricate shop stock/prices.`;
function number(value: string | undefined, min: number, max: number): number {
  if (!value || !/^-?\d+$/.test(value)) throw new Error("Expected integer");
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new Error(`Expected integer ${min}..${max}`);
  return n;
}
function passwordInput(): string {
  const input = readFileSync(0, "utf8").replace(/\r?\n$/, "");
  if (!input) throw new Error("Empty password on stdin");
  return input;
}
function requireArgs(args: readonly string[], n: number): void {
  if (args.length !== n) throw new Error(Help);
}
export async function DatabaseMain(
  input: readonly string[] = Bun.argv.slice(2),
): Promise<void> {
  const args = [...input];
  if (!args.length || args[0] === "--help") {
    console.log(Help);
    return;
  }
  let configPath = "Config/Server.toml";
  let overridePath: string | undefined;
  const seen = new Set<string>();
  while (args[0]?.startsWith("--")) {
    const option = args.shift()!;
    const value = args.shift();
    if (
      !["--config", "--db"].includes(option) ||
      seen.has(option) ||
      !value ||
      value.startsWith("--")
    )
      throw new Error(Help);
    seen.add(option);
    if (option === "--config") configPath = value;
    else overridePath = value;
  }
  const config = CServerConfig.Load(configPath);
  const path = overridePath ?? config.Runtime.Database;
  const command = args.shift();
  const session = new CDBSession(path);
  const db = new CDBMan(session, new CTextCodec(config.Runtime.Encoding));
  try {
    switch (command) {
      case "init":
        requireArgs(args, 0);
        session.IntegrityCheck();
        console.log("SQLite schema initialized");
        break;
      case "check":
        requireArgs(args, 0);
        session.IntegrityCheck();
        console.log("SQLite integrity / foreign keys: ok");
        break;
      case "create-user":
      case "set-password": {
        requireArgs(args, 2);
        if (args[1] !== "--password-stdin") throw new Error(Help);
        let password = passwordInput();
        try {
          if (command === "create-user") {
            const user = await db.RegisterNewUser({
              ID: args[0]!,
              Password: password,
            });
            console.log(
              JSON.stringify({
                SID: user.SID,
                ID: user.ID,
                UserHashNo: user.UserHashNo,
              }),
            );
          } else {
            await db.SetPassword(args[0]!, password);
            console.log("Password replaced with Argon2id hash");
          }
        } finally {
          password = "";
        }
        break;
      }
      case "list-users": {
        if (args.length > 1) throw new Error(Help);
        const limit = args.length ? number(args[0], 1, 1000) : 20;
        console.log(
          JSON.stringify(
            session.db
              .query(
                "SELECT a.SID,a.ID,d.Money,d.Exp,a.TotalConn,a.BannedUntil FROM FxUserAccount a JOIN FxUserDynamic d USING(ID) ORDER BY a.SID LIMIT ?",
              )
              .all(limit),
            null,
            2,
          ),
        );
        break;
      }
      case "money":
      case "exp": {
        requireArgs(args, 2);
        const id = args[0]!;
        db.ValidateID(id);
        const n = number(
          args[1],
          command === "money" ? -0x7fffffff : 0,
          0x7fffffff,
        );
        const changed =
          command === "money" ? db.SetMoney(id, n) : db.SetFxExp(id, n);
        if (!changed) throw new Error("Unknown user or value out of bounds");
        db.Audit(
          `cli:${command}`,
          db.GetUserInfo(id)!.SID,
          JSON.stringify({ value: n }),
        );
        console.log("Updated");
        break;
      }
      case "ban": {
        requireArgs(args, 2);
        db.ValidateID(args[0]!);
        const until =
          args[1] === "forever"
            ? -1
            : args[1] === "off"
              ? 0
              : number(args[1], 0, 0xffffffff);
        if (
          !session.db
            .query("UPDATE FxUserAccount SET BannedUntil = ? WHERE ID = ?")
            .run(until, args[0]!).changes
        )
          throw new Error("Unknown user");
        db.Audit(
          "cli:ban",
          db.GetUserInfo(args[0]!)!.SID,
          JSON.stringify({ until }),
        );
        console.log(
          "Ban updated (existing connections are not remotely managed)",
        );
        break;
      }
      case "notice":
        requireArgs(args, 1);
        db.text.AssertSize(args[0]!, 4096, "notice");
        db.SetOption("Notice", args[0]!);
        console.log("Notice saved; restart the service to reload");
        break;
      case "import-items": {
        requireArgs(args, 1);
        const raw = readFileSync(args[0]!);
        if (raw.length > RuntimePolicy.MaxSmartStreamBytes)
          throw new Error("Item export exceeds import limit");
        const items = DecodeUserItemExport(
          JSON.parse(raw.toString("utf8")),
          db.text,
        );
        session.db
          .transaction(() => {
            const insert = session.db.query(
              "INSERT INTO FxItem(SN,Category,strAttr,nAttr1,nAttr2,nAttr3,strName) VALUES (?,?,?,?,?,?,?)",
            );
            for (const r of items)
              insert.run(
                r.SN,
                r.Category,
                r.strAttr,
                r.nAttr1,
                r.nAttr2,
                r.nAttr3,
                r.strName,
              );
            db.Audit(
              "cli:import-FxItem",
              null,
              JSON.stringify({ rows: items.length }),
            );
          })
          .immediate();
        console.log(
          `Imported ${items.length} item definitions; NOT shop stock/prices`,
        );
        break;
      }
      default:
        throw new Error(Help);
    }
  } finally {
    session.Close();
  }
}
if (import.meta.main) {
  try {
    await DatabaseMain();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Database operation failed",
    );
    process.exitCode = 1;
  }
}
