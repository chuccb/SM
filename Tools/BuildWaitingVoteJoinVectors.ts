import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";
import { CPeImage, OFFICIAL_SERVICES } from "./OfficialSource.ts";
const game = new CPeImage(OFFICIAL_SERVICES.FXGS);
// Fixed complete function bodies where absence of a vote write matters; read
// only. Only our C++ projection runs. No production user/codec/policy imports.
const anchors = [
  [
    0x00406c66,
    "33c0c20400",
    "Socket.HasAuthority ANY argument, including1/24, returns0",
  ],
  [
    0x00423d8d,
    "56ff7424148bf1ff742414ff742414ff742414e8405cfffffe8640030000808e58030000045ec21000",
    "ENTIRE41-byte List.AddUser: Base, count, modified4; NO ballot/target writes",
  ],
  [
    0x0042410d,
    "568bf183be54030000007511ff74240cff74240ce88557ffff85c0750433c0eb2a8b4c24086a18e82d2bfeff85c074188b4c24086a00e8092bfeffffb0a80700008bcee8f6feffff33c0405ec20800",
    "ENTIRE79-byte List.AddPlayer: playing/base/zero authority24; NO Defer or113/114",
  ],
  [
    0x0041af4b,
    "5657ff7424188b7c2410ff7424188bf1ff74241857e8288e0000838cbe342d0000ffc684378c32000000ff159cb248008984be943200005f5ec21000",
    "ENTIRE60-byte Game.AddUser: List, actual-bomber -1, peer0, PER-LOCAL WinMM tick; NO ballots",
  ],
  [0x004199e5, "535657", "Base.AddUser entry, native per-local overload"],
  [0x00419a06, "895cbe14", "bind player pointer at slot"],
  [0x00419a14, "e8aad3ffff", "set room IDX"],
  [0x00419a21, "e8cdd3ffff", "set room serial"],
  [0x00419a2c, "ff501c", "set stored player slot"],
  [0x00419a35, "c780d401000002000000", "native socket pool2 after enrollment"],
  [0x00419a52, "806044e1", "clear Chief2/status1C only, retain high flags"],
  [0x00419a56, "80e23f", "bomber low6 bits only"],
  [0x00419a63, "80e11f", "color low5 bits only"],
  [0x00423da5, "fe8640030000", "native player count increment per local"],
  [0x00423dab, "808e5803000004", "list modified PlayerCount bit4"],
  [0x00424132, "6a18", "chief reassignment only if authority24, actual stub0"],
  [
    0x0041af75,
    "ff159cb24800",
    "native clock is a distinct call for EACH added local",
  ],
  [0x0041af7b, "8984be94320000", "store join DWORD per slot"],
  [0x004228da, "663dffff", "every incoming local must have no-session IDX"],
  [
    0x004228fb,
    "e86643feff",
    "password authority1 is the independent socket zero stub",
  ],
  [0x00422913, "e88bcc0400", "password exact encoded mbscmp"],
  [0x0042292c, "6a01", "bad password81/1"],
  [0x0042295a, "ff5024", "table calls actual AddPlayer before ACK"],
  [0x00422961, "6a51", "success81"],
  [0x0042296b, "6a00", "success BYTE0"],
  [0x0042298c, "ff5050", "after ACK, send full session info"],
  [0x00422994, "ff5054", "then send join105 to current peers"],
  [0x0042299b, "e826a1ffff", "then current game-type message"],
] as const;
for (const [VA, Bytes] of anchors)
  if (game.read(VA, Bytes.length / 2).toString("hex") !== Bytes)
    throw new Error(`Unexpected waiting join PE@${VA.toString(16)}`);
mkdirSync(".analysis/reference", { recursive: true });
const exe = resolve(".analysis/reference/waiting-vote-join"),
  build = Bun.spawnSync([
    "g++",
    "-std=c++17",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "tests/reference/waiting-vote-join.cpp",
    "-o",
    exe,
  ]);
if (build.exitCode) throw new Error(build.stderr.toString());
const run = Bun.spawnSync([exe]);
if (run.exitCode) throw new Error(run.stderr.toString());
const data: Record<string, unknown> = JSON.parse(run.stdout.toString());
writeFileSync(
  "tests/fixtures/waiting-vote-join-vectors.json",
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
  `Generated ${anchors.length} literal PE anchors/${data.CaseCount} manual waiting-vote join cases; NOT original execution, resource/SQL policy, authority or complete-client proof.`,
);
