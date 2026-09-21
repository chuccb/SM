/** A13: GetLocalTime → SystemTimeToVariantTime calendar and wire behavior. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Observation {
  value: number;
  sameSecond: number;
  wireHex: string;
  preEpoch: number;
  plusLocalDay: string;
  empty: number;
  invalidIsNaN: boolean;
}

interface PersistenceObservation {
  shopExpiry: string;
  ticketExpiry: string;
  permanentExpiry: string;
}

/** Read initialized PE32 data by virtual address without executing Windows code. */
function peCode(va: number, length: number): Buffer {
  const pe = readFileSync(join(import.meta.dir, "../..", "FXSS", "FxShop.exe"));
  const nt = pe.readUInt32LE(0x3c);
  const optionalHeader = nt + 24;
  const rva = va - pe.readUInt32LE(optionalHeader + 28);
  const sectionCount = pe.readUInt16LE(nt + 6);
  const sectionTable = optionalHeader + pe.readUInt16LE(nt + 20);
  for (let index = 0; index < sectionCount; index++) {
    const section = sectionTable + index * 40;
    const virtualSize = pe.readUInt32LE(section + 8);
    const virtualAddress = pe.readUInt32LE(section + 12);
    if (rva < virtualAddress || rva + length > virtualAddress + virtualSize) continue;
    const raw = pe.readUInt32LE(section + 20) + rva - virtualAddress;
    return pe.subarray(raw, raw + length);
  }
  throw new Error(`No FxShop PE section contains VA ${va.toString(16)}`);
}

function observe(timeZone: string): Observation {
  const worker = Bun.spawnSync({
    cmd: [process.execPath, join(import.meta.dir, "fixtures/variant-time-worker.ts")],
    env: { ...process.env, TZ: timeZone },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(worker.exitCode).toBe(0);
  expect(worker.stderr.toString()).toBe("");
  return JSON.parse(worker.stdout.toString()) as Observation;
}

function observePersistence(timeZone: string): PersistenceObservation {
  const worker = Bun.spawnSync({
    cmd: [process.execPath, join(import.meta.dir, "fixtures/date-persistence-worker.ts")],
    env: { ...process.env, TZ: timeZone },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(worker.exitCode).toBe(0);
  expect(worker.stderr.toString()).toBe("");
  const lines = worker.stdout.toString().trim().split("\n");
  return JSON.parse(lines.at(-1)!) as PersistenceObservation;
}

function decodeFloat64(hex: string): number {
  const bytes = Buffer.from(hex, "hex");
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0, true);
}

test("the native receipt and CTime paths call local SYSTEMTIME conversion", () => {
  // CMainPool purchase receipt: GetLocalTime, then SystemTimeToVariantTime.
  expect(peCode(0x41673e, 22).toString("hex")).toBe(
    "ff1530d047008d442414508d4c243c51ff1528d24700",
  );
  // CTime::GetVariantTime passes its stored SYSTEMTIME directly to the same API.
  expect(peCode(0x428710, 24).toString("hex")).toBe(
    "83ec088d04245083c10451ff1528d24700dd042483c408c3",
  );
});

test("OLE DATE follows local calendar fields, has second precision, and is little-endian", () => {
  const utc = observe("UTC");
  const taipei = observe("Asia/Taipei");
  const newYork = observe("America/New_York");

  expect(utc.value).toBe(46_286);
  expect(taipei.value).toBe(46_286 + 8 / 24);
  expect(newYork.value).toBe(46_285 + 20 / 24);
  expect([utc.sameSecond, taipei.sameSecond, newYork.sameSecond])
    .toEqual([utc.value, taipei.value, newYork.value]);
  for (const observation of [utc, taipei, newYork]) {
    expect(decodeFloat64(observation.wireHex)).toBe(observation.value);
    expect(observation.empty).toBe(0);
    expect(observation.invalidIsNaN).toBe(true);
  }
  expect(utc.preEpoch).toBe(-1.25);
});

test("SQL-style day addition preserves wall time across a daylight-saving transition", () => {
  expect(observe("UTC").plusLocalDay).toBe("2026-03-08T17:00:00.000Z");
  // Noon EST + one local calendar day = noon EDT, an elapsed 23 hours.
  expect(observe("America/New_York").plusLocalDay).toBe("2026-03-08T16:00:00.000Z");
});

test("Shop, premium-ticket, and local-billing persistence all use local calendar days", () => {
  const result = observePersistence("America/New_York");
  expect(result.shopExpiry).toBe("2026-03-08T16:00:00.000Z");
  expect(result.ticketExpiry).toBe("2026-03-08T16:00:00.000Z");
  // 100,000 calendar days retain noon wall time across the intervening DST changes.
  expect(result.permanentExpiry).toBe("2299-10-17T16:00:00.000Z");
});
