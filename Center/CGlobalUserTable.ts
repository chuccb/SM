import { NormalizeID } from "../Common/CIDCompare.ts";
import { randomInt } from "node:crypto";
import type { _USERINFO } from "../Common/DB/Rows.ts";
import { CProtocolError } from "../Common/CProtocolError.ts";
import { CUser } from "./CUser.ts";

export class CGlobalUserTable {
  private readonly m_tblSN2User = new Map<number, CUser>();
  private readonly m_tblID2User = new Map<string, CUser>();
  FindUserFromId(id: string): CUser | undefined {
    return this.m_tblID2User.get(NormalizeID(id));
  }
  GetUser(sn: number): CUser | undefined {
    return this.m_tblSN2User.get(sn);
  }
  GetUserCount(): number {
    return this.m_tblSN2User.size;
  }
  Values(): IterableIterator<CUser> {
    return this.m_tblSN2User.values();
  }
  AddNewUser(info: _USERINFO): CUser {
    if (this.FindUserFromId(info.ID))
      throw new CProtocolError("Already connected", "already-connected");
    let sn: number;
    // Preserve u32 wire field, but do not make it predictably sequential like the old pool.
    do {
      sn = randomInt(1, 0x1_0000_0000);
    } while (this.m_tblSN2User.has(sn));
    const user = new CUser(info, sn);
    this.m_tblSN2User.set(sn, user);
    this.m_tblID2User.set(NormalizeID(info.ID), user);
    return user;
  }
  DeleteUser(user: CUser): void {
    if (this.GetUser(user.m_nGlobalSerialNo) !== user) return;
    // Terminal deletion, NOT source-socket detach during an in-process handoff.
    user.SetFree();
    this.m_tblSN2User.delete(user.m_nGlobalSerialNo);
    this.m_tblID2User.delete(NormalizeID(user.GetName()));
    user.m_pClientSocket = undefined;
    user.m_pendingConnection = undefined;
  }
}
