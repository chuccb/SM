/**
 * Port-only ESM cycle adapter for CListSession calls whose native owner is
 * CBaseSessionTable.  The original reaches the table singleton directly;
 * keeping that value import out of ListSession.ts lets CPracticeSession safely
 * extend CGameSession during module initialization.
 */
import type { CClientSocket } from "../ClientSocket.ts";

export interface SessionRuntimeTable {
  MoveToExchangeSession(socket: CClientSocket, target: number): void;
  DestroyPlayer(socket: CClientSocket, sendReset: number): void;
  ClearModifiedFlag(index: number): void;
}

let sessionTable: SessionRuntimeTable | null = null;

export function RegisterSessionRuntimeTable(table: SessionRuntimeTable | null): void {
  sessionTable = table;
}

export function MoveToExchangeSession(socket: CClientSocket, target = 0): void {
  sessionTable?.MoveToExchangeSession(socket, target);
}

export function DestroySessionPlayer(socket: CClientSocket, sendReset: number): void {
  sessionTable?.DestroyPlayer(socket, sendReset);
}

export function ClearSessionModifiedFlag(index: number): void {
  sessionTable?.ClearModifiedFlag(index);
}
