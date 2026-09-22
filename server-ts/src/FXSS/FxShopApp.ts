/** Native source unit: FX/FxShop/FxShopApp.cpp. */
import { CServerConfig, FXSHOP_STR_KEYS } from "../core/ServerConfig.ts";
import { PacketLog } from "../core/PacketLog.ts";
import { CDBMan } from "../db/DBMan.ts";
import { BILLING_PACKET_LOG_CONTEXT, PACKET_NAME_TABLES } from "../core/protocol/PacketIDs.ts";
import { CItemMan } from "./ItemMan.ts";
import { CLocalUserTable } from "./LocalUserTable.ts";
import { CMainPool } from "./MainPool.ts";
import { CTranxCtrl } from "./TranxCtrl.ts";
import { CBillingProcess } from "./BillingProcess.ts";
import { CCenterProcess } from "./CenterProcess.ts";
import { CMainSystem } from "./MainSystem.ts";
import { CTimerThread } from "./TimerThread.ts";
import { CListenThread } from "./ListenThread.ts";
import { CListenExThread } from "./ListenExThread.ts";

export interface FxShopAppOptions {
  readonly transactionLogDirectory?: string;
}

/** CFxShopApp — native owner of the FxShop setup sequence. */
export class CFxShopApp {
  static ms_pInstance: CFxShopApp | null = null;

  readonly db: CDBMan;
  readonly itemMan = new CItemMan();
  readonly mainPool: CMainPool;
  readonly userTable = new CLocalUserTable();
  readonly center: CCenterProcess;
  readonly billing: CBillingProcess;
  readonly tranxCtrl: CTranxCtrl;
  readonly mainSystem = new CMainSystem();
  readonly timerThread: CTimerThread;
  listenThread: CListenThread | null = null;
  listenExThread: CListenExThread | null = null;

  constructor(
    public readonly cfg: CServerConfig,
    dbDir: string,
    { transactionLogDirectory }: FxShopAppOptions = {},
  ) {
    CFxShopApp.ms_pInstance = this;
    this.db = new CDBMan(dbDir);
    this.tranxCtrl = transactionLogDirectory === undefined
      ? new CTranxCtrl()
      : new CTranxCtrl(transactionLogDirectory);
    this.mainPool = new CMainPool(this.db);
    this.center = new CCenterProcess(this.db);
    this.billing = new CBillingProcess(this.db);
    this.timerThread = new CTimerThread(this.mainPool, this.billing);
    this.mainPool.billingProcess = this.billing;
    CItemMan.ms_pInstance = this.itemMan;
  }

  /** CFxShopApp::SetUp — the boot order (minus the Windows plumbing). */
  async SetUp(): Promise<void> {
    // CDBMan::Init — the four key groups (the port maps every family onto the
    // same SQLite directory, mirroring the shipped one-DB-each topology).
    // DataBase Info File: DBInfo.inf = EncodePassword(id \r\n password).

    // CItemMan::Init
    if (this.itemMan.Init(this.db) === 0) throw new Error("! Item DB initialize failed");

    // CTranxCtrl::Init
    this.tranxCtrl.Init();

    // CCenterProcess::Init
    await this.center.Init(this.cfg);

    // CBillingProcess::Init
    // CBillingSocketTw ctor seeds GetWorld() (+252) from CServerConfig::GetServerIdx()
    this.billing.m_nSvrTag = this.cfg.GetServerIdx();
    await this.billing.Init();

    // InitChargeUrl / InitAuthUrl — ConfigDB prGetStringAttr @ChargeUrl/@AuthUrl
    this.mainSystem.m_strChargeUrl = this.db.prGetStringAttr("ChargeUrl").strVal;
    this.mainSystem.m_strAuthUrl = this.db.prGetStringAttr("AuthUrl").strVal;

    const port = this.cfg.GetNumAttribute("ServerPort");
    this.listenThread = new CListenThread(port, this.mainSystem);
    this.listenExThread = new CListenExThread(port + 1);
    this.listenThread.Start();
    this.listenExThread.Start();

    this.timerThread.Start();
  }

  /** CFxShopApp::CleanUp — active Bun resources in native termination order. */
  CleanUp(): void {
    this.listenThread?.Stop();
    this.listenExThread?.Stop();
    this.timerThread.Stop();
    this.billing.Stop();
    this.center.Stop();
    this.db.Close();
    this.listenThread = null;
    this.listenExThread = null;
    if (CFxShopApp.ms_pInstance === this) CFxShopApp.ms_pInstance = null;
  }
}

/** Port entry: Bun's event loop replaces the native blocking CApp::Run. */
export async function main(
  cfgPath: string,
  dbDir: string,
  options: FxShopAppOptions = {},
): Promise<CFxShopApp> {
  const cfg = new CServerConfig(FXSHOP_STR_KEYS);
  cfg.Init(cfgPath);
  CServerConfig.ms_pInstance = cfg;

  PacketLog.Configure("Shop");
  PacketLog.Register("Shop", "recv", ...PACKET_NAME_TABLES.Shop.recv);
  PacketLog.Register("Shop", "send", ...PACKET_NAME_TABLES.Shop.send);
  PacketLog.Register(BILLING_PACKET_LOG_CONTEXT.Taiwan, "recv", ...PACKET_NAME_TABLES.BILL.recv);
  PacketLog.Register(BILLING_PACKET_LOG_CONTEXT.Taiwan, "send", ...PACKET_NAME_TABLES.BILL.send);
  PacketLog.Register(BILLING_PACKET_LOG_CONTEXT.Billing, "send", ...PACKET_NAME_TABLES.BILLING.send);
  PacketLog.Register(BILLING_PACKET_LOG_CONTEXT.Coupon, "send", ...PACKET_NAME_TABLES.COUPON.send);

  const shop = new CFxShopApp(cfg, dbDir, options);
  try {
    await shop.SetUp();
    return shop;
  } catch (error) {
    shop.CleanUp();
    throw error;
  }
}
