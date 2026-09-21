/** Read-only source audit by default; explicit import never overwrites a
 * nonempty catalog. Run from port/, with the same --db as your services. */
import { resolve, join } from "node:path";
import { Database } from "bun:sqlite";
import { CAITEM_BAK_PATH, LoadCAItemBak } from "../src/db/CAItemBak.ts";
import { AuditCAItem, CatalogCounts, EnsureCAItemCatalog } from "../src/db/CAItemImport.ts";
const args = process.argv.slice(2).filter(a => a !== "--");
const command = args.shift() ?? "inspect";
try {
  if (!["inspect", "import"].includes(command)) throw new Error("Usage: bun tools/caitem.ts inspect|import [--db DIRECTORY] [--source CAItem.bak]");
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!["--db", "--source"].includes(flag) || options.has(flag) || !value || value.startsWith("--"))
      throw new Error(`Invalid or duplicate option: ${flag}; use --db DIRECTORY / --source FILE.`);
    options.set(flag, resolve(value));
  }
  const source = options.get("--source") ?? CAITEM_BAK_PATH;
  const dbDir = options.get("--db") ?? join(import.meta.dir, "../db");
  if (command === "inspect") {
    let destination;
    if (options.has("--db")) {
      const db = new Database(join(dbDir, "CAItem.db"), { readonly: true, create: false });
      try {
        destination = { path: join(dbDir, "CAItem.db"), rows: CatalogCounts(db),
          activeStocks: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM FxStock WHERE IsValid>0").get()!.n };
      } finally { db.close(); }
    }
    console.log(JSON.stringify({ source: { path: source, ...AuditCAItem(LoadCAItemBak(source)) }, destination }, null, 2));
  } else {
    const result = EnsureCAItemCatalog(dbDir, source);
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "existing-catalog") throw new Error("CAItem is nonempty. Refusing to merge or replace operator data; inspect and back up first.");
    console.log("Restart both GS and Shop to refresh their item/string/package caches. Prices come from backup FILE=1.");
  }
} catch (error) { console.error((error as Error).message); process.exitCode = 1; }
