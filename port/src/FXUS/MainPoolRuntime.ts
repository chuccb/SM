/**
 * Port-only ESM adapter for native CMainPool singleton/static calls made by
 * the CxUtil client socket and center-process source units.
 */
import type { CReceivedPacket, CSendPacket } from "../core/Packet.ts";
import type { CClientSocket } from "./ClientSocket.ts";
import type { CUser } from "./User.ts";

export interface UtilMainPoolPort {
  OnPacket(packet: CReceivedPacket, socket: CClientSocket): void;
  DelSocket(socket: CClientSocket): void;
  SendAll(packet: CSendPacket): void;
}

type UserDetailWriter = (user: CUser, account: string, userType: number, sessionIdx: number) => void;

let mainPool: UtilMainPoolPort | null = null;
let userDetailWriter: UserDetailWriter | null = null;

export function RegisterUtilMainPool(pool: UtilMainPoolPort | null, writer?: UserDetailWriter): void {
  mainPool = pool;
  if (writer) userDetailWriter = writer;
}

export function DispatchUtilClientPacket(packet: CReceivedPacket, socket: CClientSocket): void {
  mainPool?.OnPacket(packet, socket);
}

export function DeleteUtilSocket(socket: CClientSocket): void {
  mainPool?.DelSocket(socket);
}

export function BroadcastUtilPacket(packet: CSendPacket): void {
  mainPool?.SendAll(packet);
}

export function SendUtilUserDetail(user: CUser, account: string, userType: number, sessionIdx: number): void {
  userDetailWriter?.(user, account, userType, sessionIdx);
}
