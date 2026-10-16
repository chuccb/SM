import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";
import { CPeImage, OFFICIAL_SERVICES } from "./OfficialSource.ts";

// Opt-in generation. Only READ the supplied PE; execute OUR manual C++ model.
// No production game clock/session/context/packet implementation is imported.
const game = new CPeImage(OFFICIAL_SERVICES.FXGS);
const anchors = [
  [0x00415b9a, "6890010000", "normal timer Sleep400"],
  [0x0048f994, "a2194200", "table vtable+32 is UpdateGameSessions"],
  [0x0048f998, "5a1a4200", "table vtable+36 is UpdateGameEtc"],
  [0x0041b193, "c3", "session UpdateGameEtc is a genuine native no-op"],
  [0x004219e7, "83c720", "eight-pointer normal-room stride"],
  [0x0041dd03, "2b8304310000", "entry tick minus last-update DWORD"],
  [0x0041de0c, "e803beffff", "queue bomb packet before server-die block"],
  [0x0041de25, "6a50", "grouped server-die header 0x50"],
  [0x0041de4f, "c745d870170000", "short pending-death timeout6000"],
  [0x0041de7a, "c745d810270000", "other-state timeout10000"],
  [0x0041de8b, "bf0f270000", "server-die entry coordinates9999"],
  [0x0041deb6, "2b04313b45d87247", "unsigned age >= deadline"],
  [0x0041dee1, "c60001", "expired pending state becomes inactive1"],
  [0x0041bfe4, "0f8461010000", "ordinary Normal OnBomberDie skips cascade"],
  [0x0041df34, "e8dbbcffff", "queue grouped death packet before flush"],
  [0x0041e0c0, "898304310000", "write ORIGINAL entry tick at end"],
] as const;
for (const [va, bytes] of anchors)
  if (game.read(va, bytes.length / 2).toString("hex") !== bytes)
    throw new Error(`Unexpected game-update instruction at ${va.toString(16)}`);

mkdirSync(".analysis/reference", { recursive: true });
const executable = resolve(".analysis/reference/game-update");
const build = Bun.spawnSync([
  "g++",
  "-std=c++17",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-O2",
  "tests/reference/game-update.cpp",
  "-o",
  executable,
]);
if (build.exitCode) throw new Error(build.stderr.toString());
const run = Bun.spawnSync([executable]);
if (run.exitCode) throw new Error(run.stderr.toString());
const parsed: Record<string, unknown> = JSON.parse(run.stdout.toString());
writeFileSync(
  "tests/fixtures/game-update-vectors.json",
  await format(
    JSON.stringify({
      ...parsed,
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
  "Generated manual C++ pending-state / grouped159 / frame-order vectors; NOT native execution or playable-client evidence.",
);
