import { IntegerRange } from "../Common/OfficialValues.ts";

/** FXGS CGameClock @ 0041ABBF..0041ABDA, 0041B843..0041B874, 0041CE1F.
 * All times are unsigned WinMM DWORD milliseconds, including rollover.
 * ElapsedTime intentionally DOES NOT freeze at SuspendGame or EndGame. Native
 * callers subtract the accumulated suspension DWORD separately. */
export class CGameClock {
  m_dwTimeStopped = 0;
  private m_dwStartGameTime = 0;
  private m_dwEndGameTime = 0;
  private m_dwSuspendGameTime = 0;
  constructor(
    private readonly timeGetTime: () => number = () => performance.now(),
    private readonly reportMismatch: (
      reason: "resume" | "suspend",
    ) => void = () => {},
  ) {}
  /** Modern detached inspection of ALL FOUR native DWORD markers; no clock
   * sampling. Used to reject trusted pause/resume drift in a frozen plan. */
  GetStateSnapshot(): Readonly<{
    Start: number;
    End: number;
    Stopped: number;
    Suspended: number;
  }> {
    return Object.freeze({
      Start: this.m_dwStartGameTime,
      End: this.m_dwEndGameTime,
      Stopped: this.m_dwTimeStopped,
      Suspended: this.m_dwSuspendGameTime,
    });
  }
  /** Modern dependency-injection helper, NOT an additional native method.
   * Session-level WinMM reads use the same clock as the round clock. */
  GetCurrentTime(): number {
    return this.timeGetTime() >>> 0;
  }
  StartGame(): void {
    this.StartGameAt(this.timeGetTime() >>> 0);
  }
  /** Modern preflight install; preserves all four native marker roles without
   * re-sampling a fallible clock after roster consumption. Not round authority. */
  StartGameAt(time: number): void {
    if (
      !Number.isInteger(time) ||
      time < 0 ||
      time > IntegerRange.UInt32Maximum
    )
      throw new RangeError("Invalid unsigned start-game tick");
    this.m_dwTimeStopped = 0;
    this.m_dwEndGameTime = 0;
    this.m_dwStartGameTime = time;
    // Native StartGame does not overwrite the fourth DWORD (suspend timestamp).
  }
  EndGame(): void {
    this.m_dwEndGameTime = this.timeGetTime() >>> 0;
  }
  /** Modern commit helper: preserve the native pre-result EndGame sample
   * across synchronous SQL latency/retry without re-sampling the clock. */
  EndGameAt(time: number): void {
    if (
      !Number.isInteger(time) ||
      time < 0 ||
      time > IntegerRange.UInt32Maximum
    )
      throw new RangeError("Invalid unsigned end-game tick");
    this.m_dwEndGameTime = time;
  }
  ElapsedTime(): number {
    return ((this.timeGetTime() >>> 0) - this.m_dwStartGameTime) >>> 0;
  }
  GetRealElapsedTime(): number {
    // The .lst return signature is QBEKXZ (unsigned long), despite IDA's int.
    return (this.m_dwEndGameTime - this.m_dwStartGameTime) >>> 0;
  }
  GetStartGameTime(): number {
    return this.m_dwStartGameTime;
  }
  GetEndGameTime(): number {
    return this.m_dwEndGameTime;
  }
  ResumeGame(): void {
    if (this.m_dwSuspendGameTime !== 0) {
      const delta =
        ((this.timeGetTime() >>> 0) - this.m_dwSuspendGameTime) >>> 0;
      this.m_dwSuspendGameTime = 0;
      this.m_dwTimeStopped = (this.m_dwTimeStopped + delta) >>> 0;
    } else this.reportMismatch("resume");
  }
  SuspendGame(): void {
    if (this.m_dwSuspendGameTime !== 0) {
      this.reportMismatch("suspend");
      this.ResumeGame();
    }
    this.m_dwSuspendGameTime = this.timeGetTime() >>> 0;
  }
}
