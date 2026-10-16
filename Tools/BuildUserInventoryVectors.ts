import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";
import { CPeImage, OFFICIAL_SERVICES } from "./OfficialSource.ts";

// Build/run ONLY OUR manual C++ model. PE/backup data remain read-only.
const image = new CPeImage(OFFICIAL_SERVICES.FXGS);
const anchors = [
  [
    0x0040af6d,
    "e882fdffff",
    "InitPreInventory must succeed BEFORE native inventory read-side",
  ],
  [
    0x0040b01e,
    "6804c64800",
    "native select ItemSn/Slot/Amount/DateCreated/LevelCreated/StockSn/Verbose",
  ],
  [0x0040b09d, "817d0890010000", "400 counted rows, NOT an SQL LIMIT"],
  [0x0040b0ba, "e82c400000", "definition lookup uses ItemSn"],
  [0x0040b0d5, "0fbf4dbc", "MOVSX signed16 LevelCreated"],
  [0x0040b0df, "3bc1", "signed cached level compare"],
  [
    0x0040b0ef,
    "e82c870200",
    "current local CTime sample even after level invalidation",
  ],
  [0x0040b0f9, "e852870200", "current CTime to raw DATE"],
  [0x0040b104, "e847870200", "stored CTime to raw DATE"],
  [0x0040b116, "ded9", "x87 raw DATE compare"],
  [0x0040b11a, "f6c441", "strict greater-than status test, equality kept"],
  [0x0040b123, "8a4604", "Category copied from definition+4"],
  [0x0040b12c, "8d4608", "strAttr copied from definition+8"],
  [0x0040b13b, "8b4614", "nAttr1 copied from definition+20"],
  [0x0040b141, "8b4618", "nAttr2 copied from definition+24"],
  [0x0040b147, "8b461c", "nAttr3 copied from definition+28"],
  [0x0040b15a, "e81cca0000", "append resident UserInventory copy"],
  [0x0040b15f, "807e0405", "Category5 level-icon hook"],
  [0x0040b165, "807d94ff", "Slot255 skips icon"],
  [0x0040b16d, "c787c807000001000000", "icon enable1"],
  [0x0040b177, "8987cc070000", "icon stores definition SN"],
  [0x0040b17d, "807e0406", "Category6 fake-level hook"],
  [0x0040b183, "807d94ff", "Slot255 skips fake-level"],
  [0x0040b189, "8b7614", "fake-level reads nAttr1, not price or StockSn"],
  [0x0040b18c, "89b7c4070000", "write CUser fake-level"],
  [0x0040b192, "ff4508", "counted increment only missing/accepted paths"],
  [0x0040b19b, "e8d05f0300", "GetNextRow BEFORE counted<400 check"],
  [0x0040b1b2, "ff36", "DeleteInventory keys definition SN, NOT StockSn"],
  [0x0040b1bc, "ebd7", "deleted row loops without incrementing400 counter"],
  [0x00416a9e, "3b542404", "GetUserInventory compares first ItemSn DWORD"],
  [0x00416abc, "8b460c", "GetUserInventoryFromAll compares strAttr at+12"],
  [0x00416ac4, "e8da8a0500", "byte/codepage mbscmp, not case folding"],
  [0x00416af1, "807e0802", "HasFunctionalItem additionally requires Category2"],
  [
    0x00416b33,
    "3b542404",
    "GetInventoryLoaded compares int category without BYTE wrapping",
  ],
  [
    0x00416b39,
    "807824ff",
    "GetInventoryLoaded excludes Slot255, no Amount/date condition",
  ],
  [0x00416b7b, "ff5018", "category inventory count Encode2"],
  [0x00416b9a, "ff5018", "category inventory ID Encode2"],
  [0x00416bbc, "8078080a", "slot decoration Category10"],
  [0x00416bc5, "3b542404", "slot decoration position compare"],
  [0x00416bcb, "807824ff", "slot decoration excludes Slot255"],
  [0x00416beb, "8078080c", "character decoration Category12"],
  [0x00416bf4, "3b542404", "character decoration position compare"],
  [0x004195c6, "83fe09", "slot decoration domain0..8"],
  [0x0041960f, "ff5018", "slot decoration nAttr1 low WORD"],
  [0x0041962b, "83ff05", "character decoration domain0..4"],
  [0x00419657, "ff7718", "character decoration nAttr1"],
  [0x00419661, "ff771c", "character decoration nAttr2"],
  [0x0041966b, "ff7720", "character decoration nAttr3"],
  [0x0041967e, "6a0e", "accessory tail Category14"],
  [0x0041968b, "ff7020", "tail emits nAttr3 DWORD"],
  [0x00419ac8, "6a04", "105 self-only Category4 lookup"],
  [0x00419ad7, "0fb64018", "105 self byte is nAttr1 low BYTE"],
  [0x00419ae5, "68ff000000", "105 no equipped Category4 sentinel255"],
  [0x00416c33, "6a54", "201 count uses native84-byte resident-vector length"],
  [0x00416c4c, "ff36", "201 ItemSn DWORD, never StockSn"],
  [0x00416c59, "8a4e24", "201 Slot BYTE at resident+36"],
  [0x00416c62, "ff7628", "201 Amount DWORD at resident+40, not ItemID"],
  [0x00416c6e, "8d4e2c", "201 Verbose string BEFORE DATE"],
  [0x00416c77, "8d4e38", "201 CTime at resident+56"],
  [0x00416c7f, "dd5df4", "201 x87 return narrowed to raw64-bit DATE"],
  [0x00416c84, "6a08", "201 EIGHT raw DATE bytes, no scalar XOR"],
  [
    0x00408d31,
    "ff15a4b04800",
    "native SyncLocalTimeFromDB invokes SetLocalTime; intentionally NEVER executed",
  ],
  [0x00412002, "8d4648", "rowset ItemSn -> resident+0"],
  [0x0041200d, "8d466c", "rowset Slot -> resident+36"],
  [0x0041201a, "8d4670", "rowset Amount -> resident+40"],
  [0x00412027, "8d8680000000", "rowset CTime -> resident+56"],
  [
    0x00412037,
    "8d8694000000",
    "rowset signed SHORT LevelCreated -> resident+76",
  ],
  [0x00412047, "8d464c", "rowset StockSn -> resident+4, separate from ItemSn"],
  [0x00412054, "8d4674", "rowset Verbose -> resident+44, not strName"],
  [0x00416b94, "668b0f", "category list emits LOW WORD of ItemSn"],
  [0x00417b7f, "83605000", "AddInventory clears resident dirty+80"],
  [
    0x0043385b,
    "ff1534b24800",
    "CTime calls SystemTimeToVariantTime; API itself is NOT emulated",
  ],
] as const;
for (const [VA, Bytes] of anchors)
  if (image.read(VA, Bytes.length / 2).toString("hex") !== Bytes)
    throw new Error(
      `Unexpected native inventory instruction at${VA.toString(16)}`,
    );
const select = "ItemSn,Slot,Amount,DateCreated,LevelCreated,StockSn,Verbose";
if (
  !image.read(0x0048c604, select.length + 1).equals(Buffer.from(select + "\0"))
)
  throw new Error("Native inventory select evidence changed");
mkdirSync(".analysis/reference", { recursive: true });
const exe = resolve(".analysis/reference/user-inventory"),
  build = Bun.spawnSync([
    "g++",
    "-std=c++17",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "tests/reference/user-inventory.cpp",
    "-o",
    exe,
  ]);
if (build.exitCode) throw new Error(build.stderr.toString());
const run = Bun.spawnSync([exe]);
if (run.exitCode) throw new Error(run.stderr.toString());
const data: Record<string, unknown> = JSON.parse(run.stdout.toString());
writeFileSync(
  "tests/fixtures/user-inventory-vectors.json",
  await format(
    JSON.stringify({
      ...data,
      OfficialPE: { Service: "FXGS", SHA256: image.sha256 },
      SelectEvidence: { VA: 0x0048c604, Text: select },
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
  `Generated independent native READ-SIDE inventory model and${anchors.length} PE anchors; NOT native execution/SQL/CTime conversion/pre-inventory/paid persistence/client proof.`,
);
