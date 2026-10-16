import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";
import { CPeImage, OFFICIAL_SERVICES } from "./OfficialSource.ts";

// Read-only native instructions; compile/run ONLY OUR manual C++ translation.
// No production packet/session/user/resource/arithmetic implementation imports.
const image = new CPeImage(OFFICIAL_SERVICES.FXGS);
const anchors = [
  [
    0x00432478,
    "3569a50000",
    "packet WORD XOR A569; wire endian is NOT the little-endian x86 object layout",
  ],
  [
    0x0043247d,
    "8821884101",
    "Encrypt2 writes AH first, AL second: BIG-endian scalar-coded WORD",
  ],
  [
    0x0041b5c8,
    "c3",
    "DeferResurrection is an actual C3/ret, not an omitted implementation",
  ],
  [0x0041be9f, "8986b8310000", "native start WRITES the RebirthMap flag"],
  [
    0x004259c5,
    "83a6b831000000",
    "practice start WRITES zero to the RebirthMap flag",
  ],
  [
    0x0041b60d,
    "83ff08",
    "lap request slot is below8; handler has NO ownership check",
  ],
  [0x0041b625, "beff000000", "first progress BYTE inverted against255"],
  [
    0x0041b63e,
    "c1e608",
    "inverted first progress becomes bits8..15 of HIGH sort DWORD",
  ],
  [
    0x0041b643,
    "ff159cb24800",
    "lap low sort DWORD is absolute timeGetTime, not elapsed clock",
  ],
  [
    0x0041b665,
    "8984bb98310000",
    "only first progress BYTE is stored in the per-slot prefix DWORD",
  ],
  [0x0041b66e, "898cfb58310000", "absolute tick stored in LOW sort DWORD"],
  [
    0x0041b69d,
    "237904",
    "reported count uses AND of the two DWORDs before sentinel test",
  ],
  [0x0041b6e5, "3b7804", "rank compares unsigned HIGH DWORD first"],
  [
    0x0041b6ee,
    "3b38",
    "equal HIGH compares unsigned LOW; exact ties prefer lower slot",
  ],
  [0x0041b721, "68aa000000", "lap response170"],
  [0x0041b763, "68ff000000", "vacant slot emits FF twice"],
  [0x0041cbd8, "68b1000000", "Bula response177"],
  [
    0x0041cc31,
    "57",
    "Bula echoes the FIRST request BYTE as state for EVERY pair",
  ],
  [
    0x0041cc3a,
    "6bf62d",
    "Bula index stride is45, with no native per-axis bounds check",
  ],
  [
    0x0041cc69,
    "e80ccfffff",
    "Bula broadcasts including sender, also for count0",
  ],
  [0x0041f1de, "8845e8", "event8 preserves its first opaque BYTE"],
  [
    0x0041f1e9,
    "884508",
    "event8 preserves its second opaque BYTE; IDA omits the Encode1 argument",
  ],
  [
    0x0041f1f3,
    "ff7508",
    "event8 forwards the SECOND BYTE rather than discarding it",
  ],
  [0x0041f203, "e8bca9ffff", "event8 excludes the entire sending TCP socket"],
  [
    0x0042155a,
    "e88aa0ffff",
    "ordinary dispatcher request155 reaches OnLapInfo",
  ],
  [
    0x0041da2d,
    "6a05",
    "house response includes a literal5 section marker (NOT payment itself)",
  ],
  [0x0041daeb, "8d0480", "house award is5 times accepted NEW cells"],
  [
    0x0041daf1,
    "e8f6b5feff",
    "house award calls IncDecMoney: cannot be enabled as memory-only currency",
  ],
] as const;
for (const [va, bytes] of anchors)
  if (image.read(va, bytes.length / 2).toString("hex") !== bytes)
    throw new Error(
      `Unexpected claim/lap/resurrection instruction at ${va.toString(16)}`,
    );
mkdirSync(".analysis/reference", { recursive: true });
const executable = resolve(".analysis/reference/game-claims");
const build = Bun.spawnSync([
  "g++",
  "-std=c++17",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-O2",
  "tests/reference/game-claims.cpp",
  "-o",
  executable,
]);
if (build.exitCode) throw new Error(build.stderr.toString());
const run = Bun.spawnSync([executable]);
if (run.exitCode) throw new Error(run.stderr.toString());
const data: Record<string, unknown> = JSON.parse(run.stdout.toString());
writeFileSync(
  "tests/fixtures/game-claims-vectors.json",
  await format(
    JSON.stringify({
      ...data,
      OfficialPE: { Service: "FXGS", SHA256: image.sha256 },
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
  "Generated independent manual C++ Bula/lap/opaque8 vectors and native resurrection/house anchors; NOT original execution/client/security proof.",
);
