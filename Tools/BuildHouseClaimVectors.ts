import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";
import { CPeImage, OFFICIAL_SERVICES } from "./OfficialSource.ts";

// Read-only native instructions; compile/run ONLY OUR manual C++ translation.
// No production packet/session/user/resource/arithmetic implementation imports.
const image = new CPeImage(OFFICIAL_SERVICES.FXGS);
const anchors = [
  [0x0041d94f, "e86cd20100", "actor BYTE"],
  [0x0041d95a, "e861d20100", "house count BYTE"],
  [0x0041d96d, "83e01f", "slot color masked to five bits"],
  [0x0041d973, "68b2000000", "response178"],
  [0x0041d9c8, "7c4f", "negative row branch (unreachable for decoded BYTE)"],
  [0x0041d9cd, "7d4a", "row upper bound13"],
  [0x0041d9d1, "7c46", "negative column branch"],
  [0x0041da0a, "ff45fc", "accepted count increases only for new cells"],
  [0x0041da14, "e8feddffff", "write owner/count"],
  [0x0041da2d, "6a05", "literal5 section marker, not money"],
  [0x0041da8b, "e82addffff", "allocate generated box"],
  [0x0041da96, "7433", "native exhaustion breaks record loop"],
  [0x0041dacb, "ff75f4", "native patches REQUESTED count even on exhaustion"],
  [
    0x0041dadb,
    "e89ac0ffff",
    "native sends before award (modern ordering differs)",
  ],
  [0x0041daeb, "8d0480", "five money per accepted cell"],
  [0x0041daf1, "e8f6b5feff", "native IncDecMoney even for zero delta"],
  [0x0041b7ba, "81c134130000", "allocator context+4916"],
  [0x0041b7c2, "3dfa000000", "box upper bound250"],
  [0x0041b7c9, "83c8ff", "exhaustion returns -1"],
  [0x0041b7cd, "8d5001", "allocate then increment"],
  [0x0041b824, "6bc00f", "house board row stride15"],
  [0x0041b82b, "891481", "write owner"],
  [0x00421586, "e8b6c3ffff", "dispatcher161 calls house"],
  [0x0041d9d3, "83f90f", "column upper bound15"],
  [0x0041d9e9, "833c91ff", "only state minus1 accepts cell"],
  [0x0041b836, "83f808", "count only colors below8"],
  [0x0041b83e, "ff00", "signed32 house count increment"],
  [0x00409109, "0108", "native wallet ADD wraps32 bits"],
  [0x0040910d, "7905", "clamp negative wrapped money to0"],
  [0x00409114, "ba40420f00", "maximum wallet1000000"],
  [0x00409123, "c787b807000001000000", "dirty intent even for delta0"],
] as const;
for (const [va, bytes] of anchors)
  if (image.read(va, bytes.length / 2).toString("hex") !== bytes)
    throw new Error(`Unexpected house instruction at ${va.toString(16)}`);
mkdirSync(".analysis/reference", { recursive: true });
const executable = resolve(".analysis/reference/house-claim");
const build = Bun.spawnSync([
  "g++",
  "-std=c++17",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-O2",
  "tests/reference/house-claim.cpp",
  "-o",
  executable,
]);
if (build.exitCode) throw new Error(build.stderr.toString());
const run = Bun.spawnSync([executable]);
if (run.exitCode) throw new Error(run.stderr.toString());
const data: Record<string, unknown> = JSON.parse(run.stdout.toString());
writeFileSync(
  "tests/fixtures/house-claim-vectors.json",
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
  "Generated independent manual C++ house161/178/board/allocator/5-money vectors; NOT original execution/client/security proof.",
);
