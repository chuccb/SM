import type { CUser } from "./CUser.ts";
import { CProtocolError } from "./CProtocolError.ts";
import {
  DynInfoLayout as Layout,
  DynInfoRule as Rule,
  SessionLimit,
  SlotStateMask,
  UserCount,
  IntegerRange,
} from "./OfficialValues.ts";
import { g_nLevel2ExpTable } from "./Protocol/OfficialTables.ts";

export interface Int32Reference {
  value: number;
}

/** FXGS 0040B1BE..0040B6EB / 0041AAF1..0041AB68.
 * The 596-byte layout is retained for fixed-width state/float-store checks; the
 * vtable word is deliberately zero, NOT a native pointer or a wire format.
 * Init alone does NOT perform LaunchGameStage's separate team-pair traversal.
 * Modern defenses validate all inputs before resetting an existing calculation.
 */
export class CDynInfoCalculator {
  private readonly m_state = new ArrayBuffer(Layout.Size);
  private readonly m_i32 = new Int32Array(this.m_state);
  private readonly m_f32 = new Float32Array(this.m_state);
  private m_bInitialized = false;

  constructor(private readonly isPremiumChannel: () => boolean = () => false) {
    // Native ctor initializes only +588. Do not expose its uninitialized reads.
    this.m_i32[Layout.InvalidGame] = 1;
    this.m_i32.fill(-1, Layout.TeamColor, Layout.TeamCount);
  }

  /** LS 0040B6A0 / FXGS 0040B252: upper threshold index, in 1..450. */
  static GetLevel(exp: number): number {
    let first = 0;
    let last = g_nLevel2ExpTable.length;
    while (first + 1 !== last) {
      const middle = Math.floor((first + last) / 2);
      if (exp >= g_nLevel2ExpTable[middle]!) first = middle;
      else last = middle;
    }
    return last;
  }

  /** 0040B284 returns a NUMBER, despite IDA's erroneous int* return type. */
  static GetMaxExpInLevel(level: number): number {
    if (!Number.isInteger(level))
      throw new CProtocolError("Invalid integer level index");
    return level < 0 || level >= g_nLevel2ExpTable.length
      ? Rule.InvalidThreshold
      : g_nLevel2ExpTable[level]!;
  }

  /** 0040B29E: per-mille, NOT a floating point fraction or a 0..100 value.
   * Signed 32-bit IMUL happens BEFORE IDIV, including wrapping on negative
   * signed inputs. The shipped nonnegative level spans themselves fit safely.
   */
  static GetExpPercentage(exp: number): number {
    if (
      !Number.isInteger(exp) ||
      exp < IntegerRange.Int32Minimum ||
      exp > IntegerRange.Int32Maximum
    )
      throw new CProtocolError("Experience is not a signed DWORD");
    const level = this.GetLevel(exp);
    const upper = this.GetMaxExpInLevel(level);
    const lower = this.GetMaxExpInLevel(level - 1);
    if (upper === Rule.InvalidThreshold || lower === Rule.InvalidThreshold)
      return 0;
    return (
      Math.trunc(
        Math.imul((exp - lower) | 0, Rule.PerMille) / ((upper - lower) | 0),
      ) | 0
    );
  }

  Init(
    players: readonly (CUser | undefined)[],
    slotStates: readonly Uint8Array[],
  ): void {
    if (
      players.length !== SessionLimit.Players ||
      slotStates.length !== SessionLimit.Players ||
      Array.from(slotStates).some(
        (state) => state?.length !== Rule.SlotStateBytes,
      )
    )
      throw new CProtocolError("Invalid calculator player/slot arrays");
    // Capture and validate BEFORE clearing prior state. Native low-five-bit
    // colors 8..31 would index outside the eight-element arrays; reject them.
    const occupied = players.flatMap((user, slot) => {
      if (!user) return [];
      const socket = user.m_pClientSocket;
      const color = slotStates[slot]![2]! & SlotStateMask.Color;
      const level = user.GetLevel();
      if (color >= SessionLimit.Players)
        throw new CProtocolError("Calculator team color is outside 0..7");
      if (
        user.IsSetFree() !== 0 ||
        !socket ||
        !socket.IsConnected() ||
        user.GetSelfidx() < 0 ||
        socket.GetUserCount() < UserCount.Minimum ||
        socket.GetUserCount() > UserCount.Maximum
      )
        throw new CProtocolError(
          "Calculator player is not attached to a live socket",
        );
      if (
        !Number.isInteger(level) ||
        level < 1 ||
        level > g_nLevel2ExpTable.length
      )
        throw new CProtocolError("Invalid calculator player level");
      return [{ user, socket, slot, color, level }];
    });
    if (new Set(occupied.map(({ user }) => user)).size !== occupied.length)
      throw new CProtocolError("Duplicate calculator player");

    this.m_i32.fill(0);
    this.m_i32.fill(-1, Layout.TeamColor, Layout.TeamCount);
    this.m_i32[Layout.InvalidGame] = 1;
    const firstSocket = occupied[0]?.socket;
    for (const { socket, slot, color, level } of occupied) {
      if (socket !== firstSocket) this.m_i32[Layout.InvalidGame] = 0;
      this.m_i32[Layout.PlayerCount] = this.m_i32[Layout.PlayerCount]! + 1;
      const weight = Math.sqrt(level + Rule.LevelOffset);
      // Each native FSTP DWORD is a float32 store; do not round every arithmetic
      // intermediate, nor accumulate all weights in a JS double until the end.
      this.m_f32[Layout.OverallMean] = this.m_f32[Layout.OverallMean]! + weight;
      this.m_f32[Layout.TeamMean + color] =
        this.m_f32[Layout.TeamMean + color]! + weight;
      this.m_i32[Layout.TeamCount + color] =
        this.m_i32[Layout.TeamCount + color]! + 1;
      this.m_f32[Layout.PlayerWeight + slot] = weight;
      this.m_i32[Layout.TeamColor + slot] = color;
    }
    const count = this.m_i32[Layout.PlayerCount]!;
    if (count)
      this.m_f32[Layout.OverallMean] = this.m_f32[Layout.OverallMean]! / count;
    for (let color = 0; color < SessionLimit.Players; color++) {
      const teamCount = this.m_i32[Layout.TeamCount + color]!;
      if (teamCount)
        this.m_f32[Layout.TeamMean + color] =
          this.m_f32[Layout.TeamMean + color]! / teamCount;
    }
    this.m_bInitialized = true;
  }

  IsInitialized(): boolean {
    return this.m_bInitialized;
  }
  IsInvalidGame(): number {
    return this.m_i32[Layout.InvalidGame]!;
  }
  IsPremiumRewardCondition(): boolean {
    return this.m_i32[Layout.HasPremium] !== 0 || this.isPremiumChannel();
  }
  SetHasPremium(value: number): void {
    this.AssertInt32(value);
    this.m_i32[Layout.HasPremium] = value;
  }

  /** 0040B1DC ignores victim, and does NOT deduplicate repeated kills. */
  SetKillerIndex(victim: number, killer: number): void {
    this.AssertSlot(victim);
    this.Increment(Layout.KillCount, killer);
  }
  /** 0040B1EC deduplicates [saver][victim], including same-slot pairs. */
  SetSaverIndex(victim: number, saver: number): void {
    this.AssertSlot(victim);
    this.AssertSlot(saver);
    const pair = Layout.SaveMatrix + SessionLimit.Players * saver + victim;
    if (!this.m_i32[pair]) {
      this.m_i32[pair] = 1;
      this.Increment(Layout.SaveCount, saver);
    }
  }
  SetNice(slot: number, value: number): void {
    this.AssertSlot(slot);
    this.AssertInt32(value);
    this.m_i32[Layout.Nice + slot] = value;
  }
  GetKillCount(slot: number): number {
    return this.Read(Layout.KillCount, slot);
  }
  GetSaveCount(slot: number): number {
    return this.Read(Layout.SaveCount, slot);
  }
  GetMyTeamNo(slot: number): number {
    return this.Read(Layout.MyTeamNo, slot);
  }
  GetOtherTeamNo(slot: number): number {
    return this.Read(Layout.OtherTeamNo, slot);
  }
  GetTeamColor(slot: number): number {
    return this.Read(Layout.TeamColor, slot);
  }
  IncMyTeamNo(slot: number): void {
    this.Increment(Layout.MyTeamNo, slot);
  }
  IncOtherTeamNo(slot: number): void {
    this.Increment(Layout.OtherTeamNo, slot);
  }

  GetIncMoney(slot: number): number {
    this.AssertSlot(slot);
    if (!this.HasRewardContext(slot)) return 0;
    const color = this.m_i32[Layout.TeamColor + slot]!;
    const base = Math.trunc(
      Math.trunc(
        (Rule.MoneyPerPlayer * this.m_i32[Layout.PlayerCount]!) /
          this.m_i32[Layout.TeamCount + color]!,
      ) / Rule.MoneyDivisor,
    );
    return Math.min(Rule.MoneyMaximum, Math.max(Rule.MoneyMinimum, base));
  }
  /** The native out-reference is always cleared; no invented lucky draw.
   * IDA's extra alleged fourth argument is unused in the supplied assembly. */
  GetWinExp(slot: number, extra: Int32Reference = { value: 0 }): number {
    extra.value = 0;
    return this.GetResultExp(
      slot,
      Rule.WinFactor,
      Rule.WinMinimum,
      Rule.WinMaximum,
    );
  }
  GetDrawExp(slot: number): number {
    return this.GetResultExp(
      slot,
      Rule.DrawFactor,
      Rule.DrawMinimum,
      Rule.DrawMaximum,
    );
  }
  GetKillNSaveExp(slot: number): number {
    this.AssertSlot(slot);
    // Explicit premium alone is NOT sufficient for this particular reward.
    if (!this.isPremiumChannel() || !this.HasRewardContext(slot)) return 0;
    return Math.min(Rule.KillSaveMaximum, Math.max(0, this.KillSaveExp(slot)));
  }

  /** Modern isolated copy for result preview: native SendGameResult changes
   * +588 for every occupied slot; preview must not change the live calculator. */
  CloneForResultCalculation(): CDynInfoCalculator {
    const copy = new CDynInfoCalculator(this.isPremiumChannel);
    copy.m_i32.set(this.m_i32);
    copy.m_bInitialized = this.m_bInitialized;
    return copy;
  }

  /** Detached copy for regression/audit, never used as a client packet. */
  GetStateBytes(): Buffer {
    return Buffer.from(new Uint8Array(this.m_state));
  }

  private GetResultExp(
    slot: number,
    factor: number,
    minimum: number,
    maximum: number,
  ): number {
    this.AssertSlot(slot);
    if (!this.HasRewardContext(slot)) return 0;
    const color = this.m_i32[Layout.TeamColor + slot]!;
    const mean = this.m_f32[Layout.TeamMean + color]!;
    const base =
      ((this.m_i32[Layout.PlayerCount]! *
        this.m_f32[Layout.OverallMean]! *
        factor) /
        (this.m_i32[Layout.TeamCount + color]! * mean)) *
      (this.m_f32[Layout.PlayerWeight + slot]! / mean) *
      Rule.ResultScale;
    // Preserve native left-to-right floating point additions before FTOL2.
    const result =
      Math.trunc(
        base +
          this.m_i32[Layout.KillCount + slot]! * Rule.ExpPerKill +
          this.m_i32[Layout.SaveCount + slot]! * Rule.ExpPerSave,
      ) | 0;
    const capped = Math.min(maximum, Math.max(minimum, result));
    return this.IsPremiumRewardCondition()
      ? Math.trunc((Rule.PremiumNumerator * capped) / Rule.PremiumDenominator)
      : capped;
  }
  private KillSaveExp(slot: number): number {
    return (
      Math.trunc(
        this.m_i32[Layout.KillCount + slot]! * Rule.ExpPerKill +
          this.m_i32[Layout.SaveCount + slot]! * Rule.ExpPerSave,
      ) | 0
    );
  }
  private HasRewardContext(slot: number): boolean {
    if (this.IsInvalidGame()) return false;
    const color = this.m_i32[Layout.TeamColor + slot]!;
    // Native callers query occupied slots only. Do not reproduce its OOB access
    // at color -1 if a modern caller accidentally queries a vacant slot.
    return (
      color >= 0 &&
      color < SessionLimit.Players &&
      this.m_i32[Layout.TeamCount + color] !== 0 &&
      this.m_f32[Layout.TeamMean + color] !== 0
    );
  }
  private Read(offset: number, slot: number): number {
    this.AssertSlot(slot);
    return this.m_i32[offset + slot]!;
  }
  private Increment(offset: number, slot: number): void {
    this.AssertSlot(slot);
    this.m_i32[offset + slot] = (this.m_i32[offset + slot]! + 1) | 0;
  }
  private AssertSlot(slot: number): void {
    if (!this.m_bInitialized)
      throw new CProtocolError("CDynInfoCalculator is not initialized");
    if (!Number.isInteger(slot) || slot < 0 || slot >= SessionLimit.Players)
      throw new CProtocolError("Invalid calculator slot");
  }
  private AssertInt32(value: number): void {
    if (
      !Number.isInteger(value) ||
      value < IntegerRange.Int32Minimum ||
      value > IntegerRange.Int32Maximum
    )
      throw new CProtocolError("Calculator value is not a signed DWORD");
  }
}
