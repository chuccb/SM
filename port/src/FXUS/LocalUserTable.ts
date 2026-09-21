/** Native source unit: CX/CxUtil/LocalUserTable.cpp. */
import { MakeLower } from "../core/MakeLower.ts";
import type { CUser } from "./User.ts";

/**
 * CLocalUserTable — lowercase-name map (+52) and the serial tree (+72).
 * Insert fails (returns 0) when the name is already resident.
 */
export class CLocalUserTable {
  static ms_pInstance: CLocalUserTable | null = null;

  private m_mapName = new Map<string, CUser>(); // keys are MakeLower'd names
  private m_mapSerial = new Map<number, CUser>(); // +72, FindUserFromGlobalSerialNo

  /** CLocalUserTable::Insert — 0 when the name is taken. */
  Insert(User: CUser): number {
    const key = MakeLower(User.GetName());
    if (this.m_mapName.has(key)) return 0;
    this.m_mapName.set(key, User);
    if (User.m_dwGlobalSerialNo !== 0) this.m_mapSerial.set(User.m_dwGlobalSerialNo, User);
    return 1;
  }

  /** CLocalUserTable::Remove (by the user's own name). */
  Remove(User: CUser): void {
    const key = MakeLower(User.GetName());
    this.m_mapName.delete(key);
    this.m_mapSerial.delete(User.m_dwGlobalSerialNo);
  }

  /** CLocalUserTable::FindUserFromGlobalSerialNo. */
  FindUserFromGlobalSerialNo(serial: number): CUser | null {
    return this.m_mapSerial.get(serial >>> 0) ?? null;
  }

  FindUserFromId(id: string): CUser | null {
    return this.m_mapName.get(MakeLower(id)) ?? null;
  }
}
