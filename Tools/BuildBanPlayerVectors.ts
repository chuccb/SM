import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";
import { CPeImage, OFFICIAL_SERVICES } from "./OfficialSource.ts";

// Only our C++ model executes. All supplied PE access is read-only. No
// production room/user/permission/policy/item/codec calculators are imported.
const game = new CPeImage(OFFICIAL_SERVICES.FXGS);
const anchors = [
  [
    0x00406c66,
    "33c0c20400",
    "CClientSocket.HasAuthority ANY parameter is zero",
  ],
  [0x0041688a, "33c0c20400", "CUser.HasAuthority is independently also zero"],
  [0x00416af1, "807e0802", "functional Category2, no Amount/Slot predicate"],
  [0x00416aff, "e89f8a0500", "functional exact encoded __mbscmp"],
  [
    0x0048e4c8,
    "4974656d2f5375706572436869656600",
    "exact Item/SuperChief bytes",
  ],
  [0x00490184, "4974656d2f42616e5265666c657800", "exact Item/BanReflex bytes"],
  [
    0x00423c77,
    "8dbe3c030000",
    "respond targets native+828, not slot or serial-generation",
  ],
  [0x00423c7d, "833f00", "no active target returns before decoding fields"],
  [
    0x00423c85,
    "e8d66f0100",
    "reached response decodes DWORD target serial first",
  ],
  [0x00423c8c, "755e", "wrong serial skips answer and ANY changes"],
  [0x00423c92, "e8296f0100", "answer byte read only after target match"],
  [0x00423cbc, "8d84860c030000", "per-local vote DWORD at+780"],
  [0x00423cc3, "833801", "only pending1 may be replaced"],
  [
    0x00423cc6,
    "7523",
    "first nonpending local returns, retaining previous prefix",
  ],
  [0x00423ccb, "f7d91bc983c103", "answer ANY nonzero ->2; zero->3"],
  [0x00423ce5, "ff9090000000", "Defer called only after complete local loop"],
  [0x00424a71, "8b8660030000", "host ask validates current chief slot+864"],
  [0x00424a97, "39b8a4070000", "host ask requires chief socket+1956"],
  [0x00424aa3, "399e3c030000", "busy target checked BEFORE reading request"],
  [0x00424aab, "6a72", "busy response114"],
  [0x00424ab5, "6a01", "busy result code1, chief only"],
  [0x00424ad9, "e882610100", "request target DWORD"],
  [0x00424ae4, "e8d7600100", "request immediate BYTE"],
  [0x00424b01, "e85925feff", "own serial checked across BOTH chief locals"],
  [0x00424b56, "8d860c030000", "initialize native vote array+780"],
  [
    0x00424b6d,
    "3991ac070000",
    "initial target exclusion compares global serial+1964",
  ],
  [0x00424b7f, "c70001000000", "all other occupied slots pending1"],
  [0x00424bc4, "68c8e44800", "SuperChief iterates chief SOCKET locals"],
  [0x00424bd5, "e80b1fffff", "SuperChief native functional query"],
  [0x00424bda, "85c0", "first found SuperChief short-circuits local loop"],
  [0x00424c32, "6884014900", "BanReflex queries target SOCKET locals"],
  [0x00424c41, "e89f1effff", "BanReflex same Category2 functional query"],
  [0x00424c80, "83a4860c03000000", "all target locals excluded0 before vote"],
  [0x00424c9f, "89863c030000", "publish target GLOBAL SERIAL at+828"],
  [0x00424ce3, "ff9090000000", "initial tally BEFORE question113/started0"],
  [0x00424cf5, "6a71", "question response113"],
  [0x00424d0c, "e88f4f0100", "question first encodes target DWORD"],
  [0x00424d35, "e8864f0100", "question includes TARGET local name"],
  [0x00424d73, "e8571ffeff", "question excludes entire target socket"],
  [0x00424d7f, "e84b1ffeff", "question excludes entire chief socket"],
  [
    0x00424d9e,
    "394dec",
    "last eligible socket compared, NOT a global recipient set",
  ],
  [0x00424dae, "8945ec", "last socket only updated after question send"],
  [0x00424dc2, "6a72", "after questions, reinitialize114"],
  [0x00424df7, "899e3c030000", "reflex clears target BEFORE destruction"],
  [0x00424e0f, "6a01", "reflex table DestroyPlayer includeSelf TRUE"],
  [0x00424e12, "ff5030", "reflex uses actual session TABLE+48"],
  [0x00424e29, "6a05", "reflex result5 includes chief local name"],
  [0x00424e7b, "899e3c030000", "immediate clears target BEFORE destruction"],
  [0x00424e93, "6a01", "immediate includeSelf TRUE, not chief121 false"],
  [0x00424e96, "ff5030", "immediate table destroy precedes114"],
  [0x00424e99, "6a04", "immediate result4 omits name"],
  [0x00424ff2, "398e3c030000", "defer target found by global serial"],
  [
    0x00424ffd,
    "8b84860c030000",
    "defer per-LOCAL state, not one ballot/socket",
  ],
  [0x00425004, "85c0", "ANY nonzero vote enters denominator"],
  [0x0042500b, "83f802", "Yes exactly2"],
  [0x00425015, "83f803", "No exactly3"],
  [0x00425060, "6a04", "missing target114/4, no name"],
  [0x00425087, "8d0c12", "Yes multiplied2"],
  [0x0042508d, "0f8ea5000000", "strict Yes majority: equality does NOT pass"],
  [0x004250b3, "6a01", "majority table destroy includes departing peers"],
  [0x004250b6, "ff5030", "majority table destruction BEFORE publication"],
  [0x004250cd, "6a02", "majority result2 with TARGET name"],
  [0x00425141, "7d10", "No tie already fails (2*No >= Total)"],
  [0x00425148, "7d09", "all Yes+No answered also terminates"],
  [0x00425168, "6a03", "failed result3 with TARGET name"],
  [
    0x0048f69c,
    "784f4200",
    "real CGameSession vtable+144 is CListSession.DeferBanPlayer",
  ],
  [
    0x0041bbb2,
    "399e3c030000",
    "ordinary destruction tests active vote AFTER deletion/sync",
  ],
  [
    0x0041bbbe,
    "ff9090000000",
    "ordinary departure synchronously RECOUNTS vote",
  ],
] as const;
for (const [VA, Bytes] of anchors)
  if (game.read(VA, Bytes.length / 2).toString("hex") !== Bytes)
    throw new Error(`Unexpected ban-player anchor @${VA.toString(16)}`);
mkdirSync(".analysis/reference", { recursive: true });
const executable = resolve(".analysis/reference/ban-player"),
  build = Bun.spawnSync([
    "g++",
    "-std=c++17",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "tests/reference/ban-player.cpp",
    "-o",
    executable,
  ]);
if (build.exitCode) throw new Error(build.stderr.toString());
const run = Bun.spawnSync([executable]);
if (run.exitCode) throw new Error(run.stderr.toString());
const data: Record<string, unknown> = JSON.parse(run.stdout.toString());
writeFileSync(
  "tests/fixtures/ban-player-vectors.json",
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
  `Generated ${anchors.length} fixed anchors /${data.CaseCount} vote-ban policy cases; NOT live removal, SQL, permission, original execution or client proof.`,
);
