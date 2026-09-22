/** Offline A23 shard audit/migration. Stop every server before migrate. */
import { join, resolve } from "node:path";
import { inspectUserShardLayout, migrateUserShards } from "./UserShardMigration.ts";

const USAGE = `Usage:
  bun tools/user-shards.ts inspect [--db DIRECTORY]
  bun tools/user-shards.ts migrate [--db DIRECTORY] --backup NEW_DIRECTORY --confirm-services-stopped`;

interface Options {
  readonly command: "inspect" | "migrate";
  readonly dbDirectory: string;
  readonly backupDirectory?: string;
}

function parseArguments(arguments_: readonly string[]): Options {
  const args = arguments_.filter(argument => argument !== "--");
  const command = args.shift();
  if (command !== "inspect" && command !== "migrate") throw new Error(USAGE);
  let dbDirectory = join(import.meta.dir, "../db");
  let backupDirectory: string | undefined;
  let confirmed = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (seen.has(flag)) throw new Error(`Duplicate option ${flag}.\n${USAGE}`);
    seen.add(flag);
    if (flag === "--confirm-services-stopped") {
      confirmed = true;
      continue;
    }
    if (flag !== "--db" && flag !== "--backup") throw new Error(`Unknown option ${flag}.\n${USAGE}`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.\n${USAGE}`);
    if (flag === "--db") dbDirectory = resolve(value);
    else backupDirectory = resolve(value);
  }
  if (command === "inspect") {
    if (confirmed || backupDirectory) throw new Error(`inspect accepts only --db.\n${USAGE}`);
  } else if (!confirmed || !backupDirectory) {
    throw new Error(`migrate requires a new --backup directory and --confirm-services-stopped.\n${USAGE}`);
  }
  return {
    command,
    dbDirectory: resolve(dbDirectory),
    ...(backupDirectory ? { backupDirectory } : {}),
  };
}

try {
  const options = parseArguments(process.argv.slice(2));
  const report = options.command === "inspect"
    ? inspectUserShardLayout(options.dbDirectory)
    : migrateUserShards(options.dbDirectory, options.backupDirectory!);
  console.log(JSON.stringify(report, null, 2));
  if (report.status === "conflict") process.exitCode = 2;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
