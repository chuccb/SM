/**
 * Port-only Bun module-cycle adapter for CClientSocket pool routing.
 * Native code reaches both singleton pools directly; this tiny registry keeps
 * the same ownership without making lower-level source units import the pool
 * implementations during ESM initialization.
 */
import type { CReceivedPacket, CSendPacket } from "../../core/Packet.ts";
import type { CClientSocket } from "../ClientSocket.ts";
import type { CUser } from "../User.ts";

export interface ClientSocketPool {
  DeleteSocket(socket: CClientSocket): number;
  OnPacket?(packet: CReceivedPacket, socket: CClientSocket): void;
  OnCenterResConnEstablished?(packet: CReceivedPacket): void;
  OnCenterResConnectToSvr?(packet: CReceivedPacket): void;
  CreateSocketList?(poolType: number): CClientSocket[];
  SendAll?(packet: CSendPacket, lobbyOnly: number): void;
  UpdateRankList?(user: CUser): void;
}

type GameSlotInfoWriter = (packet: CSendPacket, user: CUser | null) => void;

let connectPool: ClientSocketPool | null = null;
let channelPool: ClientSocketPool | null = null;
let gameSlotInfoWriter: GameSlotInfoWriter | null = null;

export function RegisterConnectPool(pool: ClientSocketPool): void {
  connectPool = pool;
}

export function RegisterChannelPool(pool: ClientSocketPool, writer?: GameSlotInfoWriter): void {
  channelPool = pool;
  if (writer) gameSlotInfoWriter = writer;
}

export function GetClientSocketPool(poolType: number): ClientSocketPool | null {
  return poolType === 0 ? connectPool : channelPool;
}

export function DispatchClientPacket(packet: CReceivedPacket, socket: CClientSocket): void {
  GetClientSocketPool(socket.m_nPoolType)?.OnPacket?.(packet, socket);
}

export function DispatchConnectCenterResponse(packet: CReceivedPacket): void {
  connectPool?.OnCenterResConnEstablished?.(packet);
}

export function DispatchChannelCenterResponse(packet: CReceivedPacket): void {
  channelPool?.OnCenterResConnectToSvr?.(packet);
}

export function CreateChannelSocketList(poolType: number): CClientSocket[] | null {
  return channelPool?.CreateSocketList?.(poolType) ?? null;
}

export function SendChannelPacket(packet: CSendPacket, lobbyOnly: number): void {
  channelPool?.SendAll?.(packet, lobbyOnly);
}

export function UpdateChannelRankList(user: CUser): void {
  channelPool?.UpdateRankList?.(user);
}

export function WriteGameSlotInfo(packet: CSendPacket, user: CUser | null): void {
  gameSlotInfoWriter?.(packet, user);
}
