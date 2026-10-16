import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";

// Opt-in only. Frozen vectors are consumed by bun test, without a C++ dependency.
mkdirSync(".analysis/reference", { recursive: true });
const executable = resolve(".analysis/reference/session");
const build = Bun.spawnSync([
  "g++",
  "-std=c++17",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-O2",
  "tests/reference/session.cpp",
  "-o",
  executable,
]);
if (build.exitCode) throw new Error(build.stderr.toString());
const run = Bun.spawnSync([executable]);
if (run.exitCode) throw new Error(run.stderr.toString());
const parsed: unknown = JSON.parse(run.stdout.toString());
writeFileSync(
  "tests/fixtures/session-vectors.json",
  await format(JSON.stringify(parsed, null, 2), { parser: "json" }),
);
console.log(
  "Generated manually translated session vectors; not official execution or client compatibility evidence.",
);
