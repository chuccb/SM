import { dirname, resolve } from "node:path";
import { CServerConfig, type ServerConfig } from "./Common/CServerConfig.ts";
import { CTextCodec } from "./Common/CTextCodec.ts";
import { CDBSession } from "./Common/DB/CDBSession.ts";
import { CFastFile } from "./Common/CFastFile.ts";
import { CItemAttr } from "./FXGS/CItemAttr.ts";
import { CBomberAttr } from "./FXGS/CBomberAttr.ts";
import { CGameMapTmplList } from "./FXGS/CGameMapTmplList.ts";
import { CMapObjToTileInfo } from "./FXGS/CMapObjToTileInfo.ts";
import { CCenterServer } from "./Center/CCenterServer.ts";
import { CLoginServerApp } from "./LS/CLoginServerApp.ts";
import { CFxServerApp } from "./FXGS/CFxServerApp.ts";
import { MTUDPServer } from "./Relay/MTUDPServer.ts";
import type { Server } from "bun";
import { RuntimePolicy } from "./Common/RuntimePolicy.ts";

export const UnportedFeatures = [
  "Center TCP registration/negotiation",
  "waiting-chief recovery/remaining battle events/special-mode launch/result restart recovery",
  "full GS MTUDP host/queue/clock synchronization",
  "practice/ladder/mission/guild",
  "native pre-inventory durable effects/billing and whole-group207 handoff; SQL-backed equipment loading",
  "native owned-inventory SQL persistence/CTime calendar adapter; inventory flush/collector",
  "FXSS stock/pricing/billing/transactions",
  "FXUS account utility",
  "SQL Server backup restoration",
] as const;
/** All-in-one Bun deployment glue. This is intentionally named separately from
 * each service's original CMainSystem; it is NOT a claim of process/wire parity. */
export class CServerApp {
  readonly m_dbSession: CDBSession;
  readonly m_center: CCenterServer;
  readonly m_loginServer: CLoginServerApp;
  readonly m_gameServers: CFxServerApp[];
  readonly m_udpServer: MTUDPServer;
  readonly m_gameMapTmplList = new CGameMapTmplList();
  readonly m_bomberAttr = new CBomberAttr();
  readonly m_itemAttr = new CItemAttr();
  readonly m_mapObjToTileInfo = new CMapObjToTileInfo();
  private readonly sqliteVersion: string;
  private m_http: Server<undefined> | undefined;
  private maintenance: ReturnType<typeof setInterval> | undefined;
  private ready = false;
  private centerMaintenanceFailures = 0;
  private cleanup: Promise<void> | undefined;
  private started = false;
  constructor(readonly config: ServerConfig = CServerConfig.Load()) {
    const text = new CTextCodec(config.Runtime.Encoding);
    const files = new CFastFile();
    files.FastFileInit(config.Runtime.Resources);
    this.m_bomberAttr.Load(files);
    this.m_itemAttr.Load(files);
    this.m_itemAttr.LoadAirplaneItemInfo(
      resolve(dirname(config.Runtime.Resources), "iteminfo.txt"),
    );
    this.m_gameMapTmplList.CreateTmplList(files);
    this.m_mapObjToTileInfo.Load(files);
    this.m_dbSession = new CDBSession(config.Runtime.Database);
    try {
      this.m_dbSession.IntegrityCheck();
      this.sqliteVersion = this.m_dbSession.db
        .query<{ version: string }, []>("SELECT sqlite_version() AS version")
        .get()!.version;
      this.m_center = new CCenterServer(config);
      this.m_loginServer = new CLoginServerApp(
        config,
        this.m_center,
        this.m_dbSession,
        text,
      );
      this.m_gameServers = config.FXGS.Channels.map(
        (c) =>
          new CFxServerApp(
            config,
            c,
            this.m_center,
            this.m_dbSession,
            text,
            this.m_bomberAttr,
            this.m_gameMapTmplList,
            this.m_itemAttr,
          ),
      );
      this.m_udpServer = new MTUDPServer(this.m_center);
    } catch (error) {
      this.m_dbSession.Close();
      throw error;
    }
  }
  get healthPort(): number {
    return this.m_http?.port ?? 0;
  }
  GetStatus() {
    return {
      processReady: this.ready,
      completeOfficialRewrite: false,
      officialClientVerified: false,
      runtime: { bun: Bun.version, sqlite: this.sqliteVersion },
      centerTransport: "in-process",
      centerMaintenanceFailures: this.centerMaintenanceFailures,
      gameUpdate: this.m_gameServers.map((game) => ({
        channel: game.channel.Index,
        running: game.m_timerThreadNormal.IsRunning(),
        scope: "ordinary-loading-running-result",
        launchEnabled: this.config.FXGS.UDPEnabled,
        loadingRooms: game.m_gameSessionTable.GetLoadingSessionCount(),
        scheduledRounds: game.m_gameSessionTable.GetScheduledRoundCount(),
        pendingResults: game.m_gameSessionTable.GetPendingResultCount(),
        pendingHouseClaims: game.m_gameSessionTable.GetPendingHouseClaimCount(),
        pendingSpecialItemUses:
          game.m_gameSessionTable.GetPendingSpecialItemUseCount(),
        pendingMoneyPickups:
          game.m_gameSessionTable.GetPendingMoneyPickupCount(),
        failedRooms: game.m_gameSessionTable.GetUpdateFailures().length,
        failedTicks: game.m_timerThreadNormal.GetFailedTickCount(),
        removalPublicationFailures:
          game.m_gameSessionTable.GetRemovalPublicationFailures(),
      })),
      users: this.m_center.m_globalUserTable.GetUserCount(),
      listeners: [
        { service: "LS", port: this.m_loginServer.m_listenSocket.port },
        ...this.m_gameServers.map((s) => ({
          service: `FXGS-${s.channel.Index}`,
          port: s.m_listenSocket.port,
        })),
        ...(this.config.FXGS.UDPEnabled
          ? this.m_gameServers.map((s) => ({
              service: `FXGS-${s.channel.Index} discovery UDP`,
              port: s.m_udpServer.port,
            }))
          : []),
        ...(this.config.Relay.Enabled
          ? [{ service: "Relay UDP", port: this.m_udpServer.port }]
          : []),
        ...(this.m_http
          ? [{ service: "Health HTTP", port: this.healthPort }]
          : []),
      ],
      resources: {
        maps: this.m_gameMapTmplList.GetMapCount(),
        themes: this.m_gameMapTmplList.m_aThemeInfo.length,
        bombers: this.m_bomberAttr.GetTotalCount(),
        gameItems: this.m_itemAttr.GetItemCount(),
        ships: this.m_itemAttr.m_aShipAttr.length,
        tiles: this.m_mapObjToTileInfo.GetCount(),
      },
      unported: UnportedFeatures,
    };
  }
  async SetUp(): Promise<void> {
    if (this.started || this.cleanup)
      throw new Error("Server app cannot be started twice");
    this.started = true;
    try {
      for (const game of this.m_gameServers) await game.SetUp();
      await this.m_loginServer.SetUp();
      if (this.config.Relay.Enabled)
        await this.m_udpServer.Startup(
          this.config.Runtime.Host,
          this.config.Relay.Port,
        );
      this.maintenance = setInterval(
        () => this.MaintainCenter(),
        RuntimePolicy.MaintenanceIntervalMs,
      );
      this.maintenance.unref();
      if (this.config.Runtime.HealthPort)
        this.m_http = Bun.serve<undefined>({
          hostname: this.config.Runtime.Host,
          port: this.config.Runtime.HealthPort,
          fetch: (request) => {
            const path = new URL(request.url).pathname;
            const headers = {
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            };
            if (request.method !== "GET" && request.method !== "HEAD")
              return new Response("Method not allowed", {
                status: 405,
                headers: { ...headers, Allow: "GET, HEAD" },
              });
            if (path === "/healthz" || path === "/readyz")
              return Response.json(this.GetStatus(), {
                status: path === "/readyz" && !this.ready ? 503 : 200,
                headers,
              });
            if (path === "/")
              return new Response(StatusHTML, {
                headers: {
                  ...headers,
                  "Content-Type": "text/html; charset=utf-8",
                  "Content-Security-Policy":
                    "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; object-src 'none'",
                },
              });
            return new Response("Not found", { status: 404, headers });
          },
        });
      this.ready = true;
    } catch (error) {
      await this.CleanUp();
      throw error;
    }
  }
  /** Modern timer isolation. Bad clock cancels pending authority in Center;
   * a maintenance exception is not an uncaught process-exit or hidden success. */
  private MaintainCenter(): void {
    try {
      this.m_center.ExpireConnections();
    } catch {
      this.centerMaintenanceFailures++;
      console.warn(JSON.stringify({ event: "center-maintenance-rejected" }));
    }
  }
  CleanUp(): Promise<void> {
    return (this.cleanup ??= (async () => {
      this.ready = false;
      if (this.maintenance) clearInterval(this.maintenance);
      await this.m_http?.stop(true);
      this.m_http = undefined;
      await this.m_loginServer.CleanUp();
      await Promise.all(this.m_gameServers.map((s) => s.CleanUp()));
      await this.m_udpServer.Cleanup();
      for (const user of this.m_center.m_globalUserTable.Values())
        this.m_center.m_globalUserTable.DeleteUser(user);
      this.m_dbSession.Close();
    })());
  }
}

const StatusHTML = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Crazy Arcade · 移植狀態</title>
<style>body{background:#101622;color:#dbe4f5;font:16px/1.65 system-ui,sans-serif;max-width:920px;margin:5vh auto;padding:24px}h1{letter-spacing:-1px}small{color:#91a5c5}.warning{border-left:4px solid #ffbb57;background:#2d241b;padding:16px 22px;border-radius:4px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#171f2d;padding:22px;border-radius:10px;font-size:13px}a{color:#81b8ff}</style>
<small>SM / TypeScript + Bun + SQLite</small><h1>Crazy Arcade 伺服器移植狀態</h1><div class="warning"><strong>目前是未完成的移植版本，不是完整官方相容伺服器。</strong><br>已接通登入、轉服及一般開局／SQLite結算／回準備；完整戰鬥事件、商城交易、公會與 Util 尚未完成。HTTP 預覽不提供原版客戶端需要的 TCP/UDP 通道。</div><p>以下為實際行程的唯讀狀態，不含帳號、密碼或管理操作。<a href="/healthz">JSON</a></p><pre id="status">讀取狀態…</pre><script>async function refresh(){try{const r=await fetch('/healthz');document.getElementById('status').textContent=JSON.stringify(await r.json(),null,2)}catch{document.getElementById('status').textContent='行程無法連線'}}refresh();setInterval(refresh,5000)</script></html>`;
