/** Native source unit: CX/CxLogin/LocalUserTable.cpp. */
import { MakeLower } from "../core/MakeLower.ts";
import type { CUser } from "./User.ts";

/** CLocalUserTable — the login server's view of its logged-in users. */
export class CLocalUserTable {
  private byName = new Map<string, CUser>();
  private bySN = new Map<number, CUser>();

  /** CLocalUserTable::Insert */
  Insert(user: CUser): void {
    this.byName.set(MakeLower(user.GetName()), user);
    if (user.GetGlobalSerialNo() !== 0) this.bySN.set(user.GetGlobalSerialNo(), user);
  }

  /** CLocalUserTable::ExtractUser */
  ExtractUser(user: CUser): void {
    const key = MakeLower(user.GetName());
    if (this.byName.get(key) === user) this.byName.delete(key);
    if (this.bySN.get(user.GetGlobalSerialNo()) === user) this.bySN.delete(user.GetGlobalSerialNo());
  }

  /** CLocalUserTable::FindUserFromId */
  FindUserFromId(name: string): CUser | null {
    return this.byName.get(MakeLower(name)) ?? null;
  }

  /** CLocalUserTable::FindUserFromGlobalSerialNo */
  FindUserFromGlobalSerialNo(sn: number): CUser | null {
    return this.bySN.get(sn) ?? null;
  }
}
