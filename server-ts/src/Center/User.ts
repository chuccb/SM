/** Native source unit: CX/CxCenter/User.cpp. */
import { GetTickCount } from "../core/GetTickCount.ts";
import { CONNECTION_TIMEOUT_MS, SERVER_IDX_NONE } from "./Defs.ts";
import { SVRCLASS_GAME, SVRCLASS_LOGIN, SVRCLASS_SHOP } from "../protocol/CenterProtocol.ts";
import type { CLocalServer } from "./LocalServer.ts";
import type { CGlobalUserTable } from "./GlobalUserTable.ts";

/** Narrow port-side dependency replacing the native singleton lookups. */
export interface CenterUserContext {
  readonly globalUserTable: CGlobalUserTable;
  GetSvr(nServerClass: number, nSvrIdx: number): CLocalServer | null;
  GetSvrNo(nServerClass: number): number;
}

/** CGlobalUserTable entry (CUser of CxCenter, 0x74 bytes). */
export class CUser {
  m_strName: string;
  nSvrIdx: number;
  // Legacy port key also used by serialTable. Native global serial (+28) and
  // account SID (+80) are distinct; their allocation/protocol chain needs its
  // own audit, not an allocator change hidden inside timeout handling.
  nSID: number;
  nAuthencode = 0; // CUser::GetAuthencode / SetAuthenCode
  nLocalSerialNo: number; // the LS socket's local serial (p0 tail)
  nIP: number; // +32 — the CM 0 head D4: the client's in_addr (CUser::GetIP, CxCenter.exe.c:15124)
  nCommunitySvr = 0; // +76 (byte)
  nChannel = 0; // +60 (byte): the server class the user currently sits on
  nSessionIdx = 0; // legacy query field; native +64 is nSvrIdx (audit B)
  nConnectStamp: number; // +72 (DWORD); refreshed by successful CheckConnectingToSvr
  fFree = 0; // +20 (CSafeObject: freed by SetFree)
  m_fConnecting = 0; // +68 (DWORD); descriptive TS name for the native flag

  constructor(
    strName: string,
    nServerClass: number,
    nSvrIdx: number,
    nSN: number,
    nLocalSerialNo: number,
    nIP: number,
    man?: CenterUserContext,
  ) {
    this.m_strName = strName;
    this.nSvrIdx = SERVER_IDX_NONE; // +64 sentinel before the ctor's SetSvrIdx
    this.nSID = nSN;
    this.nLocalSerialNo = nLocalSerialNo;
    this.nIP = nIP;
    // CUser::CUser (00415640) runs SetSvrIdx — the ctor's move
    // carries the Inc/DecConn bookkeeping.  (Tests may skip the table move
    // by omitting the manager.)
    if (man) this.SetSvrIdx(nServerClass, nSvrIdx, man);
    else {
      this.nChannel = nServerClass;
      this.nSvrIdx = nSvrIdx;
    }
    this.nConnectStamp = GetTickCount();
  }

  GetAuthencode(): number {
    return this.nAuthencode;
  }

  /** CUser::SetAuthenCode */
  SetAuthenCode(code: number): void {
    if (this.nAuthencode !== 1) this.nAuthencode = code;
  }

  /**
   * CUser::CheckConnectingToSvr (004153B0) — the full gate: a
   * freed user, a second request while still connecting and a re-enter of
   * the currently attached server all answer 0 with their report; the index
   * must sit inside the type's configured count ("unregistered"); the
   * target must have a live socket ("shutdown"); and the enterable-type-41
   * premium branch answers 2 unless the user carries the LS premium ticket.
   */
  CheckConnectingToSvr(man: CenterUserContext, nServerType: number, SmallLoadedSvrIdx: number): number {
    if (this.fFree !== 0) {
      console.error("[Center] Set-freed user try to connect to selected server");
      return 0;
    }
    if (this.m_fConnecting !== 0) {
      console.error("[Center] User try to connect to selected server twice");
      return 0;
    }
    if (this.nSvrIdx === SmallLoadedSvrIdx && this.nChannel === nServerType) {
      console.error("[Center] User try to connect to currect connected server again");
      return 0;
    }
    const count = man.GetSvrNo(nServerType);
    if (
      SmallLoadedSvrIdx < 0 ||
      (nServerType !== SVRCLASS_LOGIN && nServerType !== SVRCLASS_GAME && nServerType !== SVRCLASS_SHOP) ||
      SmallLoadedSvrIdx >= count
    ) {
      console.error("[Center] User try to connect to unregistered server");
      return 0;
    }
    const svr = man.GetSvr(nServerType, SmallLoadedSvrIdx);
    if (!svr || svr.socket === null) {
      console.error("[Center] User try to connect to shutdown server");
      return 0;
    }
    // the enterable-type-41 premium gate: CUser+56 is the LS premium ticket
    if (svr.nType === 41 && this.nAuthencode !== 1) return 2;
    // The check itself arms the deadline (00415512..00415520). A later
    // member's refusal does not undo this flag, even when no move follows.
    this.m_fConnecting = 1;
    this.nConnectStamp = GetTickCount();
    return 1;
  }

  /** CUser::SetSvrIdx (00415340) — move the user and the
   *  conn counters; no connecting bookkeeping. */
  SetSvrIdx(nServerType: number, SmallLoadedSvrIdx: number, man: CenterUserContext): void {
    const oldSvr = man.GetSvr(this.nChannel, this.nSvrIdx);
    if (oldSvr) oldSvr.nConnNo--; // CLocalServer::DecConn
    this.nSvrIdx = SmallLoadedSvrIdx;
    this.nChannel = nServerType;
    const newSvr = man.GetSvr(nServerType, SmallLoadedSvrIdx);
    if (newSvr) newSvr.nConnNo++; // CLocalServer::IncConn
  }

  /** CUser::SetConnectingToSvr (00415540) — move and enqueue the serial.
   * The preceding successful check, NOT this method, sets flag/time. */
  SetConnectingToSvr(nServerType: number, SmallLoadedSvrIdx: number, man: CenterUserContext): void {
    this.SetSvrIdx(nServerType, SmallLoadedSvrIdx, man);
    man.globalUserTable.InsertConnectingList(this.nSID);
  }

  /**
   * CUser::CheckConnectionEstablished (00415570) — the
   * connecting state must match the server that reported in; SetConnecting
   * already moved nChannel/nSvrIdx, so the match reads the live fields.
   */
  CheckConnectionEstablished(nServerType: number, SmallLoadedSvrIdx: number): number {
    if (this.fFree !== 0) {
      console.error("[Center] Set-Freed user connected to server");
      return 0;
    }
    if (this.m_fConnecting !== 0) {
      if (nServerType === this.nChannel && SmallLoadedSvrIdx === this.nSvrIdx) return 1;
      if (SmallLoadedSvrIdx !== this.nSvrIdx) console.error("[Center] User connected to server mismatched");
      return 0;
    }
    console.error("[Center] User who is not connection state, try to notify connection established message");
    return 0;
  }

  /** CUser::SetConnectionEstablished — clears the connecting state (+68). */
  SetConnectionEstablished(): void {
    this.m_fConnecting = 0;
  }

  /** CUser::DeferDisconnectTimeout — 0x445C ms without the established call. */
  DeferDisconnectTimeout(man: CenterUserContext): boolean {
    if (this.m_fConnecting === 0) return false;
    if (((GetTickCount() - this.nConnectStamp) >>> 0) > CONNECTION_TIMEOUT_MS) {
      this.SetFree(man);
      return true;
    }
    return false;
  }

  /** CUser::SetFree */
  SetFree(man: CenterUserContext): void {
    if (this.fFree === 0) {
      this.fFree = 1;
      const svr = man.GetSvr(this.nChannel, this.nSvrIdx);
      if (svr) svr.nConnNo--; // CLocalServer::DecConn
      this.nSvrIdx = SERVER_IDX_NONE;
    }
  }
}
