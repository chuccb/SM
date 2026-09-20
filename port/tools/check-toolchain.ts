/** Verify the pinned preview packages AND the runtime actually executing us.
 * No network, production DB, schema migration, or global tool installation.
 */
import { Database } from "bun:sqlite";

export interface ToolchainVersions {
  bun: { version: string; revision: string };
  sqlite: { version: string; sourceId: string };
  packages: Record<string, string>;
}

/** npm's Bun wrapper embeds a +commit build suffix absent from its dist-tag. */
function packageVersion(version: string): string {
  return version.split("+", 1)[0]!;
}

export function FindToolchainDifferences(expected: ToolchainVersions, actual: ToolchainVersions): string[] {
  const differences: string[] = [];
  function compare(label: string, wanted: string, observed: string): void {
    if (wanted !== observed) differences.push(`${label}: expected ${wanted}, got ${observed}`);
  }
  compare("bun.version", expected.bun.version, actual.bun.version);
  compare("bun.revision", expected.bun.revision, actual.bun.revision);
  compare("sqlite.version", expected.sqlite.version, actual.sqlite.version);
  compare("sqlite.sourceId", expected.sqlite.sourceId, actual.sqlite.sourceId);
  for (const [name, version] of Object.entries(expected.packages)) {
    const installed = actual.packages[name];
    if (!installed || packageVersion(installed) !== packageVersion(version))
      differences.push(`${name}: expected ${version}, got ${installed ?? "not installed"}`);
  }
  return differences;
}

export async function CheckToolchain(): Promise<void> {
  const root = new URL("../", import.meta.url);
  const manifest: { devDependencies: Record<string, string> } = await Bun.file(new URL("package.json", root)).json();
  const pinned: Omit<ToolchainVersions, "packages"> = await Bun.file(new URL("toolchain.json", root)).json();
  const expected: ToolchainVersions = { ...pinned, packages: manifest.devDependencies };
  const packages: Record<string, string> = {};
  for (const name of Object.keys(expected.packages)) {
    // Resolve from the project, never from a global tsc/Bun installation.
    const file = new URL(`node_modules/${name}/package.json`, root);
    if (await Bun.file(file).exists()) packages[name] = (await Bun.file(file).json()).version;
  }
  using db = new Database(":memory:");
  const sqlite = db.query<{ version: string; sourceId: string }, []>(
    "SELECT sqlite_version() AS version, sqlite_source_id() AS sourceId",
  ).get()!;
  const actual: ToolchainVersions = { bun: { version: Bun.version, revision: Bun.revision }, sqlite, packages };
  const differences = FindToolchainDifferences(expected, actual);
  if (differences.length) {
    throw new Error(`Preview toolchain mismatch:\n${differences.join("\n")}\n` +
      "Run bun install --frozen-lockfile, then ./node_modules/.bin/bun run check from port/. " +
      "Do not silently substitute a stable or different canary runtime.");
  }
  console.log(JSON.stringify(actual, null, 2));
}

if (import.meta.main) await CheckToolchain();
