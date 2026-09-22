/**
 * Native source unit: FX/FxServer/PracticeSessionStrategy.cpp.
 *
 * The shipped binary contains only this derived constructor/destructor and no
 * overridden behavior or construction site. Keep the real class/source-unit
 * identity without pretending CPracticeSession instantiates it.
 */
import type { CGameSession } from "./GameSession.ts";
import { CGameSessionStrategy } from "./GameSessionStrategy.ts";

export class CPracticeSessionStrategy extends CGameSessionStrategy {
  constructor(session: CGameSession) {
    super(session);
  }
}
