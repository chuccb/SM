/**
 * Suite entry — boots the servers against the shipped configuration files.
 *
 *   bun run start            → center + login (the pieces ported so far)
 *   bun run center           → center only
 *   bun run login            → login only (expects a center on Center_000.cfg's port)
 */
import { CServerConfig } from "./core/Config.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CxCenter } from "./center/Center.ts";
import { main as loginMain } from "./login/Login.ts";
import { main as gameMain } from "./gameserver/GameServer.ts";
import { main as relayMain } from "./relay/Relay.ts";

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const dbDir = join(import.meta.dir, "..", "db");
mkdirSync(dbDir, { recursive: true });

if (!only || only === "center") {
  const cfg = new CServerConfig();
  cfg.Init(join(import.meta.dir, "..", "..", "Center", "Center_000.cfg"));
  CServerConfig.ms_pInstance = cfg;
  const center = new CxCenter(cfg);
  center.InitServerTable();
  await center.Listen();
  center.ListenMonitor();
  center.StartTimer();
}

if (!only || only === "relay") {
  const cfgFile = process.argv.includes("--cfg")
    ? process.argv[process.argv.indexOf("--cfg") + 1]!
    : join(import.meta.dir, "..", "..", "Relay", "Relay_000.cfg");
  await relayMain(cfgFile.startsWith("/") ? cfgFile : join(import.meta.dir, "..", cfgFile));
}

if (!only || only === "game") {
  // FXGS_000.cfg: ServerIndex 0 → port 4848 in the shipped topology; the test
  // topology runs five game servers (test/game0.cfg … game4.cfg).
  const idx = process.argv.includes("--idx") ? Number(process.argv[process.argv.indexOf("--idx") + 1]) : 0;
  const cfgFile =
    process.argv.includes("--cfg") ? process.argv[process.argv.indexOf("--cfg") + 1] : `test/game${idx}.cfg`;
  await gameMain(
    cfgFile.startsWith("/") ? cfgFile : join(import.meta.dir, "..", cfgFile),
    dbDir,
  );
}

if (!only || only === "login") {
  // The LS needs the center's address for its uplink; read it from the LS cfg.
  await loginMain(
    join(import.meta.dir, "..", "..", "LS", "LS_000.cfg"),
    dbDir,
  );
}
