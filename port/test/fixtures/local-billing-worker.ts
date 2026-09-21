/** Cross-process writer barrier: isolate settlement races from cold-start IO. */
import { CDBMan } from "../../src/db/DBMan.ts";
import { BillingStore } from "../../src/LocalBilling/Store.ts";
const db = new CDBMan(process.argv[2]);
const store = new BillingStore(db);
process.once("message", () => {
  try {
    const hold = store.reserve({ world: 0, name: "alice", serial: Number(process.argv[3]), stock: 5000, price: 100 });
    const result = store.confirm(hold.Reference, 0, hold.Serial, hold.Stock, 0);
    console.log(JSON.stringify({ state: result.State }));
  } catch (error) { console.log(JSON.stringify({ state: "refused", message: (error as Error).message })); }
  finally { db.Close(); process.disconnect?.(); }
});
process.send?.("ready");
