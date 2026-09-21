/** Native source unit: FX/FxServer/GameSessionStrategy.cpp. */
import { CSendPacket } from "../core/Packet.ts";
import type { CGameSession } from "./GameSession.ts";
import type { CClientSocket } from "./ClientSocket.ts";
import type { CGuildDynInfoCalculator } from "./GuildDynInfoCalculator.ts";

/**
 * CGameSessionStrategy — the hook object every CGameSession carries
 * (+12620), bound once by the ctor's CreateSessionStrategy (FxServer.exe.c
 * :37220).  The base class is the `retn N` stub family (SendSessionInfo
 * 4216EF, SetGameResultPlayer 4216F2, GetResultViewType :37832 → 0); the
 * guild subclass below overrides the hooks that matter.  Vtable 0x48F7D4,
 * in order: Init, OnSelectColor, MakeSimpleInfoPacket, MakeCreatedPacket,
 * MakeModifiedPacket, DestroyPlayer, AddPlayer, SendSessionInfo,
 * OnGameResult, SetGameResultPlayer, GetResultViewType.
 */
export class CGameSessionStrategy {
  constructor(public m_pSession: CGameSession) {} // +4

  /** vtbl+4 — a stub on the base class. */
  Init(): void {}
  /** vtbl+8 — runs after CGameSession::DoSelectColor. */
  OnSelectColor(_slot: number, _color: number): void {}
  /** vtbl+12 — appended to every lobby 83. */
  MakeSimpleInfoPacket(_packet: CSendPacket): void {}
  /** vtbl+16 — appended to every lobby 85. */
  MakeCreatedPacket(_packet: CSendPacket): void {}
  /** vtbl+20 — appended to every lobby 86 (only when something changed). */
  MakeModifiedPacket(_packet: CSendPacket): void {}
  /** vtbl+24 — runs after CListSession::DestroyPlayer. */
  DestroyPlayer(_socket: CClientSocket): void {}
  /** vtbl+28 — runs before the seat assignment (CGameSession::AddPlayer). */
  AddPlayer(_socket: CClientSocket): void {}
  /** vtbl+32 — the "rewrite the session's packet buffer" hook.  The base
   *  stub leaves the buffer alone (so the caller's second PutPacket sends
   *  the same bytes again — the double 112); the guild variant rewrites it
   *  as 88 and broadcasts it (SendGuildSessionInfo, :423789). */
  SendSessionInfo(_packet: CSendPacket): void {}
  /** vtbl+36 — SendGameResult's tail, before the session SendPacket. */
  OnGameResult(_calc: CGuildDynInfoCalculator): void {}
  /** vtbl+40 — one call per seated user inside SendGameResult. */
  SetGameResultPlayer(_calc: CGuildDynInfoCalculator, _slot: number, _value: number, _n3: number): void {}
  /** vtbl+44 — result-view metadata added to packet 163 by the later 2005
   *  server build.  The 2004 Taiwan client protocol does not serialize it. */
  GetResultViewType(): number {
    return 0;
  }
}
