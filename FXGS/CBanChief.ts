import { CProtocolError } from "../Common/CProtocolError.ts";
import {
  BanChiefTiming,
  BanChiefLayout,
  IntegerRange,
} from "../Common/OfficialValues.ts";

/** Native CBanChief 00401000..00401115 / getters0041ABA3..0041ABBB.
 * Only the state/timing object; this does NOT enable the room's DeferBanChief
 * scheduler, authority22, SuperChief lookup, warnings121 or automatic removal.
 * Member names describe the recovered getters; +0 native vptr is not emulated.
 */
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
