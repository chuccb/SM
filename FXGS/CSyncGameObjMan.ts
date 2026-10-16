import { CSendPacket } from "../Common/CSendPacket.ts";
import type { CReceivedPacketBase } from "../Common/CReceivedPacketBase.ts";
import type { CClientSocket } from "../Common/CClientSocket.ts";
import type { CUser } from "../Common/CUser.ts";
import type { CTextCodec } from "../Common/CTextCodec.ts";
import { CProtocolError } from "../Common/CProtocolError.ts";
import { SessionLimit, SyncGameObjectRule } from "../Common/OfficialValues.ts";
import { ServerResponse } from "../Common/Protocol/PacketTypes.ts";
import type { CGameClock } from "./CGameClock.ts";

export interface SyncGameSession {
  readonly text: CTextCodec;
  readonly m_rgPlayer: readonly (CUser | undefined)[];
  GetPlayerNo(): number;
  GetGameClock(): CGameClock;
  SendPacket(packet: CSendPacket): void;
}
/** FXGS SyncGameObjMan.cpp @ 00414C13, 00414E39, 00415101..004155D8.
 * This delegates client-simulated objects. It is NOT an authoritative world-
 * simulation service or UDP authentication. The session owns phase validation. */
export class CSyncGameObjMan {
  private m_pGameSession: SyncGameSession | undefined;
  private readonly m_mapObj = new Map<number, number>();
  private readonly m_aPlayerObj = Array.from(
    { length: SessionLimit.Players },
    () => new Set<number>(),
  );
  private m_nNextObjNo: number = SyncGameObjectRule.Stopped;
  private m_dwLastCreateTime = 0;
  Init(session: SyncGameSession): void {
    this.m_pGameSession = session;
    this.m_mapObj.clear();
    for (const objects of this.m_aPlayerObj) objects.clear();
    this.m_nNextObjNo = 0;
    this.m_dwLastCreateTime = 0;
  }
  OnGameEnd(): void {
    this.m_nNextObjNo = SyncGameObjectRule.Stopped;
  }
  GetOwner(id: number): number | undefined {
    return this.m_mapObj.get(id);
  }
  GetObjectCount(): number {
    return this.m_mapObj.size;
  }
  FindMinimumLoadSlotIdx(): number {
    const session = this.m_pGameSession;
    if (!session) return -1;
    let best = -1;
    for (let slot = 0; slot < SessionLimit.Players; slot++) {
      const user = session.m_rgPlayer[slot];
      // Native deliberately excludes the second local player sharing a TCP peer.
      if (
        user?.GetSelfidx() === 0 &&
        (best < 0 ||
          this.m_aPlayerObj[slot]!.size < this.m_aPlayerObj[best]!.size)
      )
        best = slot;
    }
    return best;
  }
  Delegate(id: number, slot: number): void {
    this.AssertID(id);
    if (
      !Number.isInteger(slot) ||
      slot < 0 ||
      slot >= SessionLimit.Players ||
      this.m_pGameSession?.m_rgPlayer[slot]?.GetSelfidx() !== 0
    )
      throw new CProtocolError("Invalid synchronized-object controller");
    // The native callers allocate unique IDs. Reject accidental/crafted reuse,
    // rather than leaving an old owner's set inconsistent with the object map.
    if (this.m_mapObj.has(id))
      throw new CProtocolError("Duplicate synchronized object ID");
    this.m_aPlayerObj[slot]!.add(id);
    this.m_mapObj.set(id, slot);
  }
  SetInitialObjNo(count: number): void {
    if (
      !Number.isInteger(count) ||
      count < 0 ||
      count > SyncGameObjectRule.MaximumWireID + 1
    )
      throw new CProtocolError("Invalid initial synchronized-object count");
    const session = this.m_pGameSession;
    if (!session)
      throw new CProtocolError("Synchronized-object manager has no session");
    // Native DoStartGame calls Init immediately before this method. Enforce
    // that assumption before resetting the allocator, not halfway into a loop.
    if (this.m_mapObj.size)
      throw new CProtocolError(
        "Initialize synchronized objects before setting the initial count",
      );
    this.m_nNextObjNo = 0;
    for (let id = 0; id < count; id++) {
      const slot = this.FindMinimumLoadSlotIdx();
      if (slot < 0) continue; // native reports the absence; does not invent an owner
      this.Delegate(id, slot);
      session.SendPacket(
        new CSendPacket(ServerResponse.InitialGameObj, undefined, session.text)
          .Encode2(id)
          .Encode1(slot),
      );
      this.m_nNextObjNo++;
    }
  }
  private AssertID(id: number): void {
    if (
      !Number.isInteger(id) ||
      id < 0 ||
      id > SyncGameObjectRule.MaximumWireID
    )
      throw new CProtocolError("Synchronized-object ID exceeds wire field");
  }
  private AssertParticipant(socket: CClientSocket): SyncGameSession {
    const session = this.m_pGameSession;
    if (
      !session ||
      !session.m_rgPlayer.some((user) => user?.m_pClientSocket === socket)
    )
      throw new CProtocolError(
        "Synchronized-object sender is not in this session",
      );
    return session;
  }
  OnReqCreateObj(packet: CReceivedPacketBase, socket: CClientSocket): void {
    const session = this.AssertParticipant(socket);
    const template = packet.Decode2();
    const data = Buffer.from(
      packet.DecodeBuffer(SyncGameObjectRule.CreateDataBytes),
    );
    packet.AssertEnd();
    if (this.m_nNextObjNo === SyncGameObjectRule.Stopped) return;
    const clock = session.GetGameClock();
    // .lst 0041550A..0041551C uses sub/add then SIGNED jl. The clock
    // returns a DWORD, but this deadline comparison is signed int32.
    const time = (clock.ElapsedTime() - clock.m_dwTimeStopped) | 0;
    if (
      time <
      ((this.m_dwLastCreateTime +
        SyncGameObjectRule.CreateIntervalMilliseconds) |
        0)
    )
      return;
    this.AssertID(this.m_nNextObjNo);
    this.m_dwLastCreateTime = time;
    const id = this.m_nNextObjNo++;
    const slot = this.FindMinimumLoadSlotIdx();
    if (slot < 0) return;
    this.Delegate(id, slot);
    session.SendPacket(
      new CSendPacket(ServerResponse.CreateGameObj, undefined, session.text)
        .Encode2(id)
        .Encode1(slot)
        .Encode2(template)
        .EncodeBuffer(data),
    );
  }
  OnReqDestroyObj(packet: CReceivedPacketBase, socket: CClientSocket): void {
    const session = this.AssertParticipant(socket);
    const id = packet.Decode2();
    const reason = packet.Decode4();
    packet.AssertEnd();
    if (this.m_nNextObjNo === SyncGameObjectRule.Stopped) return;
    const owner = this.m_mapObj.get(id);
    if (owner === undefined) return;
    // Intentional policy: original accepts any session peer's destroy request;
    // this port requires the delegated controller's TCP peer to prevent forgery.
    if (session.m_rgPlayer[owner]?.m_pClientSocket !== socket)
      throw new CProtocolError(
        "Synchronized-object destroy from another controller",
      );
    for (const objects of this.m_aPlayerObj) objects.delete(id);
    this.m_mapObj.delete(id);
    session.SendPacket(
      new CSendPacket(ServerResponse.DestroyGameObj, undefined, session.text)
        .Encode2(id)
        .Encode4(reason),
    );
  }
  OnPlayerLeave(slot: number): void {
    if (!Number.isInteger(slot) || slot < 0 || slot >= SessionLimit.Players)
      throw new CProtocolError("Invalid leaving synchronized-object slot");
    const session = this.m_pGameSession;
    if (
      !session ||
      this.m_nNextObjNo === SyncGameObjectRule.Stopped ||
      !session.GetPlayerNo()
    )
      return;
    // std::set traversal is ascending, not JS insertion order.
    for (const id of [...this.m_aPlayerObj[slot]!].sort((a, b) => a - b)) {
      this.m_mapObj.delete(id);
      session.SendPacket(
        new CSendPacket(ServerResponse.DestroyGameObj, undefined, session.text)
          .Encode2(id)
          .Encode4(0),
      );
    }
    this.m_aPlayerObj[slot]!.clear();
  }
}
