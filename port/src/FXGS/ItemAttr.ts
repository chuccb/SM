/** CItemAttr. Native source unit: FX/FxServer/ItemAttr.cpp. */
import { CData } from "./IDFMan.ts";

/** CItemAttr (Attr/ItemAttr) — the box-item table OnRequestEatItem eats
 *  from and SendAirplaneItemProb resolves names through.  The file holds
 *  three header dwords, a ship section — [E4 id][E4 len][name][8 dwords],
 *  parsed by the official into a stride-104 table nothing reads back — and
 *  then the item records until EOF:
 *    [E4 len][name ≤63][E4 len][img ≤63][E4 weight +132][E4 +136]
 *    [E4 effect +140][E4 amount +144][4 dwords]
 *  (stride 164; effect 99 = the lucci/gem item, amount = its payout). */
export class CItemAttr {
  static ms_pInstance: CItemAttr | null = null;

  /** index → the decoded "Item/..." name (CItemAttr +12, stride 164). */
  m_vtName: string[] = [];
  /** entry+140 (dword 35) — the effect class (99 = the lucci/gem item). */
  m_vtEffect: number[] = [];
  /** entry+144 (dword 36) — the per-use amount (the lucci payout). */
  m_vtAmount: number[] = [];

  constructor() {
    CItemAttr.ms_pInstance = this;
  }

  /** CItemAttr::Load (FxServer.exe.c:17080).  A length violation stops the
   *  load keeping the records parsed so far (the original's `goto LABEL_2`;
   *  the boot ignores the return value).  The official SimpleCiphers every
   *  name into its 164-byte slot and decodes it again on each compare
   *  (GetItemidx); this data ships plain, so the port keeps the plain
   *  names — observably identical. */
  Load(): void {
    const cd = new CData();
    if (!cd.Load("Attr/ItemAttr")) return; // "Data File Not Found" — the table stays empty
    const data = cd.GetPtr()!;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const shipCount = dv.getUint32(8, true); // +42004 — the ship-section count
    let at = 12;
    for (let j = 0; j < shipCount; j++) {
      if (at + 8 > data.byteLength) return;
      const len = dv.getUint32(at + 4, true);
      if (len <= 0 || len >= 64) return;
      at += 8 + len + 32;
    }
    let idx = 0;
    let probOffset = 0; // the official fills a 32 KB prob table (+69660) no
    //                     instruction reads back — its 0x7FFF cap still
    //                     bounds the load, so the cursor stays
    while (at + 8 <= data.byteLength) {
      let len = dv.getUint32(at, true);
      at += 4;
      if (len <= 0 || len >= 64 || at + len + 4 > data.byteLength) return;
      this.m_vtName[idx] = new TextDecoder().decode(data.subarray(at, at + len)).replace(/\0.*$/, "");
      at += len;
      len = dv.getUint32(at, true); // the image name (CItemAttr+72) — no reader
      at += 4;
      if (len <= 0 || len >= 64 || at + len + 4 > data.byteLength) return;
      at += len;
      probOffset += dv.getInt32(at, true); // the weight (+132)
      this.m_vtEffect[idx] = dv.getInt32(at + 8, true); // +140
      this.m_vtAmount[idx] = dv.getInt32(at + 12, true); // +144
      at += 32;
      idx++;
      if (idx > 256 || probOffset > 0x7fff) return; // the official load caps
    }
  }

  /** CItemAttr::GetItemidx (FxServer.exe.c:16439) — both sides lose their
   *  "Item/Item" (9) or "Item/" (5) prefix, then the case-insensitive
   *  compare runs (the official decodes the stored name per compare; the
   *  port keeps them plain). */
  GetItemidx(name: string): number {
    const strip = (s: string): string => {
      const lower = s.toLowerCase();
      if (lower.startsWith("item/item")) return s.slice(9);
      if (lower.startsWith("item/")) return s.slice(5);
      return s;
    };
    const query = strip(name).toLowerCase();
    return this.m_vtName.findIndex((n) => strip(n).toLowerCase() === query);
  }
}
