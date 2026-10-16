import { CProtocolError } from "../Common/CProtocolError.ts";
import {
  BombRule,
  BombState,
  GamePosition,
  GameContextLimit,
  GamePickupState,
  SessionLimit,
  GamePlayerState,
  PlayerStateTimerRule,
} from "../Common/OfficialValues.ts";

/** Descriptive fields recovered from the native 20-byte bomb record:
 * serial+0, state:u8+4, remaining:int32+8, row/column/power:u8+12/13/14,
 * remotely paused:DWORD+16. Padding is deliberately not used as a new feature. */
export interface BombRecord {
  readonly SerialNo: number;
  State: number;
  RemainingMilliseconds: number;
  Row: number;
  Column: number;
  readonly Power: number;
  RemotelyPaused: boolean;
}
export interface BombTimerEvent {
  readonly SerialNo: number;
  readonly Landed: boolean;
}

/** CGameContext @ 0041BA71/0041CD9B. Native context is 10,380 bytes, not a
 * CGameMap collision engine: the client reports events and this state arbitrates
 * timers/claims. Additional helpers factor native CGameSession handler loops;
 * they are not claimed to be recovered CGameContext method names. */
export class CGameContext {
  readonly m_aBomb: BombRecord[] = [];
  m_nNextBombSerialNo = 0;
  m_nNextBoxItem = GameContextLimit.FirstGeneratedBoxItem as number;
  readonly m_aBoxItemState = new Int32Array(GameContextLimit.BoxItems);
  readonly m_aObstacleState = new Int32Array(
    GameContextLimit.Rows * GameContextLimit.Columns,
  );
  readonly m_aHouseCount = new Int32Array(SessionLimit.Players);
  readonly m_aBulaState = new Int32Array(
    GameContextLimit.BulaRows * GameContextLimit.BulaColumns,
  );
  readonly m_aHouseState = new Int32Array(
    GameContextLimit.Rows * GameContextLimit.Columns,
  );
  readonly m_aPlayerStateTime = new Uint32Array(SessionLimit.Players);
  readonly m_aGhostPosition = Array.from(
    { length: SessionLimit.Players },
    () => ({ x: 0, y: 0 }),
  );
  Init(): void {
    this.m_aBomb.length = 0;
    this.m_nNextBombSerialNo = 0;
    this.m_nNextBoxItem = GameContextLimit.FirstGeneratedBoxItem;
    this.m_aBoxItemState.fill(GamePickupState.Unclaimed);
    this.m_aObstacleState.fill(GamePickupState.Unclaimed);
    this.m_aHouseCount.fill(0);
    this.m_aBulaState.fill(GameContextLimit.Unclaimed);
    this.m_aHouseState.fill(GameContextLimit.Unclaimed);
    // Native Init does NOT clear +4820 player-state times or CPoint positions.
  }
  AddBoxItem(): number {
    if (this.m_nNextBoxItem >= GameContextLimit.BoxItems) return -1;
    return this.m_nNextBoxItem++;
  }
  private planeIndex(
    row: number,
    column: number,
    rows: number,
    columns: number,
  ): number {
    if (
      !Number.isInteger(row) ||
      !Number.isInteger(column) ||
      row < 0 ||
      row >= rows ||
      column < 0 ||
      column >= columns
    )
      throw new CProtocolError("Game context coordinate out of bounds");
    return row * columns + column;
  }
  GetBulaState(row: number, column: number): number {
    return this.m_aBulaState[
      this.planeIndex(
        row,
        column,
        GameContextLimit.BulaRows,
        GameContextLimit.BulaColumns,
      )
    ]!;
  }
  SetBulaState(row: number, column: number, state: number): void {
    this.m_aBulaState[
      this.planeIndex(
        row,
        column,
        GameContextLimit.BulaRows,
        GameContextLimit.BulaColumns,
      )
    ] = state;
  }
  GetHouseState(row: number, column: number): number {
    return this.m_aHouseState[
      this.planeIndex(
        row,
        column,
        GameContextLimit.Rows,
        GameContextLimit.Columns,
      )
    ]!;
  }
  SetHouseState(
    row: number,
    column: number,
    state: number,
    color: number,
  ): void {
    this.m_aHouseState[
      this.planeIndex(
        row,
        column,
        GameContextLimit.Rows,
        GameContextLimit.Columns,
      )
    ] = state;
    if (Number.isInteger(color) && color >= 0 && color < SessionLimit.Players)
      this.m_aHouseCount[color]!++;
  }
  SetObstacleState(row: number, column: number, state: number): void {
    this.m_aObstacleState[
      this.planeIndex(
        row,
        column,
        GameContextLimit.Rows,
        GameContextLimit.Columns,
      )
    ] = state;
  }
  GetObstacleState(row: number, column: number): number {
    return this.m_aObstacleState[
      this.planeIndex(
        row,
        column,
        GameContextLimit.Rows,
        GameContextLimit.Columns,
      )
    ]!;
  }
  AddBomb(packedPosition: number, attributes: number): BombRecord {
    if (this.m_aBomb.length >= GameContextLimit.Bombs)
      throw new CProtocolError("Bomb array overflow");
    const Row = packedPosition >>> GamePosition.RowShift;
    const Column = packedPosition & GamePosition.ColumnMask;
    this.planeIndex(
      Row,
      Column,
      GameContextLimit.Rows,
      GameContextLimit.Columns,
    );
    const bomb: BombRecord = {
      SerialNo: this.m_nNextBombSerialNo >>> 0,
      State: BombState.Stationary,
      RemainingMilliseconds: BombRule.FuseMilliseconds,
      Row,
      Column,
      Power: attributes & BombRule.PowerMask,
      RemotelyPaused: (attributes & BombRule.PausedFlag) !== 0,
    };
    this.m_nNextBombSerialNo = (this.m_nNextBombSerialNo + 1) >>> 0;
    this.m_aBomb.push(bomb);
    return bomb;
  }
  FindBomb(serial: number): BombRecord | undefined {
    return this.m_aBomb.find((bomb) => bomb.SerialNo === serial);
  }
  SetBombTimer(
    serial: number,
    packedPosition: number,
    milliseconds: number,
  ): boolean {
    const bomb = this.FindBomb(serial);
    if (
      !bomb ||
      bomb.State !== BombState.Stationary ||
      bomb.Row !== packedPosition >>> GamePosition.RowShift ||
      bomb.Column !== (packedPosition & GamePosition.ColumnMask)
    )
      return false;
    bomb.RemainingMilliseconds = Math.min(
      bomb.RemainingMilliseconds,
      milliseconds,
    );
    bomb.RemotelyPaused = false; // cleared even when the requested timer is not shorter
    return true;
  }
  KickBomb(
    serial: number,
    previous: number,
    destination: number,
    milliseconds: number,
  ): boolean {
    const bomb = this.FindBomb(serial);
    const Row = destination >>> GamePosition.RowShift;
    const Column = destination & GamePosition.ColumnMask;
    this.planeIndex(
      Row,
      Column,
      GameContextLimit.Rows,
      GameContextLimit.Columns,
    );
    if (
      !bomb ||
      bomb.State !== BombState.Stationary ||
      bomb.Row !== previous >>> GamePosition.RowShift ||
      bomb.Column !== (previous & GamePosition.ColumnMask)
    )
      return false;
    bomb.Row = Row;
    bomb.Column = Column;
    bomb.State = BombState.Moving;
    bomb.RemainingMilliseconds = milliseconds;
    return true;
  }
  /** Extracted ordinary-mode player-state section of session Update
   * 0041DE4F..0041DF00; a modern factoring helper, not a recovered method name.
   * There is intentionally NO occupancy filter, no stopped-time subtraction and
   * no killer/save statistic here. Native samples ElapsedTime separately for the
   * deadline and the new timestamp. Ordinary OnBomberDie has no further effects;
   * the Mod captain cascade MUST be rejected by the session BEFORE this helper.
   * Return slots in native traversal order for ONE grouped server-only 159.
   */
  AdvancePlayerStateTimers(
    states: Uint8Array,
    elapsedTime: () => number,
  ): number[] {
    if (states.length !== SessionLimit.Players)
      throw new CProtocolError("Player state array must contain eight slots");
    const allStates1Or3Or4 = states.every(
      (state) =>
        state === GamePlayerState.PendingDie ||
        state === GamePlayerState.Inactive ||
        state === GamePlayerState.Excluded4,
    );
    const deadline = allStates1Or3Or4
      ? PlayerStateTimerRule.AllStates1Or3Or4Milliseconds
      : PlayerStateTimerRule.OtherStatePresentMilliseconds;
    const expired: number[] = [];
    for (let slot = 0; slot < SessionLimit.Players; slot++) {
      if (states[slot] !== GamePlayerState.PendingDie) continue;
      if (
        ((elapsedTime() >>> 0) - this.m_aPlayerStateTime[slot]!) >>> 0 <
        deadline
      )
        continue;
      states[slot] = GamePlayerState.Inactive;
      this.m_aPlayerStateTime[slot] = elapsedTime() >>> 0;
      expired.push(slot);
    }
    return expired;
  }
  /** Exact bomb-array section of CGameSession::Update @ 0041DC31.
   * A moving bomb first emits landed=1 and receives a fresh 2000ms fuse; a
   * stationary bomb emits landed=0 and is removed by SWAPPING THE LAST record.
   * No flame footprint or collision result is invented here. */
  AdvanceBombTimers(elapsedMilliseconds: number): BombTimerEvent[] {
    if (
      !Number.isInteger(elapsedMilliseconds) ||
      elapsedMilliseconds < 0 ||
      elapsedMilliseconds > 0xffffffff
    )
      throw new CProtocolError("Invalid bomb timer delta");
    const events: BombTimerEvent[] = [];
    let i = 0;
    while (i < this.m_aBomb.length) {
      const bomb = this.m_aBomb[i]!;
      if (!bomb.RemotelyPaused || bomb.State === BombState.Moving)
        bomb.RemainingMilliseconds =
          (bomb.RemainingMilliseconds - elapsedMilliseconds) | 0;
      if (bomb.RemainingMilliseconds > 0) {
        i++;
        continue;
      }
      const Landed = bomb.State === BombState.Moving;
      events.push({ SerialNo: bomb.SerialNo, Landed });
      if (Landed) {
        bomb.State = BombState.Stationary;
        bomb.RemainingMilliseconds = BombRule.FuseAfterLandingMilliseconds;
        i++;
      } else {
        const last = this.m_aBomb.pop()!;
        if (i < this.m_aBomb.length) this.m_aBomb[i] = last;
      }
    }
    return events;
  }
}
