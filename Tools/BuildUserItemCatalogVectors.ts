import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";
import { CPeImage, OFFICIAL_SERVICES } from "./OfficialSource.ts";

// Build ONLY OUR manual C++ model; supplied binaries/backup SQL never execute.
const image = new CPeImage(OFFICIAL_SERVICES.FXGS);
const anchors = [
  [0x0040fa13, "68f4c94800", "FxItem definition table, NOT ShopItem stock"],
  [
    0x0040fa35,
    "68b8c94800",
    "native select SN/Category/strAttr/nAttr1/nAttr2/nAttr3/strName",
  ],
  [
    0x0040fa62,
    "0f8489000000",
    "native SQL open failure returns without clearing map",
  ],
  [0x0040fa78, "e829faffff", "native clears map after reader opens"],
  [
    0x0040fab5,
    "e80cfeffff",
    "unsigned RB-tree insert_unique: first duplicate wins",
  ],
  [0x0040f0ff, "8b4508", "GetUserItem int bit pattern from caller"],
  [
    0x0040f10e,
    "e8d9fdffff",
    "unsigned RB-tree find, NOT rowid/name/StockSn fallback",
  ],
  [0x0040f117, "8d5814", "UserItem starts20 bytes into RB node"],
  [0x0040f006, "668b4b68", "202 count read as WORD"],
  [0x0040f00d, "ff5018", "202 Encode2 count"],
  [0x0040f01a, "ff7714", "202 SN DWORD"],
  [0x0040f028, "8a4f18", "202 Category BYTE"],
  [0x0040f033, "8d4f1c", "202 strAttr string"],
  [0x0040f03c, "ff7728", "202 nAttr1 DWORD"],
  [0x0040f046, "ff772c", "202 nAttr2 DWORD"],
  [0x0040f050, "ff7730", "202 nAttr3 DWORD"],
  [0x0040f05c, "8d4f34", "202 strName string, NOT inventory Verbose"],
  [0x0040f065, "57", "unsigned ordered RB traversal"],
  [0x00411ee4, "8d4648", "rowset column0 SN offset0"],
  [0x00411eef, "8d464c", "rowset column1 Category offset4"],
  [0x00411efc, "8d4650", "rowset column2 strAttr offset8"],
  [0x00411f09, "8d465c", "rowset column3 nAttr1 offset20"],
  [0x00411f16, "8d4660", "rowset column4 nAttr2 offset24"],
  [0x00411f23, "8d4664", "rowset column5 nAttr3 offset28"],
  [0x00411f30, "8d4668", "rowset column6 strName offset32"],
] as const;
for (const [va, bytes] of anchors)
  if (image.read(va, bytes.length / 2).toString("hex") !== bytes)
    throw new Error(`Unexpected UserItem instruction at${va.toString(16)}`);
const select = "SN , Category , strAttr , nAttr1, nAttr2 , nAttr3, strName";
if (
  !image.read(0x0048c9b8, select.length + 1).equals(Buffer.from(select + "\0"))
)
  throw new Error("UserItem select-column evidence changed");
mkdirSync(".analysis/reference", { recursive: true });
const exe = resolve(".analysis/reference/user-item-catalog"),
  build = Bun.spawnSync([
    "g++",
    "-std=c++17",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "tests/reference/user-item-catalog.cpp",
    "-o",
    exe,
  ]);
if (build.exitCode) throw new Error(build.stderr.toString());
const run = Bun.spawnSync([exe]);
if (run.exitCode) throw new Error(run.stderr.toString());
const data: Record<string, unknown> = JSON.parse(run.stdout.toString());
writeFileSync(
  "tests/fixtures/user-item-catalog-vectors.json",
  await format(
    JSON.stringify({
      ...data,
      OfficialPE: { Service: "FXGS", SHA256: image.sha256 },
      SelectEvidence: { VA: 0x0048c9b8, Text: select },
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
  `Generated independent manual C++ UserItem/202 vectors and${anchors.length} read-only PE anchors; NOT native execution/SQL restore/inventory mapping/shop proof.`,
);
