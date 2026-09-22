/** Native source unit: CX/CxCenter/GlobalUserTable.cpp. */
import { MakeLower } from "../core/MakeLower.ts";
import { CONNECTING_LIST_BUCKET_COUNT } from "./Defs.ts";
import { CUser, type CenterUserContext } from "./User.ts";

/** Port-only Map adapter for the native table's MakeLower(name) key rule. */
class CaseInsensitiveUserMap extends Map<string, CUser> {
  override set(name: string, user: CUser): this {
    return super.set(MakeLower(name), user);
  }

  override get(name: string): CUser | undefined {
    return super.get(MakeLower(name));
  }

  override has(name: string): boolean {
    return super.has(MakeLower(name));
  }

  override delete(name: string): boolean {
    return super.delete(MakeLower(name));
  }
}

export class CGlobalUserTable {
  readonly userTable = new CaseInsensitiveUserMap();
  readonly serialTable = new Map<number, CUser>();
  m_nDailyPeakUsers = 0;
  private m_wDailyPeakDay = 0;
  private m_connectingLists: number[][] = Array.from(
    { length: CONNECTING_LIST_BUCKET_COUNT },
    () => [],
  );
  m_nSweepCounter = 0;

  constructor(private readonly host: CenterUserContext) {}

  /** CGlobalUserTable::AddNewUser (00408FA0).  Name insertion gates the
   * serial table; even a duplicate attempt still updates the local-day peak. */
  AddNewUser(user: CUser, now = new Date()): number {
    let added = 0;
    if (!this.userTable.has(user.m_strName)) {
      this.userTable.set(user.m_strName, user);
      if (!this.serialTable.has(user.nSID)) this.serialTable.set(user.nSID, user);
      added = 1;
    }
    this.UpdateDailyPeak(now);
    return added;
  }

  /** CGlobalUserTable::AddNewUser's local-day peak update.  The 2005
   * binary compares SYSTEMTIME.wDay (day of month), not a UTC timestamp. */
  UpdateDailyPeak(now = new Date()): void {
    const day = now.getDate();
    if (day !== this.m_wDailyPeakDay) {
      this.m_wDailyPeakDay = day;
      this.m_nDailyPeakUsers = 0;
    }
    if (this.userTable.size > this.m_nDailyPeakUsers)
      this.m_nDailyPeakUsers = this.userTable.size;
  }

  /** CGlobalUserTable::GetTotalSize. */
  GetTotalSize(): number {
    return this.userTable.size;
  }

  /** CGlobalUserTable::GetTotalPeakSize. */
  GetTotalPeakSize(): number {
    return this.m_nDailyPeakUsers;
  }

  /** CGlobalUserTable::DeleteAllUserOnSvr */
  DeleteAllUserOnSvr(nServerClass: number, nSvrIdx: number): void {
    for (const u of [...this.userTable.values()]) {
      if (u.nChannel === nServerClass && u.nSvrIdx === nSvrIdx) {
        u.SetFree(this.host);
        this.ExtractUser(u.nSID);
      }
    }
  }

  /** CGlobalUserTable::InsertConnectingList (00408360). */
  InsertConnectingList(serial: number): void {
    serial >>>= 0;
    this.m_connectingLists[serial % CONNECTING_LIST_BUCKET_COUNT]!.push(serial);
  }

  /** CGlobalUserTable::ExtractUser (00408640). List entries are removed
   * lazily by the sweep. Extraction alone does not call SetFree or send CM11. */
  ExtractUser(serial: number): CUser | undefined {
    const user = this.serialTable.get(serial);
    if (!user) return undefined;
    this.serialTable.delete(serial);
    this.userTable.delete(user.m_strName);
    return user;
  }

  /** CGlobalUserTable::DeleteConnectionTimeoutUser (00408940): increment
   * first, then sweep one unsigned-serial bucket (1,2,3,4,5,0). No DB hash. */
  DeleteConnectionTimeoutUser(): void {
    this.m_nSweepCounter = (this.m_nSweepCounter + 1) >>> 0;
    const index = this.m_nSweepCounter % CONNECTING_LIST_BUCKET_COUNT;
    const remove = new Set<number>();
    for (const serial of [...this.m_connectingLists[index]!]) {
      const user = this.serialTable.get(serial);
      if (!user) {
        remove.add(serial);
      } else if (user.DeferDisconnectTimeout(this.host)) {
        this.ExtractUser(serial);
        remove.add(serial);
      } else if (user.m_fConnecting === 0) {
        remove.add(serial);
      }
    }
    // Native list.remove erases every entry of each marked serial.
    this.m_connectingLists[index] = this.m_connectingLists[index]!.filter((serial) => !remove.has(serial));
  }
}
