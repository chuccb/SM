import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";
import { CPeImage, OFFICIAL_SERVICES } from "./OfficialSource.ts";

// Read-only instruction identity; execute OUR model, never the official EXE.
// No production ghost/session/map/clock/packet implementation imports.
const image = new CPeImage(OFFICIAL_SERVICES.FXGS);
const anchors = [
  [
    0x0048f6cc,
    "51cb4100",
    "virtual+192 is IsSlotInThisSocket, NOT a chief/dead/rebirth check",
  ],
  [
    0x0041f42d,
    "e88eb70100",
    "first request151 BYTE is opaque forwarded parameter",
  ],
  [0x0041f438, "e883b70100", "second request151 BYTE is room slot"],
  [
    0x0041f446,
    "ff90c0000000",
    "generate checks actor's socket via virtual+192",
  ],
  [0x0041f48b, "85c07411", "zero last-generation tick bypasses frequency gate"],
  [
    0x0041f494,
    "3b8e143100000f8247020000",
    "frequency compare uses unsigned JB; equality accepted",
  ],
  [
    0x0041f4ab,
    "3b86103100000f8230020000",
    "ElapsedTime >= ghost-start, unsigned, not active elapsed",
  ],
  [
    0x0041f4b7,
    "83bea8030000080f8d23020000",
    "signed ghost count >=8 blocks generation",
  ],
  [
    0x0041f4d4,
    "83be14310000000f8406020000",
    "frequency0 duplicate returns without diagnostic or mutation",
  ],
  [
    0x0041f61a,
    "898eac030000899c86880300008907ff86a8030000",
    "commit absolute last tick, inverse mappings and count increment",
  ],
  [0x0041f64a, "81cb80000000", "new166 owner byte has high bit80"],
  [
    0x0041f656,
    "ff75ec8b078bcfff5014",
    "new166 appends original opaque request byte",
  ],
  [
    0x0041b413,
    "83fb087d4f",
    "destroy request bounds a GHOST ID, not a local player index",
  ],
  [
    0x0041b426,
    "8d8c8e6803000039197407",
    "destroy requires reciprocal mapping only; caller is not compared",
  ],
  [
    0x0041b438,
    "8308ff8309ffff8ea8030000",
    "destroy clears both mappings then signed DWORD decrement",
  ],
  [0x0041b448, "68a7000000", "destroy emits167; no sender exclusion"],
] as const;
for (const [va, bytes] of anchors) {
  if (image.read(va, bytes.length / 2).toString("hex") !== bytes)
    throw new Error(`Unexpected ghost instruction at ${va.toString(16)}`);
}
mkdirSync(".analysis/reference", { recursive: true });
const executable = resolve(".analysis/reference/ghost");
const build = Bun.spawnSync([
  "g++",
  "-std=c++17",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-O2",
  "tests/reference/ghost.cpp",
  "-o",
  executable,
]);
if (build.exitCode) throw new Error(build.stderr.toString());
const run = Bun.spawnSync([executable]);
if (run.exitCode) throw new Error(run.stderr.toString());
const data: Record<string, unknown> = JSON.parse(run.stdout.toString());
writeFileSync(
  "tests/fixtures/ghost-vectors.json",
  await format(
    JSON.stringify({
      ...data,
      OfficialPE: { Service: "FXGS", SHA256: image.sha256 },
      InstructionAnchors: anchors.map(([VA, Bytes, Meaning]) => ({
        VA,
        Bytes,
        Meaning,
      })),
    }),
    { parser: "json" },
  ),
);
console.log(
  "Generated independent manual C++ ghost mappings/count/clock/wire vectors; NOT original execution, client or security proof.",
);
