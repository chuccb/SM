/** Native source unit: FX/FxServer/GuildDynInfoCalculator.cpp. */
import { MAX_SESSION_SLOTS } from "./Defs.ts";
import { CGuildTable } from "./Guild.ts";

/**
 * CGuildDynInfoCalculator — the per-result guild accountant SendGameResult
 * builds fresh for every call (:36694, the ctor sets the vtbl and calls
 * Clear).  Eight-entry arrays keyed by guild index — the serials (+8), the
 * result bytes (+40: 0/1 win, 2 lose, 3 draw), the exp pot (+104) — and by
 * slot — the guild assignment (+72) plus two write-only bookkeeping arrays
 * (+136/+168); +4 is the guild count.  The strategy feeds one row per
 * seated user; OnGameResult turns it into the CGuild counter bumps and the
 * prUpdateGuildDynamic write-back (Flush, :16117).
 */
export class CGuildDynInfoCalculator {
  m_nGuildCount = 0; // +4
  m_argSerialNo = new Int32Array(MAX_SESSION_SLOTS); // +8 — the guild serials
  m_anResult = new Int32Array(MAX_SESSION_SLOTS); // +40 — 0/1 win, 2 lose, 3 draw
  m_anGuildIdx = new Int32Array(MAX_SESSION_SLOTS); // +72 — slot → guild index
  m_anExp = new Int32Array(MAX_SESSION_SLOTS); // +104
  m_anMember = new Int32Array(MAX_SESSION_SLOTS); // +136 — written, never read
  m_anMembers = new Int32Array(MAX_SESSION_SLOTS); // +168 — written, never read

  /** CGuildDynInfoCalculator::Clear (FxServer.exe.c:16000). */
  Clear(): void {
    this.m_nGuildCount = 0;
    this.m_argSerialNo.fill(0);
    this.m_anResult.fill(0);
    this.m_anGuildIdx.fill(0);
    this.m_anExp.fill(0);
    this.m_anMember.fill(0);
    this.m_anMembers.fill(0);
  }

  /** CGuildDynInfoCalculator::FindGuild (FxServer.exe.c:16028). */
  FindGuild(serial: number): number {
    for (let i = 0; i < this.m_nGuildCount; i++) {
      if (this.m_argSerialNo[i] === serial) return i;
    }
    return -1;
  }

  /** CGuildDynInfoCalculator::AddGuild (FxServer.exe.c:16047). */
  AddGuild(serial: number): number {
    const idx = this.m_nGuildCount++;
    this.m_argSerialNo[idx] = serial;
    this.m_anResult[idx] = 0;
    this.m_anExp[idx] = 0;
    this.m_anMembers[idx] = 0;
    return idx;
  }

  /** CGuildDynInfoCalculator::AddPlayer (FxServer.exe.c:16174) — the odd
   *  `--members` on the found branch is the original's; the counter has no
   *  reader anywhere in FXGS. */
  AddPlayer(slot: number, serial: number): void {
    this.m_anMember[slot] = 1;
    let guild = this.FindGuild(serial);
    if (guild === -1) guild = this.AddGuild(serial);
    else this.m_anMembers[guild]--;
    this.m_anGuildIdx[slot] = guild;
    this.m_anMembers[guild]++;
  }

  /** CGuildDynInfoCalculator::MarkPlayerResult (FxServer.exe.c:16012). */
  MarkPlayerResult(slot: number, n3: number): void {
    this.m_anResult[this.m_anGuildIdx[slot]!] = n3;
  }

  /** CGuildDynInfoCalculator::AddPlayerExp (FxServer.exe.c:16018). */
  AddPlayerExp(slot: number, exp: number): void {
    this.m_anExp[this.m_anGuildIdx[slot]!]! += exp;
  }

  /** CGuildDynInfoCalculator::IsWinGuild (FxServer.exe.c:16165). */
  IsWinGuild(serial: number): boolean {
    const guild = this.FindGuild(serial);
    return guild !== -1 && this.m_anResult[guild]! <= 1;
  }

  /** CGuildDynInfoCalculator::Flush (FxServer.exe.c:16117) — exp/20 into
   *  the guild row, the win/lose/draw counter switch (0/1 win, 2 lose,
   *  3 draw, 4 lose), then Clear. */
  Flush(): void {
    for (let i = 0; i < this.m_nGuildCount; i++) {
      const guild = CGuildTable.ms_pInstance?.FindGuildFromSerialNo(this.m_argSerialNo[i]! >>> 0);
      if (guild) {
        guild.IncExp(Math.trunc(this.m_anExp[i]! / 20));
        const result = this.m_anResult[i]!;
        if (result <= 1) guild.IncWin();
        else if (result === 3) guild.IncDraw();
        else if (result === 2 || result === 4) guild.IncLose();
      }
    }
    this.Clear();
  }
}
