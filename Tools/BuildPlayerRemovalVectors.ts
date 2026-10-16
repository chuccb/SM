import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";
import { CPeImage, OFFICIAL_SERVICES } from "./OfficialSource.ts";

// Opt-in build: READ supplied PE, run ONLY our manual C++ static model.
// No production sessions, regulators, game context, user or packet imports.
const game = new CPeImage(OFFICIAL_SERVICES.FXGS);
const anchors = [
  [0x00401047, "69c910270000", "CBanChief full-room10000 DWORD multiply"],
  [0x0040104f, "69c9204e0000", "CBanChief other-room20000 DWORD multiply"],
  [0x00401095, "69c088130000", "CBanChief odd-slot5000 DWORD multiply"],
  [0x00406f82, "83f905", "unique previous-room FIFO capacity5"],
  [
    0x00415161,
    "83be90000000ff",
    "sync stopped sentinel skips departure cleanup",
  ],
  [
    0x0041519d,
    "80b94003000000",
    "sync checks remaining player COUNT after removal",
  ],
  [0x004164f4, "ff5230", "UDP regulator calls table virtual DestroyPlayer"],
  [0x004164f7, "397e14", "UDP primary safe-object flag guard AFTER removal"],
  [0x00416506, "39bef4000000", "UDP TCP closing flag guard AFTER removal"],
  [0x0041650e, "68c3000000", "UDP rejection opcode195 with no body fields"],
  [0x00416536, "c786d401000004000000", "pool4 assignment AFTER sending195"],
  [
    0x004194db,
    "83a18c00000000",
    "closing native room clears ONLY IsValid, not playing/context",
  ],
  [
    0x0048f61c,
    "db944100",
    "Game virtual+16 close hook is Base Destroy004194DB",
  ],
  [0x00419584, "8364811400", "Base DeleteUser clears player pointer"],
  [0x00419590, "8020fd", "Base DeleteUser clears only chief bit2"],
  [0x0041988d, "8b80a8070000", "native GetSlotidx reads retained CUser+1960"],
  [
    0x00419f72,
    "837d0c00",
    "optional departing-peer reset notification AFTER local loop",
  ],
  [0x0041bb1a, "e834f3ffff", "ghost departure BEFORE pointer deletion"],
  [0x0041bb25, "e8907d0000", "List/Base DestroyPlayer BEFORE sync cleanup"],
  [0x0041bb3f, "e80c96ffff", "single primary-slot OnPlayerLeave call"],
  [0x0041bb5d, "e8e9840000", "chief succession after deletion and sync"],
  [0x0041bb9c, "e842d9ffff", "DeleteAllSlotidx late in Game DestroyPlayer"],
  [0x0041bbe8, "e87bb3feff", "previous-room history after removal hooks"],
  [0x004216e6, "c20400", "ordinary strategy DestroyPlayer is native ret4"],
  [
    0x0042241e,
    "83bed401000004",
    "stale normal-session generation permits pool4",
  ],
  [0x00423df1, "83c130", "opaque DWORD matrix column stride48 bytes =12 words"],
  [
    0x00423dff,
    "808e5803000004",
    "List DeleteUser sets player-count modified bit4",
  ],
  [
    0x00423ecc,
    "399e54030000",
    "new-chief ready clearing is gated by NOT playing",
  ],
  [
    0x0048f7ec,
    "e6164200",
    "ordinary strategy vtable+24 points to empty departure hook",
  ],
] as const;
for (const [va, bytes] of anchors)
  if (game.read(va, bytes.length / 2).toString("hex") !== bytes)
    throw new Error(
      `Unexpected player-removal instruction at ${va.toString(16)}`,
    );
mkdirSync(".analysis/reference", { recursive: true });
const executable = resolve(".analysis/reference/player-removal");
const build = Bun.spawnSync([
  "g++",
  "-std=c++17",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-O2",
  "tests/reference/player-removal.cpp",
  "-o",
  executable,
]);
if (build.exitCode) throw new Error(build.stderr.toString());
const run = Bun.spawnSync([executable]);
if (run.exitCode) throw new Error(run.stderr.toString());
const data: Record<string, unknown> = JSON.parse(run.stdout.toString());
writeFileSync(
  "tests/fixtures/player-removal-vectors.json",
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
  "Generated manual C++ player-removal/ghost/chief/sync/history/CBanChief vectors; NOT native or client execution.",
);
