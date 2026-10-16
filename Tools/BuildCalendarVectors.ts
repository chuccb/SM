import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";
import { CPeImage, OFFICIAL_SERVICES } from "./OfficialSource.ts";

// Read PE only. Compile/run OUR independent strict-profile model, never original
// EXE, Windows APIs, DAT/SQL. No Wine code is copied or executed.
const images = {
  FXGS: new CPeImage(OFFICIAL_SERVICES.FXGS),
  LS: new CPeImage(OFFICIAL_SERVICES.LS),
};
const anchors = [
  ["FXGS", 0x004337cd, "ff15b4b04800", "CTime ctor GetLocalTime"],
  [
    "FXGS",
    0x00433820,
    "83c10451ff15b4b04800",
    "SetCurrentTime resamples LOCAL civil fields",
  ],
  [
    "FXGS",
    0x00433830,
    "8b4424048b1083c1048911",
    "SetTime starts full SYSTEMTIME copy",
  ],
  [
    "FXGS",
    0x00433850,
    "83ec088d04245083c10451ff1534b24800dd042483c408c3",
    "SystemTimeToVariantTime BOOL IGNORED before unconditional f64 load",
  ],
  [
    "FXGS",
    0x00433870,
    "8b44240483c1048b118910",
    "GetAsSystemTime copies, not resamples",
  ],
  ["FXGS", 0x004338a0, "668b4108c3", "GetDayOfWeek is stored WORD"],
  ["FXGS", 0x004404e0, "66895002", "DB conversion month WORD"],
  ["FXGS", 0x004404eb, "668908", "DB conversion signed year bits ->WORD"],
  ["FXGS", 0x004404f3, "66895008", "DB conversion hour at SYSTEMTIME+8"],
  [
    "FXGS",
    0x004404fb,
    "66894806",
    "DB conversion day at+6, skipping weekday+4",
  ],
  ["FXGS", 0x00440507, "6689480a6689500c", "DB conversion minute/second WORDs"],
  [
    "FXGS",
    0x0044050f,
    "66c7400e0000",
    "DB conversion explicitly zeros ms, NOT fraction/1e6",
  ],
  ["FXGS", 0x00440556, "c7400c00000000", "reverse conversion fraction ALWAYS0"],
  [
    "FXGS",
    0x00440f0a,
    "6bc034",
    "rowset binding stride, not a SQL date string",
  ],
  ["FXGS", 0x00440f26, "6689442414", "Get_FieldDate year bits"],
  [
    "FXGS",
    0x00440f32,
    "66894c241a",
    "Get_FieldDate day, leaves weekday UNWRITTEN",
  ],
  ["FXGS", 0x00440f3a, "6689442416", "Get_FieldDate month"],
  ["FXGS", 0x00440f43, "668954241e", "Get_FieldDate minute"],
  ["FXGS", 0x00440f4c, "66894c241c", "Get_FieldDate hour"],
  [
    "FXGS",
    0x00440f5d,
    "6689542424",
    "Get_FieldDate second; ms stays UNWRITTEN",
  ],
  [
    "FXGS",
    0x00440f62,
    "e8c928ffff",
    "Get_FieldDate copies full16 including unobserved words",
  ],
  [
    "FXGS",
    0x00408d31,
    "ff15a4b04800",
    "SyncLocalTimeFromDB SetLocalTime: NEVER executed",
  ],
  ["FXGS", 0x0040b0f9, "e852870200", "inventory current CTime -> DATE"],
  ["FXGS", 0x0040b104, "e847870200", "inventory stored CTime -> DATE"],
  ["FXGS", 0x00416c77, "8d4e38", "201 stored calendar at resident+56"],
  ["FXGS", 0x00416c7f, "dd5df4", "201 DATE narrowed to raw f64"],
  ["FXGS", 0x00416c84, "6a08", "201 eight RAW little-endian bytes"],
  [
    "LS",
    0x00424b10,
    "83ec088d04245083c10451ff1528924700dd042483c408c3",
    "LS same unchecked variant API result",
  ],
  ["LS", 0x00431d0f, "66c7400e0000", "LS DB conversion ms zero"],
  [
    "LS",
    0x0042c566,
    "6689442414",
    "LS same rowset uninitialized-word boundary",
  ],
] as const;
for (const [Service, VA, Bytes] of anchors)
  if (images[Service].read(VA, Bytes.length / 2).toString("hex") !== Bytes)
    throw new Error(
      `Unexpected ${Service} calendar anchor @${VA.toString(16)}`,
    );
const shared = [
  [
    0x004404d0,
    0x00431cd0,
    72,
    "ConvertDBTimeToSystemTime full routine, no weekday write",
  ],
  [
    0x00440520,
    0x00431d20,
    64,
    "ConvertSystemTimeToDBTime full routine, fraction0",
  ],
  [
    0x00440f00,
    0x0042c540,
    98,
    "Get_FieldDate through LAST WORD store, before relocated SetTime call",
  ],
] as const;
for (const [FXGS, LS, Size] of shared)
  if (!images.FXGS.read(FXGS, Size).equals(images.LS.read(LS, Size)))
    throw new Error("LS/GS native calendar field-copy routines differ");
mkdirSync(".analysis/reference", { recursive: true });
const exe = resolve(".analysis/reference/calendar"),
  build = Bun.spawnSync([
    "g++",
    "-std=c++17",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "-fno-fast-math",
    "-ffp-contract=off",
    "tests/reference/calendar.cpp",
    "-o",
    exe,
  ]);
if (build.exitCode) throw new Error(build.stderr.toString());
const run = Bun.spawnSync([exe]);
if (run.exitCode) throw new Error(run.stderr.toString());
const data: Record<string, unknown> = JSON.parse(run.stdout.toString());
writeFileSync(
  "tests/fixtures/calendar-vectors.json",
  await format(
    JSON.stringify({
      ...data,
      OfficialPE: { FXGS: images.FXGS.sha256, LS: images.LS.sha256 },
      InstructionAnchors: anchors.map(([Service, VA, Bytes, Meaning]) => ({
        Service,
        VA,
        Bytes,
        Meaning,
      })),
      SharedRoutines: shared.map(([FXGS, LS, Size, Meaning]) => ({
        FXGS,
        LS,
        Size,
        Meaning,
      })),
      Profile:
        "STRICT Gregorian100..9999 / valid days only / seconds included / ms ignored / negative DATE fraction / no timezone or Windows version claim",
      Research: {
        MicrosoftSDKCommit: "cdefd0ed0fa0834394799655b080b019374e95cb",
        URL: "https://github.com/MicrosoftDocs/sdk-api/blob/cdefd0ed0fa0834394799655b080b019374e95cb/sdk-api-src/content/oleauto/nf-oleauto-systemtimetovarianttime.md",
        Meaning:
          "API BOOL, second precision, ms ignored, invalid-day rolling documented; portable profile deliberately REJECTS rolling/00..99",
      },
    }),
    { parser: "json" },
  ),
);
console.log(
  `Generated ${anchors.length} PE anchors /3 identical LS-GS copy routines /${(data.Cases as unknown[]).length} independent STRICT calendar cases. NOT original DLL/clock/SQL/client proof.`,
);
