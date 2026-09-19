/**
 * seed — create a login account through the production path
 * (CDBMan.prCreateUser, i.e. exactly what the client's in-game registration
 * writes: FxUserAccount + FxUserDynamic + TxUserDynamic, password stored as
 * EncodePassword(plain)).
 *
 *   bun tools/seed.ts <account> <password> [name]
 *
 * The row lands in port/db/UserInfoNN.db with NN = GetUserHashNo(account)
 * (lower(first char) % 6), same sharding as the original CDBMan.
 */
import { join } from "node:path";
import { CDBMan, EncodePassword } from "../src/db/DBMan.ts";

// ── config mode: bun tools/seed.ts --config <multiSvrIp> <loginSvrIp> <port> ──
if (process.argv[2] === "--config") {
  const [, , , multiIp = "127.0.0.1", loginIp = "127.0.0.1", port = "3838"] = process.argv;
  const db = new CDBMan(join(import.meta.dir, "..", "db"));
  db.config.query("DELETE FROM CAMultiSvr").run();
  db.config.query("DELETE FROM CALoginSvr").run();
  db.config
    .query("INSERT INTO CAMultiSvr (SN, Name, IP, Param, Current) VALUES (1, ?, ?, 0, 1)")
    .run("BnB", multiIp);
  db.config
    .query("INSERT INTO CALoginSvr (SN, IP, Port, Flag) VALUES (1, ?, ?, 0)")
    .run(loginIp, Number(port));
  console.log(`CAMultiSvr: BnB @${multiIp} (Current=1); CALoginSvr: ${loginIp}:${port}`);
  process.exit(0);
}

const [id, pw, name] = process.argv.slice(2);
if (!id || !pw) {
  console.error("usage: bun tools/seed.ts <account> <password> [name] | --config [multiIp] [loginIp] [port]");
  process.exit(1);
}
const db = new CDBMan(join(import.meta.dir, "..", "db"));
const rc = db.prCreateUser(id, name ?? id, EncodePassword(pw), "", 0, 0, "", "", 0, "", "", "", "", "");
if (rc !== 0) {
  console.error(`failed to create '${id}' (already exists?)`);
  process.exit(1);
}
const shard = db.GetUserHashNo(id);
const acc = db.userInfo[shard]!
  .query("SELECT ID, SN, Name, Permission FROM FxUserAccount WHERE ID = ?")
  .get(id) as { ID: string; SN: number; Name: string; Permission: number };
console.log(`created: ID=${acc.ID} SN=${acc.SN} Name=${acc.Name} → db/UserInfo${String(shard).padStart(2, "0")}.db`);
