import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";
import { CPeImage, OFFICIAL_SERVICES } from "./OfficialSource.ts";
const game = new CPeImage(OFFICIAL_SERVICES.FXGS);
// Fixed literal anchors, read-only. Only OUR composition model is compiled/run.
const anchors = [
  [0x00401106, "e8cfffffff", "Init calls SetOdd(false) FIRST"],
  [0x0040110f, "e8a7ffffff", "Init calls SetCanStart(false) SECOND"],
  [0x004010be, "ff159cb24800", "SetCanStart always takes its OWN WinMM sample"],
  [0x0041bb4e, "e8ae55feff", "ordinary departure of current chief calls Init"],
  [
    0x0041bbb2,
    "399e3c030000",
    "active vote tested AFTER deletion/sync/chief/flush/clear-slot",
  ],
  [
    0x0041bbbe,
    "ff9090000000",
    "ordinary departure synchronously reenters vtable144 vote tally",
  ],
  [0x0048f69c, "784f4200", "game vtable144 is real List.DeferBanPlayer"],
  [0x00424ff2, "398e3c030000", "target lookup uses GLOBAL serial"],
  [0x00424ffd, "8b84860c030000", "per-LOCAL vote DWORD"],
  [0x00425004, "85c0", "nonzero ballot contributes denominator"],
  [0x0042500b, "83f802", "YES exactly2"],
  [0x00425015, "83f803", "NO exactly3"],
  [0x00425060, "6a04", "missing target result4"],
  [0x00425087, "8d0c12", "double YES count"],
  [0x0042508d, "0f8ea5000000", "strict majority, not greater-or-equal"],
  [0x004250b3, "6a01", "second table departure includeSelf TRUE"],
  [0x004250b6, "ff5030", "same actual table destroys another whole group"],
  [0x004250cd, "6a02", "passed result2 after table removal/pool4"],
  [0x00425141, "7d10", "NO tie terminates"],
  [0x00425148, "7d09", "all answered terminates"],
  [0x00425168, "6a03", "failed result3"],
  [0x0041c327, "ff5044", "chief121 precedes table destruction/cascade"],
  [0x0041c33a, "ff5030", "odd chief removal enters ordinary table"],
  [0x0041c459, "ff5030", "ready chief removal enters ordinary table"],
  [
    0x0041c470,
    "e8464cfeff",
    "final ready SetCanStart(false) AFTER entire table/cascade",
  ],
] as const;
for (const [VA, Bytes] of anchors)
  if (game.read(VA, Bytes.length / 2).toString("hex") !== Bytes)
    throw new Error(`Unexpected cascade anchor@${VA.toString(16)}`);
mkdirSync(".analysis/reference", { recursive: true });
const executable = resolve(".analysis/reference/ban-player-cascade"),
  build = Bun.spawnSync([
    "g++",
    "-std=c++17",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "tests/reference/ban-player-cascade.cpp",
    "-o",
    executable,
  ]);
if (build.exitCode) throw new Error(build.stderr.toString());
const run = Bun.spawnSync([executable]);
if (run.exitCode) throw new Error(run.stderr.toString());
const data: Record<string, unknown> = JSON.parse(run.stdout.toString());
writeFileSync(
  "tests/fixtures/ban-player-cascade-vectors.json",
  await format(
    JSON.stringify({
      ...data,
      OfficialPE: { SHA256: game.sha256 },
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
  `Generated ${anchors.length} fixed anchors /${data.CaseCount} manual cascade compositions; NOT execution authority, original code, SQL or client proof.`,
);
