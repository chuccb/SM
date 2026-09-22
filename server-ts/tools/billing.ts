/** Offline operator CLI. No password/credit/reset endpoint is exposed over TCP. */
import { join, resolve } from "node:path";
import { CDBMan } from "../src/db/DBMan.ts";
import { BillingStore } from "../src/LocalBilling/Store.ts";

const [command, ...args] = process.argv.slice(2).filter(arg => arg !== "--");
function argument(name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
const account = argument("--account");
if (!account || !["credit", "balance"].includes(command)) {
  console.error("Usage: bun tools/billing.ts credit|balance --account ID [--amount INTEGER --reference UNIQUE-ID] [--db DIRECTORY]");
  process.exit(1);
}
const db = new CDBMan(resolve(argument("--db") ?? join(import.meta.dir, "../db")));
try {
  const store = new BillingStore(db);
  if (command === "credit") {
    const amount = Number(argument("--amount"));
    const reference = argument("--reference") ?? "";
    store.credit(account, amount, reference);
  }
  console.log(JSON.stringify(store.inspect(account), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Billing operation failed");
  process.exitCode = 1;
} finally { db.Close(); }
