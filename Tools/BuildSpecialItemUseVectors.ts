import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { format } from "prettier";
import { CPeImage, OFFICIAL_SERVICES } from "./OfficialSource.ts";

// Read-only native identity/anchors. Execute ONLY OUR standalone manual C++
// parser/model; it independently reads the archive, without production imports.
const image = new CPeImage(OFFICIAL_SERVICES.FXGS);
const anchors = [
  [
    0x0041ee15,
    "83bf5403000000",
    "native tests Playing, not modern native-launch authorization",
  ],
  [0x0041ee45, "689f000000", "case0 relays159"],
  [
    0x0041ee9a,
    "ff90bc000000",
    "actor must belong to sender socket (virtual188)",
  ],
  [0x0041eebe, "e8fdbc0100", "first extraBYTE opaque"],
  [0x0041eecc, "e8efbc0100", "second extraBYTE resource index"],
  [0x0041eeda, "e8e1bc0100", "third extraBYTE quantity"],
  [0x0041eee7, "7e75", "zero quantity skips inventory and BOTH flags"],
  [
    0x0041eeee,
    "8078086c",
    "positive quantity channel108 returns before SN decoding",
  ],
  [0x0041ef15, "89849f842d0000", "session+11652 ShopItemAttempted=1"],
  [
    0x0041ef1c,
    "89849f502f0000",
    "session+12112 is calculator+428 Nice[slot]=1",
  ],
  [0x0041ef23, "e838bd0100", "positive quantity decodes DWORD inventory SN"],
  [0x0041ef2d, "e85c7bffff", "native first resident SN lookup"],
  [
    0x0041ef39,
    "294828",
    "subtract quantity from inventory+40 Amount BEFORE resource validation",
  ],
  [0x0041ef3c, "c7405001000000", "inventory+80 dirty1"],
  [
    0x0041ef43,
    "7919",
    "JNS uses wrapped subtraction sign bit; not checked signed overflow",
  ],
  [0x0041ef45, "83602800", "native negative amount clamps0 then disconnects"],
  [0x0041ef6e, "3b4804", "resource index bounded by actual CItemAttr count"],
  [0x0041ef77, "69c9a4000000", "resource object has164-byte rows"],
  [
    0x0041ef7d,
    "8b840194000000",
    "Type at object+148 = native row+140 after8-byte object prefix",
  ],
  [0x0041ef84, "83f816", "Type22 special branch"],
  [0x0041ef8b, "83f80b7c0a83f80d7e7883f815", "lower predicate11..13 or21"],
  [0x0041efcf, "80bc3b542d000003", "Type22 only refreshes timer in state3"],
  [
    0x0041efe8,
    "e879c8ffff",
    "one ElapsedTime sample, NOT state/position/rebirth mutation",
  ],
  [0x0041eff0, "898499d4120000", "store context+4820+4slot state time"],
  [
    0x0041eff9,
    "83f8177c9c83f81c7e0a83f81e7e9283f820",
    "upper predicate23..28 or31..32;29/30 rejected",
  ],
  [0x0041f00d, "ff75e8", "append opaque BYTE"],
  [0x0041f017, "ff75f0", "append resource index BYTE"],
  [0x0041f021, "ff75ec", "append quantity BYTE, NOT inventory SN"],
  [0x0041f203, "e8bca9ffff", "SendPacketExclude excludes WHOLE sender socket"],
  [0x00416a9c, "8b103b542404", "inventory getter compares ONLY first DWORD SN"],
  [0x00416aa4, "83c054", "getter advances84-byte resident rows"],
  [0x004169df, "837e5000", "deferred flush checks native dirty+80"],
  [
    0x004169f0,
    "7f0a",
    "positive amounts update; zero/nonpositive amounts delete SQL but not vector",
  ],
  [
    0x00416c33,
    "6a54",
    "201 count is resident vector length divided84, including exhausted rows",
  ],
  [
    0x00416c4c,
    "ff36",
    "201 first DWORD is resident UserInventory+0 SN (native ItemSn), not StockSn+4",
  ],
  [0x00416c59, "8a4e24", "201 BYTE Slot at row+36"],
  [0x00416c62, "ff7628", "201 DWORD AMOUNT at row+40, NOT ItemID"],
  [0x00416c6e, "8d4e2c", "201 description at row+44 precedes date"],
  [0x00416c77, "8d4e38", "201 CTime at row+56"],
  [0x00416c7f, "dd5df4", "narrow x87 returned date to64-bit double"],
  [0x00416c84, "6a08", "append EIGHT raw bytes without scalar obfuscation"],
  [
    0x0043385b,
    "ff1534b24800",
    "native VariantTime converts DB SYSTEMTIME, not the modern Unix/zero bridge",
  ],
  [
    0x00432478,
    "3569a500008821884101",
    "WORD XOR A569 then AH BEFORE AL (big-endian)",
  ],
  [0x00432498, "359553ca96", "DWORD scalar XOR96CA5395"],
] as const;
for (const [va, bytes] of anchors)
  if (image.read(va, bytes.length / 2).toString("hex") !== bytes)
    throw new Error(`Unexpected special-item instruction at${va.toString(16)}`);
mkdirSync(".analysis/reference", { recursive: true });
const executable = resolve(".analysis/reference/special-item-use"),
  build = Bun.spawnSync([
    "g++",
    "-std=c++17",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "tests/reference/special-item-use.cpp",
    "-o",
    executable,
  ]);
if (build.exitCode) throw new Error(build.stderr.toString());
const run = Bun.spawnSync([executable, "FXGS/FxServer"]);
if (run.exitCode) throw new Error(run.stderr.toString());
const data: Record<string, unknown> = JSON.parse(run.stdout.toString());
writeFileSync(
  "tests/fixtures/special-item-use-vectors.json",
  await format(
    JSON.stringify({
      ...data,
      OfficialPE: { Service: "FXGS", SHA256: image.sha256 },
      ArchiveIdentity: ["FXGS/FxServer.idx", "FXGS/FxServer.idd"].map(
        (Path) => ({
          Path,
          SHA256: createHash("sha256").update(readFileSync(Path)).digest("hex"),
        }),
      ),
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
  `Generated independent manual C++ special-item/201 vectors with${anchors.length} read-only PE anchors; NOT native execution/shop/client proof.`,
);
