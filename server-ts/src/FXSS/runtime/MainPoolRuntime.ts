/**
 * Port-only ESM adapter for native CMainPool singleton calls made by the
 * FXSS client socket and center-process source units.
 */
import type { CReceivedPacket } from "../../core/Packet.ts";
import type { CClientSocket } from "../ClientSocket.ts";
import type { CUserPool } from "../UserPool.ts";

export interface ShopMainPoolPort extends CUserPool {
  OnCenterResConnectToSvr(packet: CReceivedPacket): void;
  OnCenterResConnEstablished(packet: CReceivedPacket): void;
}

let mainPool: ShopMainPoolPort | null = null;

export function RegisterShopMainPool(pool: ShopMainPoolPort | null): void {
  mainPool = pool;
}

export function DispatchShopClientPacket(packet: CReceivedPacket, socket: CClientSocket): void {
  mainPool?.OnPacket(packet, socket);
}

export function DeleteShopSocket(socket: CClientSocket): void {
  mainPool?.DeleteSocket(socket);
}

export function DispatchShopConnectResponse(packet: CReceivedPacket): void {
  mainPool?.OnCenterResConnectToSvr(packet);
}

export function DispatchShopEstablishedResponse(packet: CReceivedPacket): void {
  mainPool?.OnCenterResConnEstablished(packet);
}

export function GetShopMainPool(): ShopMainPoolPort | null {
  return mainPool;
}
