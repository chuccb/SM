import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";
import { CPeImage, OFFICIAL_SERVICES } from "./OfficialSource.ts";

// Read-only instruction anchors BEFORE compiling the independent manual model.
// No production lifecycle/rank/calculator import and NO original binary runs.
const game = new CPeImage(OFFICIAL_SERVICES.FXGS);
for (const [va, hex] of [
  [0x0041b0c6, "3d401f0000760b"], // cmp8000 / unsigned jbe
  [0x0041dcc7, "3d20bf02007622"], // cmp180000 / unsigned jbe
  [0x0041b143, "8020e3"], // ready-mask byte AND e3
  [0x0041b0ef, "68a4000000"], // response164
  [0x00404f4d, "3bdf7f18"], // signed cached-level comparison
  [0x00404f59, "3bbaac0700007208"], // unsigned global-serial tie comparison
  [0x004216ef, "c20400"], // ordinary SendSessionInfo really is no-op ret4
] as const) {
  if (game.read(va, hex.length / 2).toString("hex") !== hex)
    throw new Error(`Unexpected lifecycle instruction at ${va.toString(16)}`);
}
mkdirSync(".analysis/reference", { recursive: true });
const executable = resolve(".analysis/reference/result-lifecycle");
const build = Bun.spawnSync([
  "g++",
  "-std=c++17",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-O2",
  "tests/reference/result-lifecycle.cpp",
  "-o",
  executable,
]);
if (build.exitCode) throw new Error(build.stderr.toString());
const run = Bun.spawnSync([executable]);
if (run.exitCode) throw new Error(run.stderr.toString());
const parsed: Record<string, unknown> = JSON.parse(run.stdout.toString());
writeFileSync(
  "tests/fixtures/result-lifecycle-vectors.json",
  await format(
    JSON.stringify(
      { ...parsed, OfficialPE: { Service: "FXGS", SHA256: game.sha256 } },
      null,
      2,
    ),
    { parser: "json" },
  ),
);
console.log(
  "Generated manual C++ rank/deadline/return vectors; NOT native execution or client/storage parity.",
);
