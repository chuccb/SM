/**
 * Suite entry — boots the servers against the shipped configuration files.
 *
 *   bun run start            → six game services plus the configured local billing replacement
 *   bun run start -- --only game --idx 1    → one piece / one instance
 *   bun run start -- --ip <addr>            → re-point ServerIP/CenterIP of the
 *        shipped cfgs at <addr> (they ship 127.0.0.1; listeners always bind
 *        0.0.0.0, so this covers multi-host deployments)
 *   --cfg <file> overrides the per-piece cfg (game/shop default to the
 *        shipped FXGS_00{idx}.cfg / FXSS_00{idx}.cfg, --idx picks the file)
 *   --db <dir>   overrides the SQLite directory (default port/db)
 */
import { CServerConfig, CXCENTER_STR_KEYS } from "./core/ServerConfig.ts";
import { PacketLog } from "./core/PacketLog.ts";
import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { CCxCenterApp } from "./Center/CxCenter.ts";
import { main as loginMain } from "./LS/CxLogin.ts";
import { main as gameMain } from "./FXGS/FxServer.ts";
import { main as relayMain } from "./Relay/CxRelay.ts";
import { main as shopMain } from "./FXSS/FxShop.ts";
import { main as utilMain } from "./FXUS/CxUtil.ts";
import { CDBMan } from "./db/DBMan.ts";
import { canUseLocalBilling, loadBillingConfig, registerLocalBilling } from "./LocalBilling/Config.ts";
import { EnsureCAItemCatalog } from "./db/CAItemImport.ts";
import { startBilling } from "./LocalBilling/Server.ts";

const cleanUpStack: Array<() => void> = [];
let cleanUpStarted = false;

function RegisterCleanUp(cleanUp: () => void): void {
  cleanUpStack.push(cleanUp);
}

function CleanUp(): void {
  if (cleanUpStarted) return;
  cleanUpStarted = true;
  for (const cleanUp of cleanUpStack.toReversed()) {
    try {
      cleanUp();
    } catch (error) {
      console.error("Service cleanup failed", error);
    }
  }
  cleanUpStack.length = 0;
}

for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.once(signal, () => {
    CleanUp();
    process.exitCode = exitCode;
  });
}
process.once("exit", CleanUp);

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
if (process.argv.includes("--ip")) {
  CServerConfig.ms_strIpOverride = process.argv[process.argv.indexOf("--ip") + 1]!;
}
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

const dbDir = process.argv.includes("--db")
  ? resolveCfg(process.argv[process.argv.indexOf("--db") + 1]!)
  : join(import.meta.dir, "..", "db");
mkdirSync(dbDir, { recursive: true });

// Bootstrap only catalog-consuming services; isolated tests/custom deployments
// can explicitly opt out. No player, billing, guild or endpoint data is imported.
if ((!only || only === "game" || only === "shop") && !process.argv.includes("--no-caitem-import")) {
  const result = EnsureCAItemCatalog(dbDir);
  console.log(`[CAItem] ${result.status}: ${JSON.stringify(result.rows)}${result.status === "imported" ? " (original backup FILE=1)" : " (existing data preserved)"}`);
  if (result.status === "existing-catalog" && result.rows.FxStock === 0)
    console.warn("[CAItem] Existing partial catalog has no stock; refusing automatic merge. Run caitem:inspect and review CAItem.db.");
}

// Start the optional local replacement BEFORE Shop reads BillingSvr. Existing
// external endpoints are never overwritten or interpreted as the local mode.
if (!only || only === "billing") {
  const pathIndex = process.argv.indexOf("--billing-config");
  const config = loadBillingConfig(pathIndex < 0 ? undefined : resolveCfg(process.argv[pathIndex + 1]!));
  const db = new CDBMan(dbDir);
  if (canUseLocalBilling(db, config)) {
    const server = startBilling(db, config);
    try {
      registerLocalBilling(db, config);
      RegisterCleanUp(() => {
        server.close();
        db.Close();
      });
    } catch (error) {
      server.close();
      db.Close();
      throw error;
    }
  } else {
    db.Close();
    if (only === "billing") throw new Error("Local billing is disabled or BillingSvr belongs to an external service.");
    console.log("[Billing] local replacement skipped (disabled or external endpoint configured)");
  }
}

if (!only || only === "center") {
  const cfg = new CServerConfig(CXCENTER_STR_KEYS, true);
  cfg.Init(join(import.meta.dir, "..", "..", "Center", "Center_000.cfg"));
  CServerConfig.ms_pInstance = cfg;
  const center = new CCxCenterApp(cfg);
  try {
    center.SetUp();
    RegisterCleanUp(() => center.CleanUp());
  } catch (error) {
    center.CleanUp();
    throw error;
  }
}

if (!only || only === "relay") {
  const cfgFile = process.argv.includes("--cfg")
    ? process.argv[process.argv.indexOf("--cfg") + 1]!
    : join(import.meta.dir, "..", "..", "Relay", "Relay_000.cfg");
  const relay = await relayMain(resolveCfg(cfgFile));
  RegisterCleanUp(() => relay.CleanUp());
}

if (!only || only === "game") {
  // FXGS_00{idx}.cfg: ServerIndex {idx} → port 4848 for idx 0 in the shipped
  // topology; the test topology runs five game servers (test/game0.cfg …).
  const idx = process.argv.includes("--idx") ? Number(process.argv[process.argv.indexOf("--idx") + 1]) : 0;
  const cfgFile =
    process.argv.includes("--cfg") ? process.argv[process.argv.indexOf("--cfg") + 1] : `../FXGS/FXGS_00${idx}.cfg`;
  const game = await gameMain(resolveCfg(cfgFile), dbDir);
  RegisterCleanUp(() => game.CleanUp());
}

if (!only || only === "shop") {
  // FXSS_00{idx}.cfg: ServerIndex {idx} → port 9801 for idx 0 in the shipped
  // topology.
  const idx = process.argv.includes("--idx") ? Number(process.argv[process.argv.indexOf("--idx") + 1]) : 0;
  const cfgFile =
    process.argv.includes("--cfg") ? process.argv[process.argv.indexOf("--cfg") + 1] : `../FXSS/FXSS_00${idx}.cfg`;
  const shop = await shopMain(resolveCfg(cfgFile), dbDir);
  RegisterCleanUp(() => shop.CleanUp());
}

if (!only || only === "util") {
  // FXUS_000.cfg: the util attaches to the center as server class 99; the
  // tool listener binds the literal 8128 (CListenThread::Proc's 0x1FC0).
  const cfgFile = process.argv.includes("--cfg")
    ? process.argv[process.argv.indexOf("--cfg") + 1]!
    : join(import.meta.dir, "..", "..", "FXUS", "FXUS_000.cfg");
  const util = await utilMain(resolveCfg(cfgFile));
  RegisterCleanUp(() => util.CleanUp());
}

if (!only || only === "login") {
  // The LS needs the center's address for its uplink; read it from the LS cfg.
  const login = await loginMain(
    join(import.meta.dir, "..", "..", "LS", "LS_000.cfg"),
    dbDir,
  );
  RegisterCleanUp(() => login.CleanUp());
}
