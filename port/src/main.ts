/**
 * Suite entry — boots the servers against the shipped configuration files.
 *
 *   bun run start            → all six (center, relay, game, shop, util, login)
 *   bun run start -- --only game --idx 1    → one piece / one instance
 *   bun run start -- --ip 127.0.0.1         → re-point ServerIP/CenterIP of the
 *        shipped cfgs at a local address (the files ship the original
 *        operator's public IP 211.20.189.187; listeners always bind 0.0.0.0)
 *   --cfg <file> overrides the per-piece cfg (game/shop default to the
 *        shipped FXGS_00{idx}.cfg / FXSS_00{idx}.cfg, --idx picks the file)
 */
import { CServerConfig } from "./core/Config.ts";
import { PacketLog } from "./core/PacketLog.ts";
import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { CxCenter } from "./center/Center.ts";
import { main as loginMain } from "./login/Login.ts";
import { main as gameMain } from "./gameserver/GameServer.ts";
import { main as relayMain } from "./relay/Relay.ts";
import { main as shopMain } from "./shop/Shop.ts";
import { main as utilMain } from "./utilserver/UtilServer.ts";

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
if (process.argv.includes("--ip")) {
  CServerConfig.ms_strIpOverride = process.argv[process.argv.indexOf("--ip") + 1]!;
}
const dbDir = join(import.meta.dir, "..", "db");
mkdirSync(dbDir, { recursive: true });

// PacketLog (CA_PACKET_LOG) is off by default like every diagnostic; say so
// once at boot so a silent trace is never mistaken for a broken one.
if (!PacketLog.Enabled()) {
  console.log("PacketLog: off — set CA_PACKET_LOG=1 (console) or CA_PACKET_LOG=<file> to trace every packet.");
} else {
  const v = process.env.CA_PACKET_LOG!;
  const scope = process.env.CA_PACKET_LOG_SCOPE;
  const scopeNote = !scope || scope === "client" ? "client links only" : "all links incl. S2S";
  console.log(`PacketLog: on → ${v === "1" ? "console" : v} (${scopeNote}; CA_PACKET_LOG_HEX caps each dump).`);
}

/** Resolve a --cfg value: absolute paths pass through (also on Windows,
 *  where "C:\\..." does not start with "/"), relative ones anchor at the
 *  port directory. */
function resolveCfg(cfgFile: string): string {
  return isAbsolute(cfgFile) ? cfgFile : join(import.meta.dir, "..", cfgFile);
}

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
  await relayMain(resolveCfg(cfgFile));
}

if (!only || only === "game") {
  // FXGS_00{idx}.cfg: ServerIndex {idx} → port 4848 for idx 0 in the shipped
  // topology; the test topology runs five game servers (test/game0.cfg …).
  const idx = process.argv.includes("--idx") ? Number(process.argv[process.argv.indexOf("--idx") + 1]) : 0;
  const cfgFile =
    process.argv.includes("--cfg") ? process.argv[process.argv.indexOf("--cfg") + 1] : `../FXGS/FXGS_00${idx}.cfg`;
  await gameMain(resolveCfg(cfgFile), dbDir);
}

if (!only || only === "shop") {
  // FXSS_00{idx}.cfg: ServerIndex {idx} → port 9801 for idx 0 in the shipped
  // topology.
  const idx = process.argv.includes("--idx") ? Number(process.argv[process.argv.indexOf("--idx") + 1]) : 0;
  const cfgFile =
    process.argv.includes("--cfg") ? process.argv[process.argv.indexOf("--cfg") + 1] : `../FXSS/FXSS_00${idx}.cfg`;
  await shopMain(resolveCfg(cfgFile), dbDir);
}

if (!only || only === "util") {
  // FXUS_000.cfg: the util attaches to the center as server class 99; the
  // tool listener binds the literal 8128 (CListenThread::Proc's 0x1FC0).
  const cfgFile = process.argv.includes("--cfg")
    ? process.argv[process.argv.indexOf("--cfg") + 1]!
    : join(import.meta.dir, "..", "..", "FXUS", "FXUS_000.cfg");
  await utilMain(resolveCfg(cfgFile));
}

if (!only || only === "login") {
  // The LS needs the center's address for its uplink; read it from the LS cfg.
  await loginMain(
    join(import.meta.dir, "..", "..", "LS", "LS_000.cfg"),
    dbDir,
  );
}
