import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";
import { CPeImage, OFFICIAL_SERVICES } from "./OfficialSource.ts";

// READ the supplied PE; compile/run ONLY OUR independent manual C++ model.
// No production session, calculator, item, map, clock or packet imports.
const game = new CPeImage(OFFICIAL_SERVICES.FXGS);
const anchors = [
  [0x0041b1b3, "c3", "ordinary DoLaunchGameStageEx is actual native no-op"],
  [0x004209b9, "c3", "ordinary LaunchGameStageEx is actual native no-op"],
  [0x0048f6d0, "b3b14100", "launch pre-extension virtual+196"],
  [0x0048f6d4, "b9094200", "launch post-extension virtual+200"],
  [
    0x0048f980,
    "cc204200",
    "table virtual+12 is ClearModifiedFlag, NOT a game counter",
  ],
  [0x0041bde2, "e81a93ffff", "DoStart resets sync manager before clock"],
  [0x0041bdf7, "ff7054", "initial sync count reads map+84"],
  [0x0041be12, "e82cfaffff", "clock StartGame AFTER initial sync objects"],
  [0x0041be27, "ff500c", "clear native table cache flags"],
  [0x0041be3b, "c786d803000001000000", "stage Running=1 before150 encoding"],
  [0x0041be65, "33c2428911", "sequence XOR key, then DWORD sequence increment"],
  [0x0041be9c, "8b4064", "rebirth flag reads map+100, NOT a mission word"],
  [
    0x0041beab,
    "69c0e8030000",
    "ghost start seconds->milliseconds AFTER wire encoding",
  ],
  [
    0x0041bebd,
    "69c0e8030000",
    "ghost frequency seconds->milliseconds AFTER wire encoding",
  ],
  [
    0x00420df3,
    "e8e22a0000",
    "Launch SetPlaying AFTER calculator/pair traversal",
  ],
  [0x00420e08, "e88ebfffff", "Launch resets selected context"],
  [0x00420e3f, "88840e542d0000", "state byte is zero iff player occupied"],
  [0x00420e68, "89bea8030000", "Launch resets ghost count"],
  [
    0x00420e9f,
    "89860c310000",
    "launch timestamp is distinct from last Update tick",
  ],
  [
    0x00420eb7,
    "e8c1fcffff",
    "MissionInfo assignment uses separately constructed vector",
  ],
  [
    0x00423b69,
    "83b954030000007505",
    "playing DoSelectColor skips mutation, NOT its caller's108",
  ],
  [
    0x00423b7a,
    "83b954030000007505",
    "playing SelectBomber skips entire request",
  ],
  [
    0x0041c490,
    "83bb54030000000fbff8750e",
    "playing SelectMap skips waiting-selection write",
  ],
  [
    0x0041c4d3,
    "39b3540300000f8596020000",
    "playing SelectMap skips ALL normalization107",
  ],
  [
    0x004241f9,
    "399f540300000f85d2010000",
    "playing OpenCloseSlot skips entire request",
  ],
] as const;
for (const [va, hex] of anchors)
  if (game.read(va, hex.length / 2).toString("hex") !== hex)
    throw new Error(`Unexpected launch instruction at ${va.toString(16)}`);
mkdirSync(".analysis/reference", { recursive: true });
const executable = resolve(".analysis/reference/game-launch");
const build = Bun.spawnSync([
  "g++",
  "-std=c++17",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-O2",
  "tests/reference/game-launch.cpp",
  "-o",
  executable,
]);
if (build.exitCode) throw new Error(build.stderr.toString());
const run = Bun.spawnSync([executable]);
if (run.exitCode) throw new Error(run.stderr.toString());
const data: Record<string, unknown> = JSON.parse(run.stdout.toString());
writeFileSync(
  "tests/fixtures/game-launch-vectors.json",
  await format(
    JSON.stringify({
      ...data,
      OfficialPE: { Service: "FXGS", SHA256: game.sha256 },
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
  "Generated independent manual C++ launch/map/color/start/airplane/loading vectors; NOT native/client/verdict proof.",
);
