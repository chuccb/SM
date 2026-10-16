import type { _SYSTEMTIME } from "../../Common/Calendar.ts";
import type { tagDBTIMESTAMP } from "../../Common/DB/NativeCalendar.ts";
import vectors from "../fixtures/calendar-vectors.json";

export function SystemTime(extra: Partial<_SYSTEMTIME> = {}): _SYSTEMTIME {
  return {
    wYear: 2026,
    wMonth: 1,
    wDayOfWeek: 5,
    wDay: 2,
    wHour: 3,
    wMinute: 4,
    wSecond: 5,
    wMilliseconds: 0,
    ...extra,
  };
}
export function DBTime(extra: Partial<tagDBTIMESTAMP> = {}): tagDBTIMESTAMP {
  return {
    year: 2026,
    month: 1,
    day: 2,
    hour: 3,
    minute: 4,
    second: 5,
    fraction: 123456789,
    ...extra,
  };
}
export function TimeArray(
  t: Readonly<_SYSTEMTIME>,
): readonly (number | null)[] {
  return [
    t.wYear,
    t.wMonth,
    t.wDayOfWeek,
    t.wDay,
    t.wHour,
    t.wMinute,
    t.wSecond,
    t.wMilliseconds,
  ];
}
export function VariantHex(value: number): string {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(value);
  return b.toString("hex");
}
interface CalendarVector {
  Name: string;
  Input: tagDBTIMESTAMP;
  InputHex: string;
  DBSystem: (number | null)[];
  RowSystem: (number | null)[];
  Reverse: tagDBTIMESTAMP;
  VariantHex: string | null;
  PacketHex: string | null;
  PlainPacketHex: string | null;
  Advances: {
    Delta: number;
    System: (number | null)[] | null;
    VariantHex: string | null;
  }[];
}
/** Explicit independent JSON contract, not inference-budget-dependent any. */
export const CalendarVectors: {
  Model: string;
  Profile: string;
  OfficialPE: { FXGS: string; LS: string };
  InstructionAnchors: {
    Service: string;
    VA: number;
    Bytes: string;
    Meaning: string;
  }[];
  SharedRoutines: { FXGS: number; LS: number; Size: number; Meaning: string }[];
  Research: { MicrosoftSDKCommit: string; URL: string; Meaning: string };
  Cases: CalendarVector[];
} = vectors;
