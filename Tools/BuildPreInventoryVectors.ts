import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";
import { CPeImage, OFFICIAL_SERVICES } from "./OfficialSource.ts";

// ONLY our independent C++ model runs. Supplied PE / SQL / Windows APIs do not.
const image = new CPeImage(OFFICIAL_SERVICES.FXGS),
  login = new CPeImage(OFFICIAL_SERVICES.LS);
const anchors = [
  [0x0040adaf, "6868c54800", "native ten-column pre-inventory select"],
  [0x0040ae2e, "837dec1e", "30 successful loads, not fetched rows"],
  [0x0040ae38, "ff7598", "lookup ItemSn not pre SN/StockSn/Type"],
  [0x0040ae55, "80780409", "definition Category9 premium"],
  [0x0040ae61, "e8c6f1ffff", "SetPremiumTicket BEFORE LoadOn"],
  [0x0040ae6a, "80bed407000001", "FXGS auth exact BYTE1"],
  [
    0x0040ae84,
    "e8bd63ffff",
    "SendAuthenCode request, no local auth assignment",
  ],
  [0x0040ae8e, "897d08", "premium truncate1 even on premium failure"],
  [0x0040ae99, "80780465", "definition Category101 experience"],
  [0x0040aea4, "e874bb0000", "IncDecExp prefix"],
  [0x0040aeab, "e8c4b90000", "explicit SetLevel before procedure UserLevel"],
  [0x0040aeb6, "80780464", "definition Category100 money"],
  [0x0040aec1, "e826e2ffff", "plain IncDecMoney, no pickup RNG multiplier"],
  [0x0040aeda, "e824c70000", "forced flush BEFORE LoadOn result"],
  [0x0040aedf, "8bbec0070000", "cached level AFTER possible XP prefix"],
  [0x0040aef4, "03f9", "signed32 ADD ValidityLevel, not short"],
  [0x0040af0e, "e8f2efffff", "LoadOn after ALL prefix effects"],
  [0x0040af15, "7423", "failed LoadOn skips append/count, not prefix rollback"],
  [0x0040af21, "6bc938", "56-byte PreInventory stride"],
  [0x0040af37, "ff45ec", "success count increment only after append"],
  [0x0040af40, "e82b620300", "extra GetNextRow BEFORE count guard"],
  [0x00409fff, "3bc3", "ExecStoredProc signed nonnegative required"],
  [0x0040a008, "0f9dc0", "procedure return signed nonnegative also required"],
  [0x0041210b, "8d4648", "CRS field0 LONG pre SN -> +0"],
  [0x00412116, "8d464c", "CRS field1 BYTE Type -> +4"],
  [0x00412123, "8d4650", "CRS field2 LONG ItemSn -> +8"],
  [0x00412130, "8d4654", "CRS field3 LONG StockSn -> +12"],
  [0x0041213d, "8d4658", "CRS field4 BYTE Slot -> +16"],
  [0x0041214a, "8d465c", "CRS field5 LONG Amount -> +20"],
  [0x00412157, "8d4660", "CRS field6 Description -> +24"],
  [0x00412164, "8d466c", "CRS field7 LONG ValidityPeriod -> +36"],
  [0x00412171, "8d4670", "CRS field8 LONG ValidityLevel -> +40"],
  [0x0041217e, "8d4674", "CRS field9 strAttr -> +44"],
  [0x00417642, "89bed0070000", "forced flush resets game counter"],
  [0x00417669, "832700", "flush clears dynamic dirty BEFORE writer"],
  [0x00417677, "832600", "flush clears simple dirty BEFORE writer"],
  [0x00417692, "e83b19ffff", "WriteUserDynInfo call, not durable ACK"],
  [0x00416ccc, "8a8b80070000", "207 count original total BYTE"],
  [0x00416cd5, "ff5014", "207 count Encode1"],
  [
    0x00416d01,
    "746e",
    "native missing definition skips body without count repair",
  ],
  [0x00416d07, "8a4ffc", "207 Type BYTE NOT definition Category"],
  [0x00416d10, "ff37", "207 ItemSn DWORD NOT pre SN or StockSn"],
  [0x00416d1d, "668b4f0c", "207 Amount low WORD"],
  [0x00416d2a, "80780465", "207 level only for Category101"],
  [0x00416d34, "668b8bc0070000", "207 current cached level low WORD"],
  [0x00416d45, "8b471c", "207 ValidityPeriod, NOT ValidityLevel"],
  [0x00416d4a, "3da0860100", "207 period cutoff100000"],
  [0x00416d4f, "7d02", "207 signed comparison, negative periods keep low WORD"],
  [0x00416d5d, "8d4f24", "207 strAttr before Description"],
  [0x00416d68, "8d4f10", "207 Description second, NOT catalog strName"],
  [0x004089a0, "83ba8007000000", "native handoff tests ANY local pre count"],
  [0x004089bc, "68cf000000", "server response207 (not client207 delete)"],
  [0x004089e3, "e8c1e20000", "207 builder for ALL locals including empty body"],
  [0x00408a06, "68c9000000", "207 publication also triggers later201"],
] as const;
for (const [VA, Bytes] of anchors)
  if (image.read(VA, Bytes.length / 2).toString("hex") !== Bytes)
    throw new Error(`Unexpected pre-inventory PE bytes @${VA.toString(16)}`);
const select =
  "SN, Type, ItemSn, StockSn, Slot, Amount, Description, ValidityPeriod, ValidityLevel, strAttr";
if (
  !image.read(0x0048c568, select.length + 1).equals(Buffer.from(select + "\0"))
)
  throw new Error("Pre-inventory select evidence mismatch");
const size = image.read(image.symbolVA("kLevelTableSize"), 4).readUInt32LE(),
  bytes = image.read(image.symbolVA("g_nLevel2ExpTable"), 4 * size);
if (
  size !== login.read(login.symbolVA("kLevelTableSize"), 4).readUInt32LE() ||
  !bytes.equals(login.read(login.symbolVA("g_nLevel2ExpTable"), 4 * size))
)
  throw new Error(
    "Cannot generate pre-inventory XP vectors for different LS/GS level tables",
  );
const levels = Array.from({ length: size }, (_, i) => bytes.readInt32LE(i * 4));
mkdirSync(".analysis/reference", { recursive: true });
writeFileSync(
  ".analysis/reference/pre-inventory-levels.h",
  `// Read-only FXGS ${image.sha256} / LS ${login.sha256}\nstatic constexpr std::array<std::int32_t, ${size}> levels{{${levels.join(",")}}};\n`,
);
const exe = resolve(".analysis/reference/pre-inventory"),
  build = Bun.spawnSync([
    "g++",
    "-std=c++17",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "-fno-fast-math",
    "-ffp-contract=off",
    "-I.analysis/reference",
    "tests/reference/pre-inventory.cpp",
    "-o",
    exe,
  ]);
if (build.exitCode) throw new Error(build.stderr.toString());
const run = Bun.spawnSync([exe]);
if (run.exitCode) throw new Error(run.stderr.toString());
const data: Record<string, unknown> = JSON.parse(run.stdout.toString());
writeFileSync(
  "tests/fixtures/pre-inventory-vectors.json",
  await format(
    JSON.stringify({
      ...data,
      OfficialPE: { Service: "FXGS", SHA256: image.sha256 },
      LevelInput: {
        LoginSHA256: login.sha256,
        GameSHA256: image.sha256,
        Entries: size,
      },
      SelectEvidence: { VA: 0x0048c568, Text: select },
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
  `Generated ${anchors.length} fixed PE anchors / independent manual C++ pre-inventory trace and207; NOT native execution, financial authority or SQL/client proof.`,
);
