import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CDBMan } from "../db/DBMan.ts";
import { BillingError, LOCAL_BILLING_MODE, LOCAL_BILLING_MODE_KEY, type BillingConfig } from "./Defs.ts";

export function localBillingMarker(host: string, port: number): string { return `${LOCAL_BILLING_MODE}:${host}:${port}`; }
export function usesLocalBilling(db: CDBMan): boolean {
  const rows = db.GetBillingSvrs();
  return rows.length === 1 && rows[0].ip === "127.0.0.1" &&
    db.prGetStringAttr(LOCAL_BILLING_MODE_KEY).strVal === localBillingMarker(rows[0].ip, rows[0].port);
}
export const DEFAULT_BILLING_CONFIG = join(import.meta.dir, "../../config/local-billing.json");
export function loadBillingConfig(path = DEFAULT_BILLING_CONFIG): BillingConfig {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value.enabled !== "boolean" || value.host !== "127.0.0.1" ||
      !Number.isInteger(value.port) || value.port < 1 || value.port > 65535)
    throw new BillingError("Invalid local billing config: enabled boolean, host 127.0.0.1, port 1..65535 required.");
  return value;
}
/** Never redirect an operator's external billing endpoints automatically. */
export function canUseLocalBilling(db: CDBMan, config: BillingConfig): boolean {
  const rows = db.GetBillingSvrs();
  if (!config.enabled) return false;
  if (!rows.length) return true;
  return rows.length === 1 && rows[0].ip === config.host && rows[0].port === config.port &&
    usesLocalBilling(db);
}
/** Called only AFTER listen succeeds; a bind error must not leave a fake endpoint. */
export function registerLocalBilling(db: CDBMan, config: BillingConfig): void {
  db.config.transaction(() => {
    if (!canUseLocalBilling(db, config)) throw new BillingError("Refusing to overwrite an external billing configuration.");
    if (!db.GetBillingSvrs().length) db.config.query("INSERT INTO BillingSvr(SN,ip,port) VALUES(?,?,?)").run(0, config.host, config.port);
    db.config.query(`INSERT INTO BillingConfig(AttrID,strVal) VALUES(?,?)
      ON CONFLICT(AttrID) DO UPDATE SET strVal=excluded.strVal`).run(LOCAL_BILLING_MODE_KEY, localBillingMarker(config.host, config.port));
  }).immediate();
}
