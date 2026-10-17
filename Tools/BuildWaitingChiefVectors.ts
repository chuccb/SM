import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";
import { CPeImage, OFFICIAL_SERVICES } from "./OfficialSource.ts";

// Read-only supplied PE anchors; compile/run ONLY our independent C++ model.
// No session, authority, user, inventory or packet-codec production imports.
const game = new CPeImage(OFFICIAL_SERVICES.FXGS);
const anchors = [
  [0x0041688a, "33c0c20400", "HasAuthority ANY parameter always returns0"],
  [0x00416af1, "807e0802", "functional category2; no Slot/Amount test"],
  [0x00416aff, "e89f8a0500", "functional attribute exact __mbscmp"],
  [
    0x0048e4c8,
    "4974656d2f5375706572436869656600",
    "Item/SuperChief exact native bytes",
  ],
  [0x00401035, "ff159cb24800", "IsBanChief samples its OWN DWORD time"],
  [0x00401047, "69c910270000", "FULL room10000 DWORD multiply"],
  [0x0040104f, "69c9204e0000", "OTHER room20000 DWORD multiply"],
  [0x00401057, "7605", "ready limit is unsigned STRICT greater than"],
  [0x00401088, "69c010270000", "warning10000 DWORD multiply"],
  [0x00401095, "69c088130000", "odd capacity5000 DWORD multiply"],
  [0x004010be, "ff159cb24800", "SetCanStart samples time even when false"],
  [0x00401106, "e8cfffffff", "Init clears odd branch FIRST"],
  [0x0040110f, "e8a7ffffff", "Init SetCanStart(false) SECOND"],
  [0x0041bb4e, "e8ae55feff", "ordinary chief-left removal calls Init"],
  [0x0041c164, "399e54030000", "playing gate BEFORE chief lookup"],
  [0x0041c177, "e9854ffeff", "playing branch only resets helper"],
  [0x0041c18a, "83f808", "chief slot is bounded by8"],
  [0x0041c1a0, "399da4070000", "chief socket pointer required"],
  [0x0041c1bf, "83e70247", "functional flag selects multiplier3 versus1"],
  [0x0041c1c3, "ff159cb24800", "entry DWORD timestamp distinct from setters"],
  [
    0x0041c1d7,
    "80be4103000001",
    "NON-manner capacity+833 <=1, NOT current+832",
  ],
  [0x0041c1e4, "0fb68641030000", "MANNER parity reads CAPACITY+833"],
  [0x0041c1f5, "6a16", "odd authority query parameter22 (stub returns0)"],
  [0x0041c213, "6a01", "virtual CanStartGame argument1"],
  [0x0041c217, "ff90dc000000", "CanStartGame virtual+220"],
  [0x0041c21f, "0f8547020000", "nonzero CanStartGame resets ready timing"],
  [0x0041c26a, "76a5", "odd delay unsigned STRICT greater than"],
  [0x0041c281, "6a79", "121 warning opcode"],
  [0x0041c28d, "6a01", "odd WARNING reason1"],
  [0x0041c2a3, "b9e8030000", "warning seconds unsigned divide1000"],
  [
    0x0041c2e2,
    "0f8629ffffff",
    "odd warning expiry unsigned STRICT greater than",
  ],
  [0x0041c2f6, "6a03", "odd EJECTION reason3"],
  [0x0041c327, "ff5044", "chief-only121 BEFORE removal"],
  [0x0041c33a, "ff5030", "table DestroyPlayer(socket,false)"],
  [0x0041c347, "c780d401000004000000", "odd pool4 AFTER table removal; no195"],
  [0x0041c36c, "8a8641030000", "full-room capacity BYTE+833"],
  [0x0041c372, "2a8640030000", "full-room CURRENT count BYTE+832"],
  [0x0041c3b5, "6a00", "can-start WARNING reason0"],
  [0x0041c405, "766e", "normal warning expiry unsigned STRICT greater than"],
  [0x0041c415, "6a02", "can-start EJECTION reason2"],
  [0x0041c446, "ff5044", "normal chief-only121 BEFORE removal"],
  [0x0041c459, "ff5030", "normal table destruction"],
  [0x0041c462, "c780d401000004000000", "normal pool4 after removal"],
  [0x0041c470, "e8464cfeff", "normal final SetCanStart(false) AFTER removal"],
  [0x0041c81e, "8b839c040000", "CanStartGame reads PLAYING map+1180"],
  [0x0041c866, "6a19", "participant exclusion query25, same zero stub"],
  [0x0041c97a, "6a17", "map bypass query23, same zero stub"],
  [
    0x0041dc5c,
    "ff90e0000000",
    "ordinary nonplaying Update invokes DeferBanChief",
  ],
] as const;
for (const [VA, Bytes] of anchors)
  if (game.read(VA, Bytes.length / 2).toString("hex") !== Bytes)
    throw new Error(`Unexpected chief PE anchor @${VA.toString(16)}`);
mkdirSync(".analysis/reference", { recursive: true });
const exe = resolve(".analysis/reference/waiting-chief"),
  build = Bun.spawnSync([
    "g++",
    "-std=c++17",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "tests/reference/waiting-chief.cpp",
    "-o",
    exe,
  ]);
if (build.exitCode) throw new Error(build.stderr.toString());
const run = Bun.spawnSync([exe]);
if (run.exitCode) throw new Error(run.stderr.toString());
const data: Record<string, unknown> = JSON.parse(run.stdout.toString());
writeFileSync(
  "tests/fixtures/waiting-chief-vectors.json",
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
  `Generated ${anchors.length} fixed anchors /${data.CaseCount} waiting-chief cases; NOT original execution, SQL, permission, full removal or client proof.`,
);
