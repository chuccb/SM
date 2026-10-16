import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";

// Opt-in regeneration, requires g++; ordinary bun test uses the frozen fixture.
mkdirSync(".analysis/reference", { recursive: true });
const executable = resolve(".analysis/reference/packet");
const result = Bun.spawnSync([
  "g++",
  "-std=c++17",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-Wno-misleading-indentation",
  "-O2",
  "tests/reference/packet.cpp",
  "-o",
  executable,
]);
if (result.exitCode) throw new Error(result.stderr.toString());
const vectors = Bun.spawnSync([executable, resolve("LS/CxLogin.exe")]);
if (vectors.exitCode) throw new Error(vectors.stderr.toString());
// Match the other seven builders and the repository formatter so rebuilding
// does not create whitespace-only fixture/hash churn.
const data: unknown = JSON.parse(vectors.stdout.toString());
writeFileSync(
  "tests/fixtures/packet-vectors.json",
  await format(JSON.stringify(data), { parser: "json" }),
);
console.log(
  "Regenerated frozen vectors with independent C++ reference. This is not an official-client compatibility test.",
);
