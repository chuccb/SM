/**
 * bakdump — print the CAMultiSvr / CALoginSvr rows parsed from the original
 * CAConfig backup (DB/CAConfig.bak).
 *
 *   bun tools/bakdump.ts [path-to-CAConfig.bak]
 */
import { LocateCAConfigBak, ParseCAConfigBak } from "../src/db/CAConfigBak.ts";

const path = process.argv[2] ?? LocateCAConfigBak();
if (!path) {
  console.error("CAConfig.bak not found");
  process.exit(1);
}
const rows = ParseCAConfigBak(new Uint8Array(await Bun.file(path).arrayBuffer()));
console.log(path);
console.log("CAMultiSvr:", JSON.stringify(rows.CAMultiSvr, null, 2));
console.log("CALoginSvr:", JSON.stringify(rows.CALoginSvr, null, 2));
