import { CProtocolError } from "../Common/CProtocolError.ts";
import { GameLaunchRule, IntegerRange } from "../Common/OfficialValues.ts";

/** MissionInfo0040C3AA / assignment00420B7D. LoadMap0040C15A copies four
 * serialized DWORDs into+108..120, but NEVER loads a LapTileInfo vector. The
 * separate native vector+124 is constructor-empty; pointer-looking serialized
 * words must never be followed. Names beyond Type remain deliberately opaque.
 * This class preserves the launch snapshot; it is NOT a mission engine. */
export class MissionInfo {
  private readonly m_adwInfo = new Int32Array(GameLaunchRule.MissionWords);
  Assign(words: readonly number[]): void {
    if (
      words.length !== GameLaunchRule.MissionWords ||
      Array.from(words).some(
        (n) =>
          !Number.isInteger(n) ||
          n < IntegerRange.Int32Minimum ||
          n > IntegerRange.Int32Maximum,
      )
    )
      throw new CProtocolError("Invalid serialized MissionInfo DWORDs");
    this.m_adwInfo.set(words);
  }
  GetType(): number {
    return this.m_adwInfo[0]!;
  }
  GetWords(): readonly number[] {
    return Array.from(this.m_adwInfo);
  }
}
