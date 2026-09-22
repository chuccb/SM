/**
 * Port-only Bun module-cycle adapter for native singleton calls into
 * CCenterProcess. Native source units call CCenterProcess::ms_pInstance
 * directly; ESM requires the concrete implementation to be wired at runtime.
 */
import type { CSendPacket } from "../../core/Packet.ts";

export interface CenterProcessPort {
  SendPacket(packet: CSendPacket): void;
}

let centerProcess: CenterProcessPort | null = null;

export function RegisterCenterProcess(process: CenterProcessPort | null): void {
  centerProcess = process;
}

export function SendCenterPacket(packet: CSendPacket): void {
  centerProcess?.SendPacket(packet);
}
