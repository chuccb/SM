/** CLocalUserTable, CGuild and CGuildTable — the server's user index and
 *  the lazily-loaded guild rows. */

import { MakeLower } from "../core/MakeLower.ts";
import { CDBMan } from "../db/DBMan.ts";
import { CUser } from "./User";

// ============================ CLocalUserTable ============================

/** CLocalUserTable — name (lowercased) and global-serial indexes. */
export class CLocalUserTable {
  static ms_pInstance: CLocalUserTable | null = null;

  private byName = new Map<string, CUser>();
  private bySN = new Map<number, CUser>();

  constructor() {
    CLocalUserTable.ms_pInstance = this;
  }

  /** CLocalUserTable::Insert — 1 on success (name keys are MakeLower'd). */
  Insert(user: CUser): number {
    const key = MakeLower(user.GetName());
    if (this.byName.has(key)) return 0;
    if (this.bySN.has(user.m_nGlobalSerialNo)) return 0;
    this.byName.set(key, user);
    this.bySN.set(user.m_nGlobalSerialNo, user);
    return 1;
  }

  /** CLocalUserTable::Remove — the original looks the name up first and
   *  operates on whatever sits under it, reporting whichever second lookup
   *  misses (:20311). */
  Remove(user: CUser): void {
    const key = MakeLower(user.GetName());
    const found = this.byName.get(key);
    if (!found) {
      console.error(`[GS] Remove failed (User Id:${user.GetName()})`);
      return;
    }
    this.byName.delete(key);
    if (this.bySN.get(found.m_nGlobalSerialNo) === found) {
      this.bySN.delete(found.m_nGlobalSerialNo);
    } else {
      console.error(`[GS] Remove failed (User GlobalSerialNo:${found.m_nGlobalSerialNo})`);
    }
  }

  /** CLocalUserTable::FindUserFromId */
  FindUserFromId(name: string): CUser | null {
    return this.byName.get(MakeLower(name)) ?? null;
  }

  /** CLocalUserTable::FindUserFromGlobalSerialNo */
  FindUserFromGlobalSerialNo(sn: number): CUser | null {
    return this.bySN.get(sn >>> 0) ?? null;
  }

  /** CLocalUserTable::ForEach — walks the table under the lock. */
  ForEach(fn: (user: CUser) => void): void {
    for (const user of [...this.bySN.values()]) fn(user);
  }
}

// ============================ CGuild / CGuildTable ============================

/** CGuild — FxGuildAccount as seen by the game server.  The dynamic block
 *  (:40E058..:16113): +88 win / +92 draw / +96 lose / +100 exp / +104 games
 *  / +108 dirty — IncExp skips the dirty mark, the other three set it. */
export class CGuild {
  m_nGuildSN = 0; // +56 (WriteGuildDynInfo's row key)
  strName = "";
  strMasterID = "";
  m_nMarkRevision = 0;
  m_nWin = 0; // +88
  m_nDraw = 0; // +92
  m_nLose = 0; // +96
  m_nExp = 0; // +100
  m_nGames = 0; // +104
  m_fModified = 0; // +108

  constructor(private db: CDBMan) {}

  /** CGuild::IncExp (:16106) — exp only, no dirty mark, no games bump. */
  IncExp(exp: number): void {
    this.m_nExp += exp;
  }

  /** CGuild::IncWin (:40E058). */
  IncWin(): void {
    this.m_nWin++;
    this.m_nGames++;
    this.m_fModified = 1;
  }

  /** CGuild::IncDraw (:40E07E). */
  IncDraw(): void {
    this.m_nDraw++;
    this.m_nGames++;
    this.m_fModified = 1;
  }

  /** CGuild::IncLose (:40E0A4). */
  IncLose(): void {
    this.m_nLose++;
    this.m_nGames++;
    this.m_fModified = 1;
  }

  /** CGuild::ResetDynamicInfo (:15531). */
  ResetDynamicInfo(): void {
    this.m_fModified = 0;
    this.m_nGames = 0;
    this.m_nLose = 0;
    this.m_nDraw = 0;
    this.m_nWin = 0;
    this.m_nExp = 0;
  }

  /** CGuild::DeferFlushModifiedInfo (:15579) — prUpdateGuildDynamic when
   *  forced (the table eviction) or every 10 games, and only when dirty. */
  DeferFlushModifiedInfo(fForce: number): void {
    if ((fForce !== 0 || this.m_nGames >= 10) && this.m_fModified !== 0) {
      if (this.db.prUpdateGuildDynamic(this.m_nGuildSN, this.m_nExp, this.m_nWin, this.m_nDraw, this.m_nLose) === 0) {
        this.ResetDynamicInfo();
      }
    }
  }
}

/** CGuildTable — lazily-loaded guilds. */
export class CGuildTable {
  static ms_pInstance: CGuildTable | null = null;

  private m_vtGuild = new Map<number, CGuild>();

  constructor(private db: CDBMan) {
    CGuildTable.ms_pInstance = this;
  }

  /** CGuildTable::Insert — prGetGuildSimpleInfo2; 0 when the row is absent. */
  Insert(value: number): number {
    if (this.m_vtGuild.has(value)) return 1;
    const r = this.db.prGetGuildSimpleInfo2(value);
    if (r.retval !== 0) {
      console.error("[GS] Fatal error: InitGuild failed from DB");
      return 0;
    }
    const g = new CGuild(this.db);
    g.m_nGuildSN = value;
    g.strName = r.Name;
    g.strMasterID = r.MasterID;
    g.m_nMarkRevision = r.MarkRevision;
    this.m_vtGuild.set(value, g);
    return 1;
  }

  /** CGuildTable::Remove (:40DA7E) — the eviction forces the dynamic-info
   *  flush (the original frees the object, whose SafeFree flushes). */
  Remove(value: number): void {
    const guild = this.m_vtGuild.get(value);
    if (guild) guild.DeferFlushModifiedInfo(1);
    this.m_vtGuild.delete(value);
  }

  /** CGuildTable::FindGuildFromSerialNo */
  FindGuildFromSerialNo(value: number): CGuild | null {
    return this.m_vtGuild.get(value) ?? null;
  }

  /** CGuildTable::ForEach (:25684) — the timer's flush sweep walks this. */
  ForEach(fn: (guild: CGuild) => void): void {
    for (const guild of [...this.m_vtGuild.values()]) fn(guild);
  }
}
