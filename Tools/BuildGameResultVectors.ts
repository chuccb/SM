import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";
import { CPeImage, OFFICIAL_SERVICES } from "./OfficialSource.ts";

// Opt-in manual C++ reference. Does not import CGameSession/CUser/the TS
// calculator or execute the supplied PE. Tests use only the frozen JSON.
const login = new CPeImage(OFFICIAL_SERVICES.LS);
const game = new CPeImage(OFFICIAL_SERVICES.FXGS);
const size = login.read(login.symbolVA("kLevelTableSize"), 4).readUInt32LE();
const bytes = login.read(login.symbolVA("g_nLevel2ExpTable"), size * 4);
if (
  size !== game.read(game.symbolVA("kLevelTableSize"), 4).readUInt32LE() ||
  !bytes.equals(game.read(game.symbolVA("g_nLevel2ExpTable"), size * 4))
)
  throw new Error("Different LS/GS level tables");
const rampBits = game.read(0x0048f5e0, 4).readUInt32LE();
const shopMultiplier = game.read(0x0048f5d0, 8).readDoubleLE();
const premiumBonus = game.read(0x0048f5c8, 8).readDoubleLE();
if (rampBits !== 0x380bcf65 || shopMultiplier !== 1.05 || premiumBonus !== 0.1)
  throw new Error("Unexpected native game result constants");
mkdirSync(".analysis/reference", { recursive: true });
writeFileSync(
  ".analysis/reference/scoring-levels.h",
  `// Independently extracted from LS ${login.sha256} / GS ${game.sha256}\n` +
    `static constexpr std::array<int32_t, ${size}> levels{{${Array.from({ length: size }, (_, i) => bytes.readInt32LE(i * 4)).join(",")}}};\n`,
);
writeFileSync(
  ".analysis/reference/game-result-rules.h",
  `// Read-only PE constants from FXGS ${game.sha256}\n` +
    `static constexpr uint32_t rampBits = 0x${rampBits.toString(16)}u;\n` +
    `static constexpr double shopMultiplier = ${shopMultiplier};\n` +
    `static constexpr double premiumBonus = ${premiumBonus};\n`,
);
const executable = resolve(".analysis/reference/game-result");
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
  "tests/reference/game-result.cpp",
  "-o",
  executable,
]);
if (build.exitCode) throw new Error(build.stderr.toString());
const run = Bun.spawnSync([executable]);
if (run.exitCode) throw new Error(run.stderr.toString());
const parsed: unknown = JSON.parse(run.stdout.toString());
writeFileSync(
  "tests/fixtures/game-result-vectors.json",
  await format(JSON.stringify(parsed, null, 2), { parser: "json" }),
);
console.log(
  "Generated manual C++ result163/XP vectors; NOT native execution, settlement or client evidence.",
);
