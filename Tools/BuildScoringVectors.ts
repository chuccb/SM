import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";
import { CPeImage, OFFICIAL_SERVICES } from "./OfficialSource.ts";

// Opt-in. Never imports the TypeScript calculator. Native PE inputs are READ,
// not executed. Ordinary bun test uses only the checked-in frozen JSON.
const login = new CPeImage(OFFICIAL_SERVICES.LS);
const game = new CPeImage(OFFICIAL_SERVICES.FXGS);
const size = login.read(login.symbolVA("kLevelTableSize"), 4).readUInt32LE();
const bytes = login.read(login.symbolVA("g_nLevel2ExpTable"), 4 * size);
if (
  size !== game.read(game.symbolVA("kLevelTableSize"), 4).readUInt32LE() ||
  !bytes.equals(game.read(game.symbolVA("g_nLevel2ExpTable"), 4 * size))
)
  throw new Error(
    "Cannot generate shared scoring vectors for different LS/GS level tables",
  );
const levels = Array.from({ length: size }, (_, i) => bytes.readInt32LE(i * 4));
mkdirSync(".analysis/reference", { recursive: true });
writeFileSync(
  ".analysis/reference/scoring-levels.h",
  `// Independently extracted from LS ${login.sha256} / GS ${game.sha256}\n` +
    `static constexpr std::array<int32_t, ${size}> levels{{${levels.join(",")}}};\n`,
);
const executable = resolve(".analysis/reference/scoring");
const build = Bun.spawnSync([
  "g++",
  "-std=c++17",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-O2",
  "-fno-fast-math",
  "-ffp-contract=off",
  "-I.analysis/reference",
  "tests/reference/scoring.cpp",
  "-o",
  executable,
]);
if (build.exitCode) throw new Error(build.stderr.toString());
const run = Bun.spawnSync([executable]);
if (run.exitCode) throw new Error(run.stderr.toString());
const parsed: unknown = JSON.parse(run.stdout.toString());
writeFileSync(
  "tests/fixtures/scoring-vectors.json",
  await format(JSON.stringify(parsed, null, 2), { parser: "json" }),
);
console.log(
  "Generated manual C++ scoring/arbitration vectors; NOT original execution, settlement or client compatibility evidence.",
);
