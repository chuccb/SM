import { AddLocalCalendarDays } from "../../src/core/LocalTime.ts";
import { EncodeVariantTime, GetVariantTime } from "../../src/core/VariantTime.ts";

const instant = new Date("2026-09-21T00:00:00.987Z");
const almostNextSecond = new Date("2026-09-21T00:00:00.001Z");
const wire = EncodeVariantTime(instant);
const springForwardBase = Date.parse("2026-03-07T17:00:00.000Z");

console.log(JSON.stringify({
  value: GetVariantTime(instant),
  sameSecond: GetVariantTime(almostNextSecond),
  wireHex: Buffer.from(wire).toString("hex"),
  preEpoch: GetVariantTime(new Date("1899-12-29T06:00:00.000Z")),
  plusLocalDay: AddLocalCalendarDays(springForwardBase, 1).toISOString(),
  empty: GetVariantTime(null),
  invalidIsNaN: Number.isNaN(GetVariantTime(new Date(Number.NaN))),
}));
