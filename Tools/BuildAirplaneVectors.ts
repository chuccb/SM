import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";
import { CPeImage, OFFICIAL_SERVICES } from "./OfficialSource.ts";

// Read-only PE identity; ONLY compile/run OUR independent manual C++ model.
// No production session/clock/packet/context/selection implementation imports.
const image = new CPeImage(OFFICIAL_SERVICES.FXGS);
const anchors = [
  [
    0x00432498,
    "359553ca96",
    "DWORD scalar cipher is96CA5395, NOT four repetitions of byte XOR5A",
  ],
  [
    0x0041d7d4,
    "ff159cb24800",
    "sample absolute timeGetTime BEFORE body decode",
  ],
  [
    0x0041d7dc,
    "8b865031000005581b00003bc7",
    "lastScheduled+7000 uses wrapping DWORD ADD, NOT unsigned duration subtraction",
  ],
  [
    0x0041d7e9,
    "0f8712010000",
    "unsigned JA throttles; equality accepted, zero marker has no bypass",
  ],
  [0x0041d7f3, "e8c8d30100", "read count only AFTER absolute-time gate"],
  [
    0x0041d7fb,
    "83fb017c0583fb037e0d",
    "counts outside1..3 diagnose rather than directly return",
  ],
  [
    0x0041d80b,
    "e870450100595968ab000000",
    "diagnostic falls through to packet171, including count0 and >3",
  ],
  [
    0x0041d812,
    "68ab000000",
    "response is171, NOT173 or synchronized-object174",
  ],
  [
    0x0041d823,
    "8d87d007000050",
    "future schedule tick is now+2000, wraps DWORD",
  ],
  [0x0041d830, "e86bc40100", "scheduled tick encoded as DWORD"],
  [
    0x0041d855,
    "e866d301008b4d080fb6f0",
    "SECOND of four record bytes is zero-extended box index",
  ],
  [
    0x0041d881,
    "81fefa0000000f8d84000000",
    "box index>=250 branches to disconnect BEFORE all clears/marker/publication",
  ],
  [
    0x0041d8b7,
    "8974bda0473bfb7c84",
    "remember each box ID; decode ALL entries before clearing any",
  ],
  [
    0x0041d8cd,
    "8b862c2d000083a490d80b000000",
    "clear active context+3032+box*4, not allocate a new ID or sync owner",
  ],
  [
    0x0041d8e3,
    "898650310000",
    "marker stores SCHEDULED tick, not request receipt",
  ],
  [
    0x0041d8ef,
    "e886c2ffff",
    "broadcast171 via CBaseSession, no sender exclusion or chief predicate",
  ],
  [0x0041d93c, "ff5048", "invalid box uses socket virtual+72 Close(0)"],
  [
    0x0041bf07,
    "83a65031000000",
    "actual DoStartGame resets aircraft marker to0",
  ],
] as const;
for (const [va, bytes] of anchors)
  if (image.read(va, bytes.length / 2).toString("hex") !== bytes)
    throw new Error(`Unexpected airplane instruction at ${va.toString(16)}`);
mkdirSync(".analysis/reference", { recursive: true });
const executable = resolve(".analysis/reference/airplane");
const build = Bun.spawnSync([
  "g++",
  "-std=c++17",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-O2",
  "tests/reference/airplane.cpp",
  "-o",
  executable,
]);
if (build.exitCode) throw new Error(build.stderr.toString());
const run = Bun.spawnSync([executable]);
if (run.exitCode) throw new Error(run.stderr.toString());
const data: Record<string, unknown> = JSON.parse(run.stdout.toString());
writeFileSync(
  "tests/fixtures/airplane-vectors.json",
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
  "Generated independent manual C++ airplane timing/body/context/wire vectors; NOT original execution/client/security proof.",
);
