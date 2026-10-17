import { CProtocolError } from "../Common/CProtocolError.ts";
import {
  BanChiefTiming,
  BanChiefLayout,
  IntegerRange,
} from "../Common/OfficialValues.ts";

/** Detached modern copy of the eight native DWORD roles, NOT a capability,
 * native pointer layout or restart journal. Boolean fields are canonicalized. */
export interface BanChiefState {
  readonly CanStartTime: number;
  readonly CanStart: boolean;
  readonly OddSlot: boolean;
  readonly LastTimeEvenSlot: number;
  readonly WarnedBan: boolean;
  readonly WarnedTime: number;
  readonly WarnedBanOddSlot: boolean;
  readonly WarnedTimeOddSlot: number;
}

/** Native CBanChief 00401000..00401115 / getters0041ABA3..0041ABBB.
 * DeferBanChief's guarded ordinary scheduler uses detached state preparation;
 * this object itself does not authorize removal, SQL or financial effects.
 * Member names describe recovered getters; +0 vptr is not emulated. */
export class CBanChief {
  private m_dwCanStartTime = 0; // +4
  private m_bCanStart = false; // +8
  private m_bOddSlot = false; // +12
  private m_dwLastTimeEvenSlot = 0; // +16, despite the native getter's name
  private m_bWarnedBan = false; // +20
  private m_dwWarnedTime = 0; // +24
  private m_bWarnedBanOddSlot = false; // +28
  private m_dwWarnedTimeOddSlot = 0; // +32
  constructor(
    private readonly timeGetTime: () => number = () => performance.now(),
  ) {}
  CaptureSnapshot(): Readonly<BanChiefState> {
    return Object.freeze({
      CanStartTime: this.m_dwCanStartTime,
      CanStart: this.m_bCanStart,
      OddSlot: this.m_bOddSlot,
      LastTimeEvenSlot: this.m_dwLastTimeEvenSlot,
      WarnedBan: this.m_bWarnedBan,
      WarnedTime: this.m_dwWarnedTime,
      WarnedBanOddSlot: this.m_bWarnedBanOddSlot,
      WarnedTimeOddSlot: this.m_dwWarnedTimeOddSlot,
    });
  }
  /** Trusted data copy; latch/validate ALL fields before synchronous publish.
   * Never samples the clock or changes the receiving object's clock provider. */
  InstallSnapshot(source: Readonly<BanChiefState>): void {
    const {
      CanStartTime,
      CanStart,
      OddSlot,
      LastTimeEvenSlot,
      WarnedBan,
      WarnedTime,
      WarnedBanOddSlot,
      WarnedTimeOddSlot,
    } = source;
    if (
      [CanStartTime, LastTimeEvenSlot, WarnedTime, WarnedTimeOddSlot].some(
        (v) => !Number.isInteger(v) || v < 0 || v > IntegerRange.UInt32Maximum,
      ) ||
      [CanStart, OddSlot, WarnedBan, WarnedBanOddSlot].some(
        (v) => typeof v !== "boolean",
      )
    )
      throw new CProtocolError("Invalid chief timing snapshot");
    this.m_dwCanStartTime = CanStartTime;
    this.m_bCanStart = CanStart;
    this.m_bOddSlot = OddSlot;
    this.m_dwLastTimeEvenSlot = LastTimeEvenSlot;
    this.m_bWarnedBan = WarnedBan;
    this.m_dwWarnedTime = WarnedTime;
    this.m_bWarnedBanOddSlot = WarnedBanOddSlot;
    this.m_dwWarnedTimeOddSlot = WarnedTimeOddSlot;
  }
  Fork(timeGetTime: () => number): CBanChief {
    const next = new CBanChief(timeGetTime);
    next.InstallSnapshot(this.CaptureSnapshot());
    return next;
  }
  Init(): void {
    this.SetOddSlot(false);
    this.SetCanStart(false);
  }
  SetWarnedBanOddSlot(value: boolean): void {
    this.m_bWarnedBanOddSlot = value;
    this.m_dwWarnedTimeOddSlot = value ? this.timeGetTime() >>> 0 : 0;
  }
  SetWarnedBan(value: boolean): void {
    this.m_bWarnedBan = value;
    this.m_dwWarnedTime = value ? this.timeGetTime() >>> 0 : 0;
  }
  SetCanStart(value: boolean): void {
    this.m_bWarnedBan = false;
    this.m_dwWarnedTime = 0;
    this.m_dwCanStartTime = this.timeGetTime() >>> 0;
    this.m_bCanStart = value;
  }
  SetOddSlot(value: boolean): void {
    this.m_bOddSlot = value;
    this.m_dwLastTimeEvenSlot = value ? this.timeGetTime() >>> 0 : 0;
    this.m_bWarnedBanOddSlot = false;
    this.m_dwWarnedTimeOddSlot = 0;
  }
  private Scaled(milliseconds: number, multiplier: number): number {
    if (
      !Number.isInteger(multiplier) ||
      multiplier < 0 ||
      multiplier > IntegerRange.UInt32Maximum
    )
      throw new CProtocolError("Invalid chief delay multiplier");
    return Math.imul(milliseconds, multiplier) >>> 0;
  }
  IsBanChief(fullRoom: boolean, _manner: boolean, multiplier: number): boolean {
    const delay = this.Scaled(
      fullRoom
        ? BanChiefTiming.FullRoomMilliseconds
        : BanChiefTiming.OtherRoomMilliseconds,
      multiplier,
    );
    return ((this.timeGetTime() >>> 0) - this.m_dwCanStartTime) >>> 0 > delay;
  }
  GetWarningDelay(multiplier: number): number {
    return this.Scaled(BanChiefTiming.WarningMilliseconds, multiplier);
  }
  GetOddSlotInManner(multiplier: number): number {
    return this.Scaled(BanChiefTiming.OddSlotMilliseconds, multiplier);
  }
  IsCanStart(): boolean {
    return this.m_bCanStart;
  }
  IsOddSlot(): boolean {
    return this.m_bOddSlot;
  }
  IsWarnedBan(): boolean {
    return this.m_bWarnedBan;
  }
  IsWarnedBanOddSlot(): boolean {
    return this.m_bWarnedBanOddSlot;
  }
  GetWarnedTime(): number {
    return this.m_dwWarnedTime;
  }
  GetWarnedTimeOddSlot(): number {
    return this.m_dwWarnedTimeOddSlot;
  }
  GetLastTimeEvenSlot(): number {
    return this.m_dwLastTimeEvenSlot;
  }
  /** Detached canonical native DWORD layout for tests, +0 pointer replaced by0.
   * Not a native pointer image, network packet or persistence/recovery format. */
  GetStateBytes(): Buffer {
    const bytes = Buffer.alloc(BanChiefLayout.Size);
    [
      this.m_dwCanStartTime,
      +this.m_bCanStart,
      +this.m_bOddSlot,
      this.m_dwLastTimeEvenSlot,
      +this.m_bWarnedBan,
      this.m_dwWarnedTime,
      +this.m_bWarnedBanOddSlot,
      this.m_dwWarnedTimeOddSlot,
    ].forEach((word, i) =>
      bytes.writeUInt32LE(word, (i + 1) * Uint32Array.BYTES_PER_ELEMENT),
    );
    return bytes;
  }
}
