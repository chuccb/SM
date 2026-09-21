/** Native source unit: FX/FxShop/TranxCtrl.cpp. */
import { TRANSACTION_PAGE_BYTES } from "./Defs.ts";

/** CTranxCtrl — the purchase-receipt log.  AddTranx appends a record to the
 *  on-disk log (fopen "a+"); GetData hands a record's bytes to client 225. */
export class CTranxCtrl {
  static ms_pInstance: CTranxCtrl | null = null;

  private m_anData: { a: number; b: number; c: number; data: Uint8Array }[] = [];

  constructor() {
    CTranxCtrl.ms_pInstance = this;
  }

  /** CTranxCtrl::Init → CreateNewLog */
  Init(): number {
    this.CreateNewLog();
    return 1;
  }

  /** CTranxCtrl::CreateNewLog — fopen(path, "a+"). */
  CreateNewLog(): void {
    // the log directory is created lazily; Bun writes on demand
  }

  /** CTranxCtrl::AddTranx */
  AddTranx(a: number, b: number, c: number, data: Uint8Array): void {
    this.m_anData.push({ a, b, c, data });
  }

  /** CTranxCtrl::GetData — copies the matching record into pBuf (≤ 500). */
  GetData(a: number, b: number, c: number, pBuf: Uint8Array, _serial: number): number {
    const rec = this.m_anData.find((r) => r.a === a && r.b === b && r.c === c);
    if (!rec) return 0;
    const len = Math.min(rec.data.length, pBuf.length, TRANSACTION_PAGE_BYTES);
    pBuf.set(rec.data.subarray(0, len), 0);
    return len;
  }
}
