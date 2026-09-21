/** CRT arithmetic and STL shuffle, pinned to the shipped PE rather than a
 * guessed libc implementation. Native addresses refer to FXGS/FxServer.exe. */
import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CRand, RAND_MAX } from "../src/core/CRand.ts";

/** Translate PE32 virtual addresses via section headers (no objdump needed
 * to run the regression suite, and no copied executable fixture). */
function peCode(executable: "FXGS/FxServer.exe" | "FXSS/FxShop.exe", va: number, length: number): Buffer {
  const pe = readFileSync(join(import.meta.dir, "..", "..", executable));
  const nt = pe.readUInt32LE(0x3c);
  const opt = nt + 24;
  const rva = va - pe.readUInt32LE(opt + 28);
  const sections = opt + pe.readUInt16LE(nt + 20);
  for (let i = 0; i < pe.readUInt16LE(nt + 6); i++) {
    const section = sections + i * 40;
    const start = pe.readUInt32LE(section + 12);
    const size = pe.readUInt32LE(section + 16);
    if (rva < start || rva + length > start + size) continue;
    const offset = pe.readUInt32LE(section + 20) + rva - start;
    return pe.subarray(offset, offset + length);
  }
  throw new Error(`No raw PE section for VA ${va.toString(16)}`);
}

const nativeCode = (va: number, length: number) => peCode("FXGS/FxServer.exe", va, length);

describe("CRT rand/srand (FxServer 0046EA52; FxShop 00462800)", () => {
  test("the executable confirms the recurrence, TLS state offset, mask and initial seed", () => {
    expect(nativeCode(0x46ea52, 13).toString("hex")).toBe(
      "e8ba5b0000" + // call __getptd
      "8b4c2404" +   // ecx = seed argument
      "894814c3",    // [eax+14h] = ecx; ret
    );
    expect(nativeCode(0x46ea5f, 34).toString("hex")).toBe(
      "e8ad5b0000" + // call __getptd, NOT one global variable
      "8b4814" +    // ecx = [eax+14h]
      "69c9fd430300" + "81c1c39e2600" + // imul 343FDh; add 269EC3h
      "8948148bc1c1e81025ff7f0000c3",    // store; shr 16; and 7FFFh; ret
    );
    expect(nativeCode(0x474659, 7).toString("hex")).toBe("c7461401000000"); // initial state = 1
  });

  test("FxShop links the same TLS recurrence used by charge-key generation", () => {
    expect(peCode("FXSS/FxShop.exe", 0x462800, 13).toString("hex")).toBe(
      "e8534e00008b4c2404894814c3",
    );
    expect(peCode("FXSS/FxShop.exe", 0x46280d, 34).toString("hex")).toBe(
      "e8464e00008b481469c9fd43030081c1c39e26008948148bc1c1e81025ff7f0000c3",
    );
    expect(peCode("FXSS/FxShop.exe", 0x467650, 7).toString("hex")).toBe("c7401401000000");
  });

  test.each([
    [0, [38, 7719, 21238, 2437, 8855, 11797, 8365, 32285, 10450, 30612]],
    [1, [41, 18467, 6334, 26500, 19169, 15724, 11478, 29358, 26962, 24464]],
    [0xffffffff, [35, 29739, 3374, 11141, 31308, 7870, 5253, 2445, 26706, 3992]],
    [0xdeadbeef, [18337, 16920, 18732, 19770, 16163, 20831, 31795, 19149, 22193, 23838]],
  ] as [number, number[]][])("seed %i reproduces the fixed CRT vector", (seed, expected) => {
    const random = new CRand(seed);
    expect(expected.map(() => random.rand())).toEqual(expected);
    random.srand(seed);
    expect(expected.map(() => random.rand())).toEqual(expected);
  });

  test("10,000 draws per boundary seed agree with independent BigInt/u32 arithmetic", () => {
    for (const seed of [0, 1, 0x7fffffff, 0x80000000, 0xffffffff]) {
      const random = new CRand(seed);
      let state = BigInt(seed);
      const expected: number[] = [];
      const actual: number[] = [];
      for (let i = 0; i < 10000; i++) {
        state = BigInt.asUintN(32, state * 214013n + 2531011n);
        expected.push(Number((state >> 16n) & 32767n));
        actual.push(random.rand());
      }
      expect(actual).toEqual(expected);
      expect(Math.max(...actual)).toBeLessThanOrEqual(RAND_MAX);
      expect(Math.min(...actual)).toBeGreaterThanOrEqual(0);
    }
  });

  test("default seed is 1; unsigned srand retains zero and wraps input to a DWORD", () => {
    expect(new CRand().rand()).toBe(41);
    const random = new CRand();
    random.srand(0);
    expect(random.rand()).toBe(38);
    random.srand(-1);
    expect(random.rand()).toBe(35);
    random.srand(0x100000001);
    expect(random.rand()).toBe(41);
  });

  test("streams are independent, persistent, and do not delegate to Math.random", () => {
    const hostRandom = spyOn(Math, "random").mockImplementation(() => { throw new Error("host RNG used"); });
    try {
      const a = new CRand(1);
      const b = new CRand(1);
      expect(a.rand()).toBe(41);
      expect(a.rand()).toBe(18467);
      expect(b.rand()).toBe(41);
      b.srand(0);
      expect(b.rand()).toBe(38);
      expect(a.rand()).toBe(6334);
      expect(hostRandom).not.toHaveBeenCalled();
    } finally { hostRandom.mockRestore(); }
  });
});

describe("_STL::random_shuffle (0041DAFD)", () => {
  test.each([
    [0, [2, 0, 6, 1, 3, 7, 4, 5], 32285],
    [1, [4, 1, 6, 2, 0, 5, 7, 3], 29358],
    [0xffffffff, [5, 4, 6, 0, 1, 7, 3, 2], 2445],
  ] as [number, number[], number][])("seed %i: forward swaps and exactly seven draws", (seed, expected, next) => {
    const random = new CRand(seed);
    const positions = [0, 1, 2, 3, 4, 5, 6, 7];
    random.random_shuffle(positions);
    expect(positions).toEqual(expected);
    expect(random.rand()).toBe(next);
  });

  test("zero or one entry consumes no draws; two entries consumes one", () => {
    const random = new CRand(1);
    const empty: number[] = [];
    const one = [7];
    random.random_shuffle(empty);
    random.random_shuffle(one);
    expect(empty).toEqual([]);
    expect(one).toEqual([7]);
    expect(random.rand()).toBe(41);
    const pair = [6, 9];
    random.random_shuffle(pair); // 18467 % 2 == 1; self-swap still consumes a draw
    expect(pair).toEqual([6, 9]);
    expect(random.rand()).toBe(6334);
  });
});
