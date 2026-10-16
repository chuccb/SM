import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";
import { CPeImage, OFFICIAL_SERVICES } from "./OfficialSource.ts";
// Compile/run ONLY OUR native arithmetic/state model. Never original EXE,
// original Windows API, SQL or DAT. The modern auth lease is NOT modeled native.
const center = new CPeImage(OFFICIAL_SERVICES.Center),
  fx = new CPeImage(OFFICIAL_SERVICES.FXGS);
const anchors = [
  ["Center", 0x004153e1, "8b4e14", "CheckConnecting free DWORD at+20"],
  ["Center", 0x00415409, "8b4e44", "already connecting DWORD at+68"],
  ["Center", 0x00415431, "397e40", "same server index+64 rejected"],
  ["Center", 0x00415436, "385e3c", "same server type BYTE+60"],
  ["Center", 0x0041545f, "497426", "accepted type1 branch"],
  ["Center", 0x00415462, "83e909", "type10 branch"],
  ["Center", 0x00415467, "49752f", "type11 otherwise reject"],
  ["Center", 0x00415483, "3b7a18", "FXGame registered index count"],
  ["Center", 0x00415492, "8b511c", "Login registered count"],
  [
    "Center",
    0x004154be,
    "8b4834",
    "target live socket pointer, NOT ticket date",
  ],
  ["Center", 0x004154e6, "80782029", "premium channel BYTE41"],
  ["Center", 0x004154f1, "397e38", "Center auth DWORD+56 EXACT1"],
  ["Center", 0x00415512, "897e44", "CHECK already sets connecting flag1"],
  [
    "Center",
    0x00415520,
    "894648",
    "CHECK stores explicit sampled GetTickCount+72",
  ],
  [
    "Center",
    0x0041554c,
    "e8effdffff",
    "SEPARATE SetConnecting calls SetSvrIdx",
  ],
  ["Center", 0x00415584, "8b4614", "established refuses free"],
  ["Center", 0x00415592, "8b4644", "established needs nonzero connecting"],
  ["Center", 0x004155a1, "3a563c", "established exact type BYTE"],
  ["Center", 0x004155a6, "3b4e40", "established exact index, no timeout here"],
  [
    "Center",
    0x00415133,
    "c7474400000000",
    "SetConnectionEstablished clears flag ONLY",
  ],
  [
    "Center",
    0x00415150,
    "8b4138",
    "GetAuthencode returns DWORD, unlike FXGS byte",
  ],
  ["Center", 0x0041561d, "2b4648", "timeout unsigned DWORD subtraction"],
  [
    "Center",
    0x00415620,
    "3d5c440000",
    "17500ms is native deadline, NOT modern30s",
  ],
  ["Center", 0x00415625, "760c", "unsigned jbe => expires STRICT greater-than"],
  ["Center", 0x00415629, "e892fcffff", "timeout invokes one-shot SetFree"],
  [
    "Center",
    0x0041531c,
    "c7464000000080",
    "first SetFree resets server index80000000",
  ],
  ["Center", 0x004098a2, "e809bb0000", "native per-user CheckConnecting loop"],
  ["Center", 0x004098aa, "8bd8", "loop keeps LAST result, not whole-group AND"],
  ["Center", 0x004098ae, "83fb01", "native Set-all gated on last result1"],
  ["Center", 0x004098bf, "e87cbc0000", "then SetConnecting for every member"],
  ["Center", 0x00409c05, "e866b90000", "Center established per-user check"],
  ["Center", 0x00409c34, "e8e7b40000", "then explicit group flag clear"],
  ["FXGS", 0x0040885b, "837dd000", "GS Center response success gate"],
  [
    "FXGS",
    0x00408862,
    "0f8425020000",
    "failed Center response aborts native initialization",
  ],
  [
    "FXGS",
    0x00408887,
    "e8e8df0000",
    "GS reload then SetLevel after authorization",
  ],
  [
    "FXGS",
    0x004088af,
    "e8a1260000",
    "native effects in Center RESPONSE, not client request",
  ],
] as const;
for (const [service, va, bytes] of anchors) {
  const pe = service === "Center" ? center : fx;
  if (pe.read(va, bytes.length / 2).toString("hex") !== bytes)
    throw new Error(
      `Unexpected ${service} connection instruction ${va.toString(16)}`,
    );
}
mkdirSync(".analysis/reference", { recursive: true });
const exe = resolve(".analysis/reference/center-connection"),
  build = Bun.spawnSync([
    "g++",
    "-std=c++17",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "tests/reference/center-connection.cpp",
    "-o",
    exe,
  ]);
if (build.exitCode) throw new Error(build.stderr.toString());
const run = Bun.spawnSync([exe]);
if (run.exitCode) throw new Error(run.stderr.toString());
const model: Record<string, unknown> = JSON.parse(run.stdout.toString());
writeFileSync(
  "tests/fixtures/center-connection-vectors.json",
  await format(
    JSON.stringify({
      ...model,
      OfficialPE: [
        { Service: "Center", SHA256: center.sha256 },
        { Service: "FXGS", SHA256: fx.sha256 },
      ],
      InstructionAnchors: anchors.map(([Service, VA, Bytes, Meaning]) => ({
        Service,
        VA,
        Bytes,
        Meaning,
      })),
    }),
    { parser: "json" },
  ),
);
console.log(
  `Generated native Center CHECK/route/established/timeout model + ${anchors.length} PE anchors. NOT native execution, modern lease or Center TCP proof.`,
);
