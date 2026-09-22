/** CBomberAttr::Load supplies the normal/hidden ranges and random-selection
 * sentinel consumed by LaunchGameStage (FxServer.exe 0043084B / 00420BB3). */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { CFastFile } from "../src/FXGS/FastFile.ts";
import { CIDFMan } from "../src/FXGS/IDFMan.ts";
import { CBomberAttr } from "../src/FXGS/BomberAttr.ts";

let savedIDF: CIDFMan | null;
let savedBomber: CBomberAttr | null;
let attr: CBomberAttr;
beforeEach(() => {
  savedIDF = CIDFMan.ms_pInstance;
  savedBomber = CBomberAttr.ms_pInstance;
  attr = new CBomberAttr();
});
afterEach(() => {
  CIDFMan.ms_pInstance = savedIDF;
  CBomberAttr.ms_pInstance = savedBomber;
});

function install(data: Uint8Array): void {
  const man = Object.create(CIDFMan.prototype) as CIDFMan;
  man.m_FastFile = new CFastFile();
  man.m_FastFile.m_pData = data;
  man.m_FastFile.m_vtEntry = [{ strName: "Attr/BomberAttr", offset: 0, length: data.length }];
  man.m_FastFile.m_nDataCount = 1;
  CIDFMan.ms_pInstance = man;
}
function dwords(...values: number[]): Buffer {
  const result = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => result.writeInt32LE(value | 0, i * 4));
  return result;
}
function record(name: string, values = [0, 5, 7, 1, 10, 1, 7, 10, 100, 9]): Buffer {
  return Buffer.concat([dwords(name.length), Buffer.from(name, "latin1"), dwords(...values)]);
}
function shipped(): void {
  new CIDFMan(join(import.meta.dir, "..", "data", "FxServer"));
}

describe("CBomberAttr binary layout and lifecycle", () => {
  test("shipped ten records have eight normal and two hidden bombers, with sentinel 10", () => {
    shipped();
    expect(attr.Load()).toBe(true);
    expect(attr.GetTotalCount()).toBe(10);
    expect(attr.GetNormalCount()).toBe(8);
    expect(attr.m_nHiddenCount).toBe(2);
    expect(attr.GetRandomBomberIdx()).toBe(10);
    expect(attr.m_vtAttr.map((r) => r.strName)).toEqual([
      "Character/C00", "Character/C01", "Character/C03", "Character/C05", "Character/C04",
      "Character/C06", "Character/C02", "Character/C07", "Character/C08", "Character/C09",
    ]);
    expect(attr.m_vtAttr[0]).toEqual({
      strName: "Character/C00", nAttr1: 0, nCurrentSpeed: 5, nAttr3: 7,
      nBombCount: 1, nAttr5Clamped: 10, nBombPower: 1, nAttr7: 7,
      nAttr8: 10, nAttr9: 100, nAttr10: 9,
    });
    expect([-1, 0, 7, 8, 9, 10, 11].map((idx) => attr.IsValidSelectIdx(idx))).toEqual([
      false, true, true, false, false, true, false,
    ]);
    expect([attr.GetCurrentSpeed(8), attr.GetBombCount(8), attr.GetBombPower(8)]).toEqual([6, 3, 3]);
  });

  test("reloading resets both counts and the table, rather than moving the random sentinel", () => {
    shipped();
    expect(attr.Load()).toBe(true);
    const initial = attr.m_vtAttr.map((r) => ({ ...r }));
    expect(attr.Load()).toBe(true);
    expect(attr.m_vtAttr).toEqual(initial);
    expect(attr.GetTotalCount()).toBe(10);
    expect(attr.GetNormalCount()).toBe(8);
    expect(attr.GetRandomBomberIdx()).toBe(10);
    install(record("replacement"));
    expect(attr.Load()).toBe(true);
    expect(attr.m_vtAttr).toHaveLength(1);
    expect(attr.GetTotalCount()).toBe(1);
    expect(attr.m_nHiddenCount).toBe(0);
  });

  test("signed attrs and the signed upper-only clamp match the original", () => {
    install(record("signed", [-1, -2, -3, -4, -5, -6, -7, -8, -9, -10]));
    expect(attr.Load()).toBe(true);
    expect(attr.GetNormalCount()).toBe(0);
    expect(attr.m_nHiddenCount).toBe(1);
    expect(attr.m_vtAttr[0]).toEqual({
      strName: "signed", nAttr1: -1, nCurrentSpeed: -2, nAttr3: -3,
      nBombCount: -4, nAttr5Clamped: -5, nBombPower: -6, nAttr7: -7,
      nAttr8: -8, nAttr9: -9, nAttr10: -10,
    });
    install(record("clamp", [0, 1, 2, 3, 11, 5, 6, 7, 8, 9]));
    expect(attr.Load()).toBe(true);
    expect(attr.m_vtAttr[0]!.nAttr5Clamped).toBe(10);
  });

  test.each([-1, 0, 54])("invalid name length %i returns failure with only the complete prefix", (length) => {
    shipped();
    attr.Load();
    install(Buffer.concat([record("prefix"), dwords(length)]));
    expect(attr.Load()).toBe(false);
    expect(attr.m_vtAttr.map((r) => r.strName)).toEqual(["prefix"]);
    expect(attr.GetTotalCount()).toBe(1);
    expect(attr.GetNormalCount()).toBe(1);
    expect(attr.GetRandomBomberIdx()).toBe(1);
  });

  test("name length 53 is accepted and byte strings are not decoded as UTF-8", () => {
    install(Buffer.concat([record("a".repeat(53)), record("\xa4\xa5\0ignored")]));
    expect(attr.Load()).toBe(true);
    expect(attr.m_vtAttr[0]!.strName).toBe("a".repeat(53));
    expect(attr.m_vtAttr[1]!.strName).toBe("\xa4\xa5");
  });

  test("every truncated record boundary fails without exposing a partial record", () => {
    const prefix = record("prefix");
    const second = record("second");
    for (let length = 1; length < second.length; length++) {
      install(Buffer.concat([prefix, second.subarray(0, length)]));
      expect(attr.Load()).toBe(false);
      expect(attr.m_vtAttr.map((r) => r.strName)).toEqual(["prefix"]);
      expect(attr.GetTotalCount()).toBe(1);
    }
  });

  test("empty file succeeds with zero counts; missing file also clears the old counts but fails", () => {
    shipped();
    attr.Load();
    install(Buffer.alloc(0));
    expect(attr.Load()).toBe(true);
    expect(attr.GetTotalCount()).toBe(0);
    expect(attr.m_vtAttr).toEqual([]);
    shipped();
    attr.Load();
    CIDFMan.ms_pInstance = null;
    const report = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(attr.Load()).toBe(false);
      expect(attr.GetTotalCount()).toBe(0);
      expect(attr.m_nHiddenCount).toBe(0);
      expect(attr.m_vtAttr).toEqual([]);
    } finally { report.mockRestore(); }
  });
});
