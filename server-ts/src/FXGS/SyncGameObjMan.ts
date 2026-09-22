/** Native source unit: FX/FxServer/SyncGameObjMan.cpp. */
import { CReceivedPacket, CSendPacket, CipherDegree } from "../core/Packet.ts";
import { S2C_GamePacket } from "../core/protocol/PacketIDs.ts";
import { MAX_SESSION_SLOTS, SYNC_BEST_LOAD_INIT } from "./Defs.ts";
import type { CGameSession } from "./GameSession.ts";
import type { CClientSocket } from "./ClientSocket.ts";

const OBJECT_CREATE_COOLDOWN_MS = 5_000;
const SYNC_OBJECT_PAYLOAD_BYTES = 20;

/**
 * CSyncGameObjMan (+12788) — the synchronized-object ownership table.
 * A map objId → slot plus one per-slot set (FxServer.exe.c:415451).
 */
export class CSyncGameObjMan {
  m_mapObj = new Map<number, number>(); // +0 objId → slotidx
  m_rgSetObj = Array.from({ length: MAX_SESSION_SLOTS }, () => new Set<number>()); // +44
  m_pGameSession: CGameSession | null = null; // +140 (dword 35)
  m_nNextObjId = -1; // +144 (dword 36; ctor -1, Init 0)
  m_dwLastCreateTime = 0; // +148 (dword 37)

  /** CSyncGameObjMan::Init. */
  Init(session: CGameSession): void {
    for (const set of this.m_rgSetObj) set.clear();
    this.m_mapObj.clear();
    this.m_pGameSession = session;
    this.m_nNextObjId = 0;
    this.m_dwLastCreateTime = 0;
  }

  /** CSyncGameObjMan::OnGameEnd — drop the next-object id back to -1. */
  OnGameEnd(): void {
    this.m_nNextObjId = -1;
  }

  /** CSyncGameObjMan::Delegate — record objId under the owning slot. */
  Delegate(objId: number, slot: number): void {
    this.m_rgSetObj[slot]!.add(objId);
    this.m_mapObj.set(objId, slot);
  }

  /** CSyncGameObjMan::FindMinimumLoadSlotIdx — the socket-chief slot with the least objs. */
  FindMinimumLoadSlotIdx(): number {
    if (!this.m_pGameSession) {
      console.error("[GS] [CSyncGameObjMan::FindMinimumSlotIdx] m_pGameSession is NULL");
      return -1;
    }
    let best = -1;
    let bestLoad = SYNC_BEST_LOAD_INIT;
    for (let slot = 0; slot < MAX_SESSION_SLOTS; slot++) {
      const user = this.m_pGameSession.m_rgPlayer[slot];
      if (user && user.GetSelfidx() === 0 && this.m_rgSetObj[slot]!.size < bestLoad) {
        bestLoad = this.m_rgSetObj[slot]!.size;
        best = slot;
      }
    }
    if (best === -1) console.error("[GS] No player here??? .\\SyncGameObjMan.cpp(55)");
    return best;
  }

  /** CSyncGameObjMan::SetInitialObjNo — the initial 175s (tmpl+84 objects). */
  SetInitialObjNo(n: number): void {
    if (!this.m_pGameSession) {
      console.error("[GS] [CSyncGameObjMan::SetInitialObjNo] m_pGameSession is NULL");
      return;
    }
    this.m_nNextObjId = 0;
    for (let id = 0; id < n; id++) {
      const slot = this.FindMinimumLoadSlotIdx();
      if (slot === -1) {
        console.error(`[GS] FindMinimumLadSlotIdx returned -1 on Object id ${id}`);
        continue;
      }
      this.Delegate(id, slot);
      const packet = new CSendPacket(S2C_GamePacket.OnObjInitial, CipherDegree.kPacketEncryptedCRC8);
      packet.Encode2(id);
      packet.Encode1(slot);
      this.m_pGameSession.SendPacket(packet);
      this.m_nNextObjId++;
    }
  }

  /** CSyncGameObjMan::OnReqCreateObj — packet 158 → 174. */
  OnReqCreateObj(n: CReceivedPacket, _socket: CClientSocket): void {
    const session = this.m_pGameSession;
    if (!session) {
      console.error("[GS] [CSyncGameObjMan::OnReqCreateObj] m_pGameSession is NULL");
      return;
    }
    const elapsed = (session.m_GameClock.ElapsedTime() - session.m_GameClock.m_dwSuspended) >>> 0;
    if (elapsed < this.m_dwLastCreateTime + OBJECT_CREATE_COOLDOWN_MS) return;
    this.m_dwLastCreateTime = elapsed;
    const objType = n.Decode2();
    const buf = new Uint8Array(SYNC_OBJECT_PAYLOAD_BYTES);
    n.DecodeBufferAt(n.m_uOffset, buf, SYNC_OBJECT_PAYLOAD_BYTES);
    n.m_uOffset += SYNC_OBJECT_PAYLOAD_BYTES;
    const objId = this.m_nNextObjId;
    this.m_nNextObjId = objId + 1;
    const slot = this.FindMinimumLoadSlotIdx();
    if (slot === -1) {
      console.error("[GS] CSyncGameObjMan::OnReqCreateObj, FindMinimumLoadSlotIdx returned -1, cannot create obj");
      return;
    }
    this.Delegate(objId, slot);
    const packet = new CSendPacket(S2C_GamePacket.OnObjCreate, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode2(objId);
    packet.Encode1(slot);
    packet.Encode2(objType);
    packet.EncodeBuffer(buf, SYNC_OBJECT_PAYLOAD_BYTES);
    session.SendPacket(packet);
  }

  /** CSyncGameObjMan::OnReqDestroyObj — packet 159 → 176. */
  OnReqDestroyObj(n: CReceivedPacket, _socket: CClientSocket): void {
    const session = this.m_pGameSession;
    if (!session) {
      console.error("[GS] [CSyncGameObjMan::OnReqDestroyObj] m_pGameSession is NULL");
      return;
    }
    const objId = n.Decode2();
    if (!this.m_mapObj.has(objId)) return;
    const crc = n.Decode4();
    for (const set of this.m_rgSetObj) set.delete(objId);
    this.m_mapObj.delete(objId);
    const packet = new CSendPacket(S2C_GamePacket.OnObjDestroy, CipherDegree.kPacketEncryptedCRC8);
    packet.Encode2(objId);
    packet.Encode4(crc);
    session.SendPacket(packet);
  }

  /** CSyncGameObjMan::OnPlayerLeave — the leaver's objects vanish as 176 [E2 id][E4 0]. */
  OnPlayerLeave(slot: number): void {
    if (this.m_nNextObjId === -1) return;
    const session = this.m_pGameSession;
    if (!session) {
      console.error("[GS] [CSyncGameObjMan::OnPlayerLeave] m_pGameSession is NULL");
      return;
    }
    if (slot >= MAX_SESSION_SLOTS) {
      console.error(`[GS] .\\SyncGameObjMan.cpp(99) : Invalid slotidx, ${slot}`);
      return;
    }
    if (session.m_nCurPlayerNum !== 0) {
      for (const objId of [...this.m_rgSetObj[slot]!]) {
        if (!this.m_mapObj.has(objId)) {
          console.error(`[GS] Player has invalid obj, objId = ${objId}, session idx = ${session.m_nIdx}`);
        } else {
          this.m_mapObj.delete(objId);
        }
        const packet = new CSendPacket(S2C_GamePacket.OnObjDestroy, CipherDegree.kPacketEncryptedCRC8);
        packet.Encode2(objId);
        packet.Encode4(0);
        session.SendPacket(packet);
      }
      this.m_rgSetObj[slot]!.clear();
    }
  }
}
