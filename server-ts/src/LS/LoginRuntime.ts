/**
 * Port-only ESM adapter for native singleton calls among CClientSocket,
 * CUser, CLoginPool, and CCenterProcess. The C++ units call each other's
 * TSingleton instances directly; this registry keeps their TS modules acyclic.
 */
import type { CReceivedPacket } from "../core/Packet.ts";
import type { CClientSocket } from "./ClientSocket.ts";
import type { CUser } from "./User.ts";

export interface LoginPoolPort {
  OnPacket(packet: CReceivedPacket, socket: CClientSocket): void;
  AddNewUser(user: CUser): number;
  DeleteUser(user: CUser): number;
  DelSocket(socket: CClientSocket): number;
  m_localUserTable: { ExtractUser(user: CUser): void };
}

export interface LoginCenterPort {
  UnregisterConnection(serial: number): void;
}

let loginPool: LoginPoolPort | null = null;
let loginCenter: LoginCenterPort | null = null;

export function RegisterLoginPool(pool: LoginPoolPort | null): void {
  loginPool = pool;
}

export function RegisterLoginCenter(center: LoginCenterPort | null): void {
  loginCenter = center;
}

export function DispatchLoginPacket(packet: CReceivedPacket, socket: CClientSocket): void {
  loginPool?.OnPacket(packet, socket);
}

export function AddLoginUser(user: CUser): number {
  return loginPool?.AddNewUser(user) ?? 0;
}

export function DeleteLoginSocket(socket: CClientSocket): void {
  loginPool?.DelSocket(socket);
}

export function FreeLoginUser(user: CUser): void {
  loginCenter?.UnregisterConnection(user.GetGlobalSerialNo());
  loginPool?.DeleteUser(user);
  loginPool?.m_localUserTable.ExtractUser(user);
}
