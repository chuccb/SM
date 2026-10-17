import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { format } from "prettier";
import { CPeImage, OFFICIAL_SERVICES } from "./OfficialSource.ts";
const game = new CPeImage(OFFICIAL_SERVICES.FXGS);
// Whole setters/handlers and mode-independent CanStart are read-only evidence.
// Only OUR manually translated projection compiles and executes.
const images = [
  [
    0x0041b509,
    94,
    "78fc7236f005fd37618fc59480c1b78e9d0bde813f8a92fb542e5e43d768c277",
    "entire Normal setter; only +948 and93, no votes/Manner/clock/strategy",
  ],
  [
    0x0041b567,
    97,
    "4a523bcccb001e0cb448c859807d954dbdb08174b361346c2a6a4303f434f69a",
    "entire Mod setter through its ownRET; adjacentC3 not included",
  ],
  [
    0x0041c783,
    65,
    "7a6a00418f2ac4722d20712188ee1004e7733b30909ddd50be205b9fca7f8e87",
    "entire request102 handler: chief gate, no playing/vote condition",
  ],
  [
    0x0041c7c4,
    65,
    "6998c98cc365d148e82664fb323eca02d5174ae265b043df0e81d45ebf581ecc",
    "entire request103 handler: chief gate, no playing/vote condition",
  ],
  [
    0x0041c805,
    447,
    "fd8118e59d3f6efba3016032d91a59b33c6ec836857dc298f905dbc7a53859cc",
    "entire CanStartGame: does not read mode+948",
  ],
] as const;
for (const [VA, Length, SHA256] of images)
  if (
    createHash("sha256").update(game.read(VA, Length)).digest("hex") !== SHA256
  )
    throw new Error(`Unexpected game-type whole image@${VA.toString(16)}`);
const anchors = [
  [0x0041b51a, "83a6b403000000", "DWORD +948 cleared, NOT Manner+844"],
  [0x0041b521, "6a5d", "Normal93 opcode only"],
  [0x0041b531, "85ff", "nonnull explicit recipient branch"],
  [0x0041b53d, "ff5044", "Normal targeted socket publication"],
  [0x0041b548, "e82de6ffff", "Normal null-recipient room publication"],
  [0x0041b578, "6a5c", "Mod92 opcode only"],
  [0x0041b57f, "c786b403000001000000", "DWORD +948 set exactly1"],
  [0x0041b592, "85ff", "Mod explicit recipient or room"],
  [0x0041b59e, "ff5044", "Mod targeted socket publication"],
  [0x0041b5a9, "e8cce5ffff", "Mod room publication"],
  [0x0041c783, "8b8160030000", "102 chief slot"],
  [0x0041c78d, "83f808", "102 chief slot range8"],
  [0x0041c79a, "8b80a4070000", "102 actual chief socket"],
  [0x0041c7a0, "3b442404", "102 requester socket comparison"],
  [0x0041c7a6, "33d2", "102 setter null recipient means room broadcast"],
  [0x0041c7a8, "e85cedffff", "102 invokes actual Normal setter"],
  [0x0041c7c4, "8b8160030000", "103 chief slot"],
  [0x0041c7ce, "83f808", "103 chief slot range8"],
  [0x0041c7db, "8b80a4070000", "103 actual chief socket"],
  [0x0041c7e1, "3b442404", "103 requester comparison"],
  [0x0041c7e7, "33d2", "103 room broadcast"],
  [0x0041c7e9, "e879edffff", "103 actual Mod setter"],
  [
    0x004216e6,
    "c20400",
    "ordinary strategy DestroyPlayer is independently native RET4",
  ],
] as const;
for (const [VA, Bytes] of anchors)
  if (game.read(VA, Bytes.length / 2).toString("hex") !== Bytes)
    throw new Error(`Unexpected mode anchor@${VA.toString(16)}`);
mkdirSync(".analysis/reference", { recursive: true });
const exe = resolve(".analysis/reference/game-type-transition"),
  build = Bun.spawnSync([
    "g++",
    "-std=c++17",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "tests/reference/game-type-transition.cpp",
    "-o",
    exe,
  ]);
if (build.exitCode) throw new Error(build.stderr.toString());
const run = Bun.spawnSync([exe]);
if (run.exitCode) throw new Error(run.stderr.toString());
const data: Record<string, unknown> = JSON.parse(run.stdout.toString());
writeFileSync(
  "tests/fixtures/game-type-transition-vectors.json",
  await format(
    JSON.stringify({
      ...data,
      OfficialPE: { SHA256: game.sha256 },
      FunctionImages: images.map(([VA, Length, SHA256, Meaning]) => ({
        VA,
        Length,
        SHA256,
        Meaning,
      })),
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
  `Generated ${images.length} full images/${anchors.length} literal anchors/${data.CaseCount} manual game-type cases; NOT Mod combat,financial or client proof.`,
);
