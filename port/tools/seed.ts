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

const [id, pw, name] = process.argv.slice(2);
if (!id || !pw) {
  console.error("usage: bun tools/seed.ts <account> <password> [name]");
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
