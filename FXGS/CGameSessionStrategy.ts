import type { CClientSocket } from "../Common/CClientSocket.ts";

/** The ordinary (non-guild) strategy really is empty in the shipped code:
 * FXGS .lst 004216D9..004216F4 are `ret`/`ret 4`/`ret 8`, vtable 0048F7D4.
 * This is NOT a placeholder for an unexamined plugin-generated packet. */
export class CGameSessionStrategy {
  MakeSimpleInfoPacket(): void {}
  MakeCreatedPacket(): void {}
  MakeModifiedPacket(): void {}
  /** 004216E6 / vtable+24: native ret4, not a stub. */
  DestroyPlayer(_socket: CClientSocket): void {}
  SendSessionInfo(): void {}
  /** 004216CF: xor eax,eax; ret (ordinary result view). */
  GetResultViewType(): number {
    return 0;
  }
}
