import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";

// Opt-in only. Normal bun test consumes the frozen, small JSON fixture.
mkdirSync(".analysis/reference", { recursive: true });
const executable = resolve(".analysis/reference/gameplay");
const build = Bun.spawnSync([
  "g++",
  "-std=c++17",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-O2",
  "tests/reference/gameplay.cpp",
  "-o",
  executable,
]);
if (build.exitCode) throw new Error(build.stderr.toString());
const run = Bun.spawnSync([executable]);
if (run.exitCode) throw new Error(run.stderr.toString());
const parsed: unknown = JSON.parse(run.stdout.toString());
writeFileSync(
  "tests/fixtures/gameplay-vectors.json",
  await format(JSON.stringify(parsed, null, 2), { parser: "json" }),
);
console.log(
  "Generated manually translated gameplay reference vectors; not an original-client compatibility test.",
);
