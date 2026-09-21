/** Native source unit: FX/FxServer/LocalUserTable.cpp. */
import { MakeLower } from "../core/MakeLower.ts";
import type { CUser } from "./User.ts";

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
