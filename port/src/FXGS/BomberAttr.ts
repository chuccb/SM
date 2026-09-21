/** CBomberAttr. Native source unit: FX/common/BomberAttr.cpp. */
import { CData } from "./IDFMan.ts";

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
