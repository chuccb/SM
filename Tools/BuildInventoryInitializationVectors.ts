import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";
import { CPeImage, OFFICIAL_SERVICES } from "./OfficialSource.ts";

// ONLY read supplied PE. Compile/run OUR model; never old EXE/SQL/WinAPI.
const game = new CPeImage(OFFICIAL_SERVICES.FXGS),
  login = new CPeImage(OFFICIAL_SERVICES.LS);
const anchors = [
  [0x0040af6d, "e882fdffff", "InitPreInventory BEFORE owned rowset"],
  [0x0040af72, "85c0", "pre result tested"],
  [0x0040af74, "0f8413010000", "failed pre short-circuits owned stage"],
  [0x0040b040, "e84b670300", "owned rowset open AFTER pre prefix"],
  [0x0040b045, "85c0", "owned open result tested"],
  [0x0040b047, "0f8548010000", "owned open failure returns0, no pre undo"],
  [0x0040b0d5, "0fbf4dbc", "owned validity signed SHORT"],
  [0x0040b0d9, "8b87c0070000", "cached level AFTER pre XP prefix"],
  [0x0040b0df, "3bc1", "signed cached-level comparison"],
  [0x0040b0ef, "e82c870200", "per-known-row clock even when level invalid"],
  [0x0040b0f9, "e852870200", "current CTime DATE"],
  [0x0040b104, "e847870200", "stored CTime DATE"],
  [0x0040b10d, "0f859d000000", "level invalid AFTER both conversions"],
  [0x0040b116, "ded9", "raw floating DATE comparison"],
  [0x0040b11d, "0f848f000000", "strict numeric greater-than expiration"],
  [0x0040b15a, "e81cca0000", "accepted row AddInventory"],
  [0x0040b15f, "807e0405", "definition Category5 level icon"],
  [0x0040b165, "807d94ff", "equipped Slot differs from255"],
  [0x0040b17d, "807e0406", "definition Category6 fake level"],
  [0x0040b18c, "89b7c4070000", "fake level from definition nAttr1"],
  [0x0040b192, "ff4508", "accepted AND missing rows count; expired do not"],
  [0x0040b19b, "e8d05f0300", "fetch BEFORE count400 test"],
  [0x0040b09d, "817d0890010000", "owned independent400 counter"],
  [0x0040aeab, "e8c4b90000", "pre SetLevel BEFORE failed/successful LoadOn"],
] as const;
for (const [VA, Bytes] of anchors)
  if (game.read(VA, Bytes.length / 2).toString("hex") !== Bytes)
    throw new Error(`Unexpected initialization anchor @${VA.toString(16)}`);
const size = game.read(game.symbolVA("kLevelTableSize"), 4).readUInt32LE(),
  bytes = game.read(game.symbolVA("g_nLevel2ExpTable"), size * 4);
if (
  size !== 450 ||
  size !== login.read(login.symbolVA("kLevelTableSize"), 4).readUInt32LE() ||
  !bytes.equals(login.read(login.symbolVA("g_nLevel2ExpTable"), size * 4))
)
  throw new Error("Initialization model LS/GS level inputs disagree");
mkdirSync(".analysis/reference", { recursive: true });
writeFileSync(
  ".analysis/reference/inventory-initialization-levels.h",
  `// Read-only GS ${game.sha256} / LS ${login.sha256}\nstatic constexpr std::array<std::int32_t, ${size}> levels{{${Array.from({ length: size }, (_, i) => bytes.readInt32LE(i * 4)).join(",")}}};\n`,
);
const exe = resolve(".analysis/reference/inventory-initialization"),
  build = Bun.spawnSync([
    "g++",
    "-std=c++17",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "-fno-fast-math",
    "-ffp-contract=off",
    "-I.analysis/reference",
    "tests/reference/inventory-initialization.cpp",
    "-o",
    exe,
  ]);
if (build.exitCode) throw new Error(build.stderr.toString());
const run = Bun.spawnSync([exe]);
if (run.exitCode) throw new Error(run.stderr.toString());
const data: { Model: string; Cases: unknown[] } = JSON.parse(
  run.stdout.toString(),
);
writeFileSync(
  "tests/fixtures/inventory-initialization-vectors.json",
  await format(
    JSON.stringify({
      ...data,
      OfficialPE: { Service: "FXGS", SHA256: game.sha256 },
      LevelInput: {
        LoginSHA256: login.sha256,
        GameSHA256: game.sha256,
        Entries: size,
      },
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
  `Generated ${anchors.length} PE anchors / ${data.Cases.length} independent observed initialization cases. NOT native SQL/financial/API/client proof.`,
);
