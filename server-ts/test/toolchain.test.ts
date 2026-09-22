import { describe, expect, test } from "bun:test";
import { FindToolchainDifferences, type ToolchainVersions } from "../tools/check-toolchain.ts";

function versions(): ToolchainVersions {
  return {
    bun: { version: "1.0.0", revision: "revision-a" },
    sqlite: { version: "3.0.0", sourceId: "sqlite-source-a" },
    packages: { bun: "1.0.0-canary.1", "bun-types": "1.0.0-canary.types", typescript: "7.0.0-dev.fixture" },
  };
}

describe("pinned preview toolchain guard", () => {
  test("matching versions, including the npm wrapper's build suffix", () => {
    const actual = versions(); actual.packages.bun += "+abcdef";
    expect(FindToolchainDifferences(versions(), actual)).toEqual([]);
  });
  test("same Bun version with another revision is not the same runtime", () => {
    const actual = versions(); actual.bun.revision = "revision-b";
    expect(FindToolchainDifferences(versions(), actual)).toEqual(["bun.revision: expected revision-a, got revision-b"]);
  });
  test("stable compiler/types and missing runtime package are all reported", () => {
    const actual = versions(); actual.packages.typescript = "7.0.0"; actual.packages["bun-types"] = "1.0.0";
    delete actual.packages.bun;
    expect(FindToolchainDifferences(versions(), actual)).toHaveLength(3);
  });
  test("SQLite version AND source identity must match", () => {
    const actual = versions(); actual.sqlite = { version: "3.1.0", sourceId: "sqlite-source-b" };
    expect(FindToolchainDifferences(versions(), actual)).toEqual([
      "sqlite.version: expected 3.0.0, got 3.1.0", "sqlite.sourceId: expected sqlite-source-a, got sqlite-source-b",
    ]);
  });
  test("the real guard succeeds independently of the working directory", async () => {
    const child = Bun.spawn([process.execPath, `${import.meta.dir}/../tools/check-toolchain.ts`], {
      cwd: `${import.meta.dir}/../..`, stdout: "pipe", stderr: "pipe",
    });
    const [exit, text, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(errors).toBe(""); expect(exit).toBe(0);
    const actual = JSON.parse(text) as ToolchainVersions;
    expect(actual.bun.revision).toBe(Bun.revision);
    expect(actual.packages.typescript).toContain("-dev.");
    expect(actual.packages["bun-types"]).toContain("-canary.");
  });
});
