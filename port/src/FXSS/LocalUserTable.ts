/** Native source unit: FX/FxShop/LocalUserTable.cpp. */
import { MakeLower } from "../core/MakeLower.ts";
import type { CUser } from "./User.ts";

/** CLocalUserTable — the name/serial indexes (name keys lowercased). */
export class CLocalUserTable {
  static ms_pInstance: CLocalUserTable | null = null;

  private byName = new Map<string, CUser>();
  private bySN = new Map<number, CUser>();

  constructor() {
    CLocalUserTable.ms_pInstance = this;
  }

  /** CLocalUserTable::Insert — 1 on success, 0 when the name/serial is taken. */
  Insert(user: CUser): number {
    const key = MakeLower(user.GetName());
    if (this.byName.has(key) || this.bySN.has(user.GetGlobalSerialNo())) return 0;
    this.byName.set(key, user);
    this.bySN.set(user.GetGlobalSerialNo(), user);
    return 1;
  }

  /** CLocalUserTable::Remove */
  Remove(user: CUser): void {
    this.byName.delete(MakeLower(user.GetName()));
    if (this.bySN.get(user.GetGlobalSerialNo()) === user) this.bySN.delete(user.GetGlobalSerialNo());
  }

  /** CLocalUserTable::FindUser */
  FindUser(name: string): CUser | null {
    return this.byName.get(MakeLower(name)) ?? null;
  }

  /** CLocalUserTable::FindUserFromGlobalSerialNo */
  FindUserFromGlobalSerialNo(sn: number): CUser | null {
    return this.bySN.get(sn) ?? null;
  }
}
