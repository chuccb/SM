/** The FxServer.idx/.idd item and bomber attributes. Map templates live in
 *  GameMap.ts and remain re-exported here for the game-server public API. */

import { CData } from "./CData.ts";
export { CGameMapTmpl, CGameMapTmplList } from "./GameMap.ts";

// ============================ game data tables ============================

/**
 * SimpleCipher (FxServer.exe.c:16189) — the self-inverse byte chain that
 * obfuscates the names inside Attr/ItemAttr: byte i is XORed with a key that
 * starts at 0xA5 and then becomes (key * (i+1) + key / (i+1)) & 0xFF.
 */
function SimpleCipher(buf: Uint8Array, n64: number): void {
  let key = 0xa5;
  for (let i = 0; i < n64; i++) {
    buf[i] = (buf[i] ^ key) & 0xff;
    key = (key * (i + 1) + Math.floor(key / (i + 1))) & 0xff;
  }
}

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

/** CBomberAttr (Attr/BomberAttr) — 296 bytes per bomber, FxServer.exe.c:54336. */
export interface BomberAttrEntry {
  strName: string; // +0 (Load also builds the +64 "_Display", +128 "_Portrait"
  // and +192 "_Emotion" copies; FXGS itself only reads the +192 one through
  // the never-called GetEmotionTmplName :54457)
  nAttr1: number; // +256 — != 0 marks a hidden bomber (Load bumps m_nHiddenCount)
  nCurrentSpeed: number; // +260 — the 109 "currentspeed" wire compare
  nAttr3: number; // +264
  nBombCount: number; // +268 — the 109 "bombcount" wire compare
  nAttr5Clamped: number; // +272 — clamped to 10 at load; no reader in FXGS
  nBombPower: number; // +276 — the 109 "bombpower" wire compare
  nAttr7: number; // +280
  nAttr8: number; // +284
  nAttr9: number; // +288
  nAttr10: number; // +292
}

export class CBomberAttr {
  static ms_pInstance: CBomberAttr | null = null;

  m_nTotalCount = 0; // +4 (GetTotalCount; GetRandomBomberIdx returns it too)
  m_nHiddenCount = 0; // +8 (GetNormalCount = TotalCount - HiddenCount)
  m_vtAttr: BomberAttrEntry[] = []; // 296-byte records from +12

  constructor() {
    CBomberAttr.ms_pInstance = this;
  }

  /** CBomberAttr::Load (0043084B): reset counts BEFORE attempting the load.
   * Bad record lengths retain only the complete prefix. Truncation is treated
   * as failure rather than reproducing an out-of-bounds native read. */
  Load(): boolean {
    this.m_nTotalCount = 0;
    this.m_nHiddenCount = 0;
    this.m_vtAttr = [];
    const cd = new CData();
    if (!cd.Load("Attr/BomberAttr")) return false;
    const data = cd.GetPtr()!;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let at = 0;
    while (at < data.byteLength) {
      if (at + 4 > data.byteLength) return false;
      const len = dv.getInt32(at, true);
      at += 4;
      // The official gate is 0 < len < 54, followed by ten signed dwords.
      // Derived _Emotion/_Display/_Portrait names are unused by FXGS.
      if (len <= 0 || len >= 54 || at + len + 40 > data.byteLength) return false;
      const name = Buffer.from(data.subarray(at, at + len)).toString("latin1").split("\0", 1)[0]!;
      at += len;
      const attr: BomberAttrEntry = {
        strName: name,
        nAttr1: dv.getInt32(at, true),
        nCurrentSpeed: dv.getInt32(at + 4, true),
        nAttr3: dv.getInt32(at + 8, true),
        nBombCount: dv.getInt32(at + 12, true),
        nAttr5Clamped: Math.min(dv.getInt32(at + 16, true), 10),
        nBombPower: dv.getInt32(at + 20, true),
        nAttr7: dv.getInt32(at + 24, true),
        nAttr8: dv.getInt32(at + 28, true),
        nAttr9: dv.getInt32(at + 32, true),
        nAttr10: dv.getInt32(at + 36, true),
      };
      at += 40;
      if (attr.nAttr1 !== 0) this.m_nHiddenCount++;
      this.m_nTotalCount++;
      this.m_vtAttr.push(attr);
    }
    return true;
  }

  GetNormalCount(): number {
    return this.m_nTotalCount - this.m_nHiddenCount;
  }

  GetTotalCount(): number {
    return this.m_nTotalCount;
  }

  GetRandomBomberIdx(): number {
    return this.m_nTotalCount;
  }

  /** CBomberAttr::IsValidSelectIdx — [0, NormalCount) plus the random index. */
  IsValidSelectIdx(idx: number): boolean {
    return (idx >= 0 && idx < this.GetNormalCount()) || idx === this.m_nTotalCount;
  }

  /**
   * The three attr reads of OnReadyForImmediateStart (:34441, v10 =
   * ms_pInstance + 296*idx, i.e. the record payload minus 12): the wire
   * bytes compare against record dwords 1 / 3 / 5 (+260/+268/+276).
   */
  GetCurrentSpeed(idx: number): number {
    return this.m_vtAttr[idx]?.nCurrentSpeed ?? 0;
  }

  GetBombCount(idx: number): number {
    return this.m_vtAttr[idx]?.nBombCount ?? 0;
  }

  GetBombPower(idx: number): number {
    return this.m_vtAttr[idx]?.nBombPower ?? 0;
  }
}
