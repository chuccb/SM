import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CDBMan, EncodePassword, GetUserHashNo } from "../../src/db/DBMan.ts";
import { BillingStore } from "../../src/LocalBilling/Store.ts";

const directory = mkdtempSync(join(tmpdir(), "sm-date-persistence-"));
const originalNow = Date.now;
const springBase = Date.parse("2026-03-07T17:00:00.000Z"); // noon EST
Date.now = () => springBase;
let db: CDBMan | undefined;
try {
  db = new CDBMan(directory);
  db.prCAAuthUser("dstuser", EncodePassword("testpw"));
  db.prAddInventoryShop("dstuser", 900, 901, 1, 1, 1, false);
  db.prSetPremiumTicket("dstuser", 1);
  const userShard = db.userInfo[GetUserHashNo("dstuser")]!;
  const inventoryShard = db.inventory[GetUserHashNo("dstuser")]!;
  const shopExpiry = inventoryShard
    .query<{ DateCreated: string }, []>("SELECT DateCreated FROM FxUserInventory WHERE UserID='dstuser' AND ItemSN=900")
    .get()!.DateCreated;
  const ticketExpiry = userShard
    .query<{ TicketDate: string }, []>("SELECT TicketDate FROM FxUserDynamic WHERE ID='dstuser'")
    .get()!.TicketDate;

  db.item.exec(`
    INSERT INTO FxItem(SN,Category,nAttr1) VALUES(300,1,0);
    INSERT INTO FxStock(SN,Category,ItemSN,Unit,Price,MoneyType,IsValid)
      VALUES(5000,1,300,1,100,0,1);
  `);
  const winterBase = Date.parse("2026-01-01T17:00:00.000Z"); // noon EST
  const store = new BillingStore(db, () => winterBase);
  store.authorize("dstuser", "testpw", "dstuser", 0);
  store.credit("dstuser", 100, "date-fixture");
  const held = store.reserve({ world: 0, name: "dstuser", serial: 77, stock: 5000, price: 100 });
  store.confirm(held.Reference, 0, 77, 5000, 0);
  const permanentExpiry = inventoryShard
    .query<{ DateCreated: string }, []>("SELECT DateCreated FROM FxUserInventory WHERE UserID='dstuser' AND ItemSN=300")
    .get()!.DateCreated;

  console.log(JSON.stringify({ shopExpiry, ticketExpiry, permanentExpiry }));
} finally {
  Date.now = originalNow;
  db?.Close();
  rmSync(directory, { recursive: true, force: true });
}
