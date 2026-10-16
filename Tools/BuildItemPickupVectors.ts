import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";
import { CPeImage, OFFICIAL_SERVICES } from "./OfficialSource.ts";

// Read-only native instructions; compile/run ONLY OUR manual C++ translation.
// No production packet/session/user/resource/arithmetic implementation imports.
const image = new CPeImage(OFFICIAL_SERVICES.FXGS);
const anchors = [
  [0x00409109, "01088b087905", "signed32 wallet ADD, then branch on sign"],
  [0x00409114, "ba40420f003bca7e028910", "positive result capped at1,000,000"],
  [
    0x00409123,
    "c787b807000001000000",
    "even saturated/zero changes dirty dynamic info",
  ],
  [0x0041eb05, "3dfa000000", "pickup box index must be below250"],
  [
    0x0041eb1e,
    "3b7a04",
    "item bound is actual CItemAttr count, not shop definitions",
  ],
  [0x0041eb2d, "8d8481d80b0000", "box claim array at context+3032"],
  [
    0x0041eb34,
    "8338000f8555010000",
    "any nonzero claim flag suppresses pickup",
  ],
  [0x0041eb40, "689c000000", "pickup response156"],
  [
    0x0041eb47,
    "c70001000000",
    "successful native pickup changes claim flag to1",
  ],
  [0x0041eb7d, "83bf8c00000063", "164-byte resource row+140 Type99 is money"],
  [
    0x0041eb9a,
    "80b8d407000001",
    "bonus uses authencode BYTE+2004 exactly equal1",
  ],
  [0x0041eba8, "6a029959f7f942", "rand()%2+1; no RNG in nonbonus branch"],
  [0x0041ebbc, "8bbf900000000faf7d0c", "signed32 multiplier times row+144"],
  [
    0x0041ebc6,
    "81ff102700007e0d",
    "amount>10000 diagnoses only; does not reject/cap",
  ],
  [0x0041ebe3, "e804a5feff", "money branch invokes CUser::IncDecMoney"],
  [0x0041ecd6, "83e00f", "obstacle column is the low nibble"],
  [0x0041ecdd, "c1ee04", "obstacle row is the upper nibble"],
  [
    0x0041ed0b,
    "ff90c0000000",
    "pickup ownership uses virtual+192 (IsSlotInThisSocket)",
  ],
  [0x0041ed47, "6bf60f037508", "flat index is row*15+column; col15 can alias"],
  [0x0041ed4f, "81fec30000007d49", "only flat index>=195 is rejected"],
  [0x0041ed5d, "8d84b0c00f0000", "obstacle claim array at context+4032"],
  [
    0x0041ed70,
    "689d000000",
    "obstacle response157 echoes original packed byte",
  ],
  [0x0041ed77, "c70001000000", "obstacle claim flag becomes1"],
  [
    0x0041f2be,
    "e89c79feff3bd80f8df5000000",
    "local self bound before reading label",
  ],
  [0x0041f329, "6810f04800", "StrFormat template points to0048F010"],
  [
    0x0048f010,
    "2573b4d4b2b2bcad20c0ccbaa5c6ae20bec6c0ccc5dbc0bb20c8b9b5e6c7cfbcccbdc0b4cfb4d92120c3e0c7cfc7d5b4cfb4d9210ac0dabcbcc7d120b3bbbfebc0ba20c8a8c6e4c0ccc1f6b8a620c2fcb0edc7cfbcbcbfe47e0a00",
    "FULL C string: percent-s +88 raw CP949 announcement bytes, then NUL",
  ],
  [0x0041f337, "6a1e", "event notification uses general-server response30"],
  [
    0x0041e908,
    "83e00f",
    "throw actor is LOW nibble; upper nibble remains opaque",
  ],
  [0x0041e955, "ff90bc000000", "throw ownership uses virtual+188 (IsMySocket)"],
  [0x0041e9e6, "83a498d80b000000", "throw clears only selected box claim flag"],
  [0x0041e9f1, "68ac000000", "UNROUTED throw kernel emits172 with six BYTEs"],
  [0x00421691, "121314151617", "native ordinary144..149 dispatcher selectors"],
  [0x0042169a, "26", "native ordinary request153 selects default index38"],
  [
    0x0042165d,
    "b4154200",
    "jump table entry38 points to default004215B4, NOT throw",
  ],
] as const;
for (const [va, bytes] of anchors)
  if (image.read(va, bytes.length / 2).toString("hex") !== bytes)
    throw new Error(`Unexpected pickup instruction at ${va.toString(16)}`);
mkdirSync(".analysis/reference", { recursive: true });
const executable = resolve(".analysis/reference/item-pickup");
const build = Bun.spawnSync([
  "g++",
  "-std=c++17",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-O2",
  "tests/reference/item-pickup.cpp",
  "-o",
  executable,
]);
if (build.exitCode) throw new Error(build.stderr.toString());
const run = Bun.spawnSync([executable]);
if (run.exitCode) throw new Error(run.stderr.toString());
const data: Record<string, unknown> = JSON.parse(run.stdout.toString());
writeFileSync(
  "tests/fixtures/item-pickup-vectors.json",
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
  "Generated independent manual C++ pickup/obstacle/event/unrouted-throw/money vectors; NOT original execution/client/security proof.",
);
