import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { format } from "prettier";
import { CPeImage, OFFICIAL_SERVICES } from "./OfficialSource.ts";
const game = new CPeImage(OFFICIAL_SERVICES.FXGS);
// Whole-function byte ranges pin the absence of target/vote resets, rather
// than treating one nearby instruction as proof. Still read-only, no execution.
const images = [
  [
    0x00420f19,
    916,
    "3632d11090291b27c603deed165fc16ac0e64d4fc1faefb545cb1bb4c72bf7bb",
    "complete ordinary106 handler through next-function boundary",
  ],
  [
    0x00420bb3,
    870,
    "35451bc0b0cc12f2f6470a0cc089fd645920837676a308095eee5fa79c131edc",
    "complete116 LaunchGameStage: NO vote/target write",
  ],
  [
    0x0041bdcf,
    332,
    "5f829cf1941c61d5f2b7a86e78cdc8ff9286e968289f0dd9e2ab9cf7df40c3d5",
    "complete150 DoStartGame: NO vote/target write",
  ],
  [
    0x0041b0da,
    217,
    "a67c32b99e7345745add240db24ee43ce593e923454f10365f7dc1e60ba95cb2",
    "complete ordinary164 return: target-only clear, NO vote-array write",
  ],
] as const;
for (const [VA, Length, SHA256] of images)
  if (
    createHash("sha256").update(game.read(VA, Length)).digest("hex") !== SHA256
  )
    throw new Error(`Unexpected native lifecycle image@${VA.toString(16)}`);
const anchors = [
  [0x00420df3, "e8e22a0000", "launch SetPlaying(true), not vote cancellation"],
  [0x00420dfd, "e8c7a7ffff", "native current context Loading0"],
  [
    0x00420e99,
    "ff159cb24800",
    "launch tail WinMM sample distinct from116 header tick",
  ],
  [0x00420e9f, "89860c310000", "store launch time only"],
  [0x0041be12, "e82cfaffff", "DoStart samples native game clock"],
  [
    0x0041b843,
    "568bf1ff159cb24800832600836608008946045ec3",
    "ENTIRE21-byte StartGame resets stopped/end/start, PRESERVES suspended+12",
  ],
  [0x0041be34, "6896000000", "BeginGame150"],
  [0x0041be3b, "c786d803000001000000", "native stageRunning1"],
  [0x0041be57, "8b8618310000", "sequence XOR key roles"],
  [0x0041be65, "33c2", "XOR, not addition/new token"],
  [0x0041be67, "42", "sequence increments once"],
  [0x0041be72, "ffb610310000", "ghost start seconds encoded BEFORE conversion"],
  [
    0x0041be7f,
    "ffb614310000",
    "ghost frequency seconds encoded BEFORE conversion",
  ],
  [0x0041bf02, "e8fa51feff", "chief Init has its OWN later clock sample"],
  [0x0041bf11, "e864dcffff", "150 sent AFTER both clock/helper roles"],
  [0x0041b0ef, "68a4000000", "164 ordinary return"],
  [0x0041b108, "e86deaffff", "164 sent BEFORE reset"],
  [0x0041b10d, "899ed8030000", "return stageLoading0"],
  [0x0041b113, "899e3c030000", "ONLY target global serial+828 clears"],
  [0x0041b119, "ff159cb24800", "return chat timestamp gets native own sample"],
  [0x0041b12f, "e8a6870000", "SetPlaying(false)"],
  [0x0041b143, "8020e3", "return ready/status bits clear only"],
  [
    0x0041bbb2,
    "399e3c030000",
    "ordinary departure checks active vote before loading tail",
  ],
  [
    0x0041bbbe,
    "ff9090000000",
    "native deferred tally precedes conditional survivor start",
  ],
] as const;
for (const [VA, Bytes] of anchors)
  if (game.read(VA, Bytes.length / 2).toString("hex") !== Bytes)
    throw new Error(`Unexpected vote lifecycle anchor@${VA.toString(16)}`);
mkdirSync(".analysis/reference", { recursive: true });
const exe = resolve(".analysis/reference/vote-lifecycle"),
  build = Bun.spawnSync([
    "g++",
    "-std=c++17",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "tests/reference/vote-lifecycle.cpp",
    "-o",
    exe,
  ]);
if (build.exitCode) throw new Error(build.stderr.toString());
const run = Bun.spawnSync([exe]);
if (run.exitCode) throw new Error(run.stderr.toString());
const data: Record<string, unknown> = JSON.parse(run.stdout.toString());
writeFileSync(
  "tests/fixtures/vote-lifecycle-vectors.json",
  await format(
    JSON.stringify({
      ...data,
      OfficialPE: { SHA256: game.sha256 },
      FunctionImages: images.map(([VA, Length, SHA256, Meaning]) => ({
        VA,
        Length,
        SHA256,
        Meaning,
      })),
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
  `Generated ${images.length} full images/${anchors.length} literal anchors/${data.CaseCount} manual lifecycle cases; NOT native execution, SQL, resource or client oracle.`,
);
