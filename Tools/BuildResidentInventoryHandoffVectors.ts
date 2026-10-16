import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";
import { CPeImage, OFFICIAL_SERVICES } from "./OfficialSource.ts";

// Native anchors prove WIRE roles. Resident/mixed-mode transport is MODERN.
// Compile/run ONLY our C++; never supplied EXE/DAT/SQL/Windows APIs.
const game = new CPeImage(OFFICIAL_SERVICES.FXGS),
  login = new CPeImage(OFFICIAL_SERVICES.LS);
const anchors = [
  [0x004088fe, "68d2000000", "210 first"],
  [0x00408910, "8a401b", "210 GameAttr low BYTE"],
  [0x0040895a, "8b45d4", "ONLY first local's initialized flag"],
  [0x0040895f, "3988d8070000", "initialized DWORD ==0 gates202"],
  [0x00408968, "752b", "nonzero first flag skips202"],
  [0x0040896a, "68ca000000", "202 opcode"],
  [0x00408981, "e868660000", "202 real UserItem definitions"],
  [0x00408994, "41", "202 forces later201"],
  [0x004089a0, "83ba8007000000", "ANY local pre count >0"],
  [0x004089b4, "7ce6", "test ALL locals, not just first"],
  [0x004089ba, "7446", "only skip207 when EVERY local is empty"],
  [0x004089bc, "68cf000000", "207 response, not delete request"],
  [0x004089cf, "e88c120300", "207 local-user count BYTE"],
  [0x004089e3, "e8c1e20000", "207 actual per-user pre body"],
  [0x004089f1, "7ce5", "emit ALL locals, including empty bodies"],
  [0x00408a01, "41", "207 forces201 even for initialized first user"],
  [0x00408a02, "85c9", "201 iff202 OR207 was sent"],
  [0x00408a06, "68c9000000", "201 response follows207"],
  [0x00408a19, "e842120300", "201 local-user count BYTE"],
  [0x00408a33, "e8d4e10000", "201 actual per-user owned body"],
  [0x00416ccc, "8a8b80070000", "207 individual pre count BYTE"],
  [0x00416d2a, "80780465", "207 cached level only for Category101"],
  [0x00416d4f, "7d02", "207 SIGNED period threshold100000"],
  [0x00416d68, "8d4f10", "207 Description follows pre strAttr"],
  [0x00416c33, "6a54", "native84-byte resident stride"],
  [0x00416c41, "ff561c", "201 DWORD owned count"],
  [0x00416c4c, "ff36", "201 ItemSn not StockSn or legacy rowid"],
  [0x00416c59, "8a4e24", "201 Slot BYTE"],
  [0x00416c62, "ff7628", "201 Amount DWORD"],
  [0x00416c6e, "8d4e2c", "201 resident Verbose"],
  [0x00416c77, "8d4e38", "201 stored CTime source"],
  [0x00416c84, "6a08", "201 raw double8, not scalar XOR"],
  [0x00416c8f, "83c654", "201 preserves native resident order"],
] as const;
for (const [VA, Bytes] of anchors)
  if (game.read(VA, Bytes.length / 2).toString("hex") !== Bytes)
    throw new Error(
      `Unexpected inventory handoff PE anchor @${VA.toString(16)}`,
    );
const size = game.read(game.symbolVA("kLevelTableSize"), 4).readUInt32LE(),
  bytes = game.read(game.symbolVA("g_nLevel2ExpTable"), size * 4);
if (
  size !== login.read(login.symbolVA("kLevelTableSize"), 4).readUInt32LE() ||
  !bytes.equals(login.read(login.symbolVA("g_nLevel2ExpTable"), size * 4))
)
  throw new Error("LS/GS handoff model level tables disagree");
mkdirSync(".analysis/reference", { recursive: true });
writeFileSync(
  ".analysis/reference/resident-inventory-handoff-levels.h",
  `// Independently read LS ${login.sha256} / GS ${game.sha256}\nstatic constexpr std::array<std::int32_t, ${size}> levels{{${Array.from({ length: size }, (_, i) => bytes.readInt32LE(i * 4)).join(",")}}};\n`,
);
const exe = resolve(".analysis/reference/resident-inventory-handoff"),
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
    "tests/reference/resident-inventory-handoff.cpp",
    "-o",
    exe,
  ]);
if (build.exitCode) throw new Error(build.stderr.toString());
const run = Bun.spawnSync([exe]);
if (run.exitCode) throw new Error(run.stderr.toString());
const data: Record<string, unknown> = JSON.parse(run.stdout.toString());
writeFileSync(
  "tests/fixtures/resident-inventory-handoff-vectors.json",
  await format(
    JSON.stringify({
      ...data,
      OfficialPE: { SHA256: game.sha256 },
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
  `Generated ${anchors.length} fixed anchors /254 resident/mixed-mode wire cases; NOT native SQL initialization, freshness, financial or client proof.`,
);
