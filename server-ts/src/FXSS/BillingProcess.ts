/** Native source unit: FX/FxShop/BillingProcess.cpp. */
import { CDBMan } from "../db/DBMan.ts";
import { CReceivedPacket, CSendPacket, CipherDegree } from "../core/Packet.ts";
import { ItemCategory } from "../common/Item.ts";
import {
  Shop2Billing_LegacyPacket,
  Shop2Billing_CouponPacket,
  Billing2Shop_TwPacket,
  Shop2Billing_TwPacket,
  S2C_ShopPacket,
} from "../core/protocol/PacketIDs.ts";
import type { ShopItem } from "./Recordsets.ts";
import { CSendPacket as CBillingSendPacket, DecodeBillingString } from "./Packet.ts";
import { EncodeCP950 } from "../core/Encoding.ts";
import { CBillingSocketTw } from "./BillingSocket.ts";
import { usesLocalBilling } from "../services/LocalBilling/Config.ts";
import { BillingReader, string8 } from "../services/LocalBilling/Protocol.ts";
import { BILLING_GAME, BILLING_ERROR, LOCAL_BILLING_RETRY_MS, RESERVATION_MS } from "../services/LocalBilling/Defs.ts";
import { CUser } from "./User.ts";
import { CItemMan } from "./ItemMan.ts";
import { CLocalUserTable } from "./LocalUserTable.ts";
import { CTranxCtrl } from "./TranxCtrl.ts";
import { CMainSystem } from "./MainSystem.ts";
import { EncodeVariantTime } from "../core/VariantTime.ts";

const BILLING_RECONNECT_TICKS = 0x28;
const BILLING_RTT_TICKS = 0x5dc;
const MAX_BILLING_CONNECT_ATTEMPTS = 10_000;

/** _BILLINGSVR — the CRSBillingSvr row. */
interface BILLINGSVR {
  SN: number;
  ip: string;
  port: number;
}

interface LocalPurchase {
  user: CUser;
  stock: number;
  request: CSendPacket;
  reference: string | null;
  lastSend: number;
  started: number;
}

/** CBillingProcess — the digicell billing link.  Loads the BillingSvr list
 *  from CAConfig, connects (retry every 0x28 timer ticks while down), and
 *  speaks the 3x0 Tw protocol.  With an empty BillingSvr table the process
 *  stays disconnected forever — exactly the original server's behavior with
 *  no billing configured. */
export class CBillingProcess {
  static ms_pInstance: CBillingProcess | null = null;

  m_aBillingSvr: BILLINGSVR[] = []; // this+12 (50 × 0x14)
  m_fConnected = 0; // this+1296 (dword 324)
  m_pSocket: CBillingSocketTw | null = null; // this+8
  m_nRetryCount = 0; // dword_498048
  m_fLocalBilling = false;
  private localPurchases = new Map<number, LocalPurchase>();

  constructor(public db: CDBMan) {
    CBillingProcess.ms_pInstance = this;
  }

  /** CBillingProcess::UpdateBillingSvrList — CRSBillingSvr ("BillingSvr"). */
  UpdateBillingSvrList(): void {
    this.m_aBillingSvr = this.db.GetBillingSvrs();
  }

  /** CBillingProcess::ConnectToSvr (FxShop.exe.c:505) — rotate the server
   *  list; every refused attempt reports, 10000 of them terminate. */
  m_nConnectAttempts = 0; // dword_498040

  async ConnectToSvr(): Promise<number> {
    if (this.m_aBillingSvr.length === 0) {
      console.log("[Shop] No billing server information!");
      return 0;
    }
    for (const svr of this.m_aBillingSvr) {
      const socket = new CBillingSocketTw(true, {
        onPacket: (_socket, packet) => this.OnPacket(packet),
      });
      socket.hooks.onClose = () => {
        console.error("[Shop] BillingSocket Connected closed... "); // :30937
        if (this.m_pSocket === socket) {
          this.m_pSocket = null;
          this.m_fConnected = 0;
        }
      };
      try {
        const conn = await Bun.connect({
          hostname: svr.ip,
          port: svr.port,
          socket: {
            open: (t) => {
              socket.bunSocket = t as Bun.Socket<any>;
              socket.m_bConnected = true;
            },
            data: (_t, data) => socket.OnReceive(new Uint8Array(data as Buffer)),
            drain: () => socket.Flush(),
            close: () => socket.Close(),
            error: () => socket.Close(),
          },
        });
        if (!socket.m_bConnected) continue;
        socket.bunSocket = conn;
        this.m_pSocket = socket;
        this.m_fConnected = 1;
        console.log("[Shop] Connection to Billing Server established"); // :521
        // CBillingProcess::ConnectToSvr — the 331 hello: [E4 4][E4 GetWorld()]
        const hello = new CBillingSendPacket(Shop2Billing_TwPacket.OnConnEstablished);
        hello.Encode4(BILLING_GAME);
        hello.Encode4(this.m_nSvrTag);
        this.Send(hello);
        return this.m_fConnected;
      } catch {
        console.log("[Shop] Connection to Billing Server failed."); // :513
        if (++this.m_nConnectAttempts > MAX_BILLING_CONNECT_ATTEMPTS) {
          console.error("[Shop] CMainSystem:TerminateProcess() called, ExitProcess();");
          process.exit(1);
        }
        continue;
      }
    }
    return 0;
  }

  /** CBillingProcess::Init */
  async Init(): Promise<void> {
    this.m_fLocalBilling = usesLocalBilling(this.db);
    this.UpdateBillingSvrList();
    if ((await this.ConnectToSvr()) !== 0) this.m_fConnected = 1;
  }

  /** CBillingProcess::OnTimer — `++tick % BILLING_RECONNECT_TICKS == 0 && !connected →
   *  ConnectToSvr()`; `% 0x5DC == 0 → TwRequestRTT()`. */
  async OnTimer(): Promise<void> {
    this.m_nRetryCount++;
    this.RetryLocalPurchases();
    if (this.m_nRetryCount % BILLING_RECONNECT_TICKS === 0 && this.m_fConnected === 0) {
      if ((await this.ConnectToSvr()) !== 0) this.m_fConnected = 1;
    }
    if (this.m_nRetryCount % BILLING_RTT_TICKS === 0) this.TwRequestRTT();
  }

  IsConnected(): number {
    return this.m_fConnected;
  }

  /** CBillingProcess::OnPacket (404DB0) — the billing ids are E4 payloads
   *  behind the dedicated 8-byte Tw frame. */
  OnPacket(n: CReceivedPacket): void {
    switch (n.Decode4()) {
      case Billing2Shop_TwPacket.OnRemainCashTw:
        this.OnRemainCashTw(n);
        break;
      case Billing2Shop_TwPacket.OnPurchaseOKTw:
        this.OnPurchaseOKTw(n);
        break;
      case Billing2Shop_TwPacket.OnPurchaseConfirmTw:
        this.OnPurchaseConfirmTw(n);
        break;
      case Billing2Shop_TwPacket.OnDigiQAuthen:
        this.OnDigiQAuthen(n);
        break;
      case Billing2Shop_TwPacket.OnTwRTT:
        console.log("[Shop] Received RTT Response");
        break;
      default:
        return;
    }
  }

  /** CBillingProcess::RequestRemainCashTw — billing 301 (4-byte opcode, raw degree):
   *  [E4 SID][E4 BID][E4 4][E4 GetWorld()][E1 len][name][E4 serial]
   *  [E1 len][client ip].  Requires the billing link (this+324) and the
   *  user's socket. */
  RequestRemainCashTw(user: CUser): void {
    if (this.m_fConnected === 0) return;
    if (!user.m_pSocket) return;
    const ip = user.m_pSocket.m_strPeerAddress;
    const name = user.GetName().split("\0", 1)[0]!;
    const p = new CBillingSendPacket(Shop2Billing_TwPacket.RequestRemainCashTw);
    p.Encode4(user.m_nSID);
    p.Encode4(user.m_nBID);
    p.Encode4(BILLING_GAME);
    p.Encode4(this.m_nSvrTag); // GetWorld()
    p.Encode1(name.length);
    p.EncodeBuffer(Buffer.from(name, "latin1"));
    p.Encode4(user.GetGlobalSerialNo());
    p.Encode1(ip.length);
    p.EncodeBuffer(Buffer.from(ip, "latin1"));
    this.Send(p);
  }

  m_nSvrTag = 0; // this+260 = CBillingSocketTw+252 — CBillingSocketTw::GetWorld()
  // (the ctor seeds it from CServerConfig::GetServerIdx()); set by CFxShopApp::SetUp

  /** CBillingProcess::RequestGift — billing 7:
   *  [E4 serial][E4 0][E4 0][E4 stockSN][E4 price][EStr clubId][EStr name]
   *  [E1 domain][E2 UA+128 HIWORD][EStr +2904 tranx string]. */
  RequestGift(user: CUser, _targetId: string, stockSN: number, price: number): void {
    const p = CBillingSendPacket.FromBillingPacket(Shop2Billing_LegacyPacket.RequestGift);
    p.Encode4(user.GetGlobalSerialNo());
    p.Encode4(0);
    p.Encode4(0);
    p.Encode4(stockSN);
    p.Encode4(price);
    p.EncodeStr(user.GetNexonClubId());
    p.EncodeStr(user.GetName());
    p.Encode1(CMainSystem.ms_pInstance!.m_nFXAttr & 0xff); // CMainSystem+4 GetDomain
    p.Encode2(user.m_nUserAccountHiword);
    p.EncodeStr(user.m_strTranxInfo);
    this.Send(p);
  }

  /** RequestCheckCoupon / RequestUseCoupon — billing 0/1, identical shape:
   *  [E4 serial][EStr +3008 coupon][EStr clubId][EStr name][E1 domain]
   *  [E2 UA+128 HIWORD]. */
  RequestCheckCoupon(user: CUser): void {
    const p = CBillingSendPacket.FromCouponPacket(Shop2Billing_CouponPacket.RequestCheckCoupon);
    this.EncodeCouponBody(p, user);
    this.Send(p);
  }

  RequestUseCoupon(user: CUser): void {
    const p = CBillingSendPacket.FromCouponPacket(Shop2Billing_CouponPacket.RequestUseCoupon);
    this.EncodeCouponBody(p, user);
    this.Send(p);
  }

  private EncodeCouponBody(p: CSendPacket, user: CUser): void {
    p.Encode4(user.GetGlobalSerialNo());
    p.EncodeStr(user.m_strCoupon);
    p.EncodeStr(user.GetNexonClubId());
    p.EncodeStr(user.GetName());
    p.Encode1(CMainSystem.ms_pInstance!.m_nFXAttr & 0xff); // CMainSystem+4 GetDomain
    p.Encode2(user.m_nUserAccountHiword);
  }

  /** CBillingProcess::RequestDigiQAuthorization — billing 341:
   *  [E1 len][Ebuf]×3 (three length-prefixed ANSI strings). */
  RequestDigiQAuthorization(account: string, password: string, name: string): void {
    const p = new CBillingSendPacket(Shop2Billing_TwPacket.RequestDigiQAuthorization);
    for (const s of [account, password, name]) {
      const buf = EncodeCP950(s);
      p.Encode1(buf.length);
      p.EncodeBuffer(buf);
    }
    if (!this.m_pSocket?.m_bConnected) {
      console.warn("[Shop] DigiQ authorization: billing link is unavailable; check CAConfig BillingSvr and connection logs.");
    }
    // Native still attempts PutPacket/Flush while disconnected. Never invent
    // an authorization result or log these credential-bearing strings here.
    this.Send(p);
  }

  /** CBillingProcess::RequestPurchaseTw — billing 311:
   *  [E4 SID][E4 BID][E4 4][E4 GetWorld()][E1 len][name][E4 price][E4 1]
   *  [E4 globalSerialNo][E4 stockSN][E4 1][E1 len][client ip]. */
  RequestPurchaseTw(user: CUser, item: ShopItem): void {
    if (!user.m_pSocket) return;
    if (this.m_fLocalBilling) {
      if (this.localPurchases.has(user.GetGlobalSerialNo())) {
        this.LocalPurchaseError(user, BILLING_ERROR.pending);
        return;
      }
      if (!this.IsConnected()) {
        this.LocalPurchaseError(user, BILLING_ERROR.unavailable);
        return;
      }
    }
    const ip = user.m_pSocket.m_strPeerAddress;
    const name = user.GetName().split("\0", 1)[0]!;
    const p = new CBillingSendPacket(Shop2Billing_TwPacket.RequestPurchaseTw);
    p.Encode4(user.m_nSID);
    p.Encode4(user.m_nBID);
    p.Encode4(BILLING_GAME);
    p.Encode4(this.m_nSvrTag);
    string8(p, name);
    p.Encode4(item.Price);
    p.Encode4(1);
    p.Encode4(user.GetGlobalSerialNo()); // 00402975..00402980: +3096 serial, NOT BID
    p.Encode4(item.SN);
    p.Encode4(1);
    string8(p, ip);
    if (this.m_fLocalBilling) {
      const now = Date.now();
      const purchase: LocalPurchase = { user, stock: item.SN, request: p, reference: null, lastSend: now, started: now };
      this.localPurchases.set(user.GetGlobalSerialNo(), purchase);
      user.m_pPurchaseTranx = purchase;
    }
    this.Send(p);
  }

  private LocalPurchaseError(user: CUser, message: string): void {
    if (user.m_fTranxInProgress !== 0) return;
    const isGift = user.m_strTranxInfo.length > 0 && user.m_strTranxInfo !== user.GetName();
    const errCode = isGift ? 5 : 1;
    const p = new CSendPacket(S2C_ShopPacket.OnPurchaseRes, CipherDegree.kPacketEncryptedCRC8);
    p.Encode1(errCode);
    p.EncodeStr(message);
    user.m_pSocket?.SendPacket(p);
    user.ResetTranxInfo();
  }

  private FinishLocalPurchase(serial: number): void {
    const purchase = this.localPurchases.get(serial);
    if (purchase) purchase.user.m_pPurchaseTranx = null;
    this.localPurchases.delete(serial);
  }

  private MakePurchaseConfirmTw(reference: string, serial: number, stock: number, result: number): CSendPacket {
    const p = new CBillingSendPacket(Shop2Billing_TwPacket.PurchaseConfirmTw);
    string8(p, reference); p.Encode4(serial); p.Encode4(stock); p.Encode4(result);
    return p;
  }

  /** Resend only the current phase. A lost 322 retries the SAME durable
   * reference, never a fresh debit. A pending confirmation has no guessed
   * failure timeout: storage may already have committed its inventory/points.
   */
  RetryLocalPurchases(): void {
    const now = Date.now();
    for (const [serial, purchase] of this.localPurchases) {
      if (purchase.reference === null && now - purchase.started > RESERVATION_MS) {
        this.LocalPurchaseError(purchase.user, BILLING_ERROR.expired);
        this.FinishLocalPurchase(serial);
      } else if (this.IsConnected() && now - purchase.lastSend >= LOCAL_BILLING_RETRY_MS) {
        purchase.lastSend = now;
        this.Send(purchase.request);
      }
    }
  }

  /** CBillingProcess::TwRequestRTT — billing 351: [E1 123]. */
  TwRequestRTT(): void {
    const p = new CBillingSendPacket(Shop2Billing_TwPacket.TwRequestRTT);
    p.Encode1(123);
    this.Send(p);
  }

  /** CBillingProcess::OnRemainCashTw (004039F0) — billing 302.
   * [E4 ignored][E1 length + name bytes][E4 serial][E4 cash][E4 result].
   * ONLY result 1 is an error, followed by an E1-length message; every
   * other result updates user+3104 and returns client 203 [E1 1][E4 cash].
   */
  OnRemainCashTw(n: CReceivedPacket): void {
    if (n.m_uLength - n.m_uOffset < 4) return;
    n.Decode4();
    if (DecodeBillingString(n) === null || n.m_uLength - n.m_uOffset < 12) return;
    const serial = n.Decode4();
    const cash = n.Decode4();
    const result = n.Decode4();
    const user = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(serial);
    if (!user || user.m_fTranxInProgress !== 0) return;
    const p = new CSendPacket(S2C_ShopPacket.OnRemainCashTw, CipherDegree.kPacketEncryptedCRC8);
    if (result === 1) {
      const message = DecodeBillingString(n);
      if (message === null) return;
      p.Encode1(0);
      p.EncodeStr(message);
    } else {
      user.SetCash(cash);
      p.Encode1(1);
      p.Encode4(cash);
    }
    user.m_pSocket?.SendPacket(p);
  }

  /** 00403C80: 312 [E4]x3 [E1 len + reference] [E4 serial,stock,result].
   * Local billing performs atomic delivery on 321, so Shop must NOT insert
   * a second inventory row here. External settlement remains unsupported and
   * is cancelled using the native orphan-user 321/result=2 path.
   */
  OnPurchaseOKTw(n: CReceivedPacket): void {
    const r = new BillingReader(n.m_pBlock.subarray(n.m_uOffset, n.m_uLength));
    try {
      r.u32(); r.u32(); r.u32();
      const reference = r.string(), serial = r.u32(), stock = r.u32(), result = r.u32();
      const message = result === 1 ? r.string() : "";
      r.end();
      const purchase = this.localPurchases.get(serial);
      if (!purchase || !this.m_fLocalBilling) {
        if (result === 0) this.Send(this.MakePurchaseConfirmTw(reference, serial, 0xffffffff, 2));
        if (!this.m_fLocalBilling) {
          const user = CLocalUserTable.ms_pInstance?.FindUserFromGlobalSerialNo(serial);
          if (user && user.m_fTranxInProgress === 0) this.LocalPurchaseError(user, result ? message : BILLING_ERROR.unsupported);
        }
        return;
      }
      if (purchase.stock !== stock) return;
      if (purchase.reference !== null) {
        if (reference === purchase.reference && result === 0) this.Send(purchase.request);
        return; // never let a late 312 failure overwrite a confirming purchase
      }
      if (result !== 0) {
        this.LocalPurchaseError(purchase.user, message);
        this.FinishLocalPurchase(serial);
        return;
      }
      if (!/^[a-f0-9]{32}$/.test(reference)) return;
      purchase.reference = reference;
      purchase.request = this.MakePurchaseConfirmTw(reference, serial, stock,
        purchase.user.m_pSocket && purchase.user.m_fTranxInProgress === 0 ? 0 : 2);
      purchase.lastSend = Date.now();
      this.Send(purchase.request);
    } catch {
      console.warn("[Shop] Invalid billing 312; purchase remains pending for retry.");
    }
  }

  /** Native 004048F4..004049CD: successful 322 receipt → durable TranxLog row → reset. */
  private RecordPurchaseTransaction(user: CUser, stockSN: number): void {
    const itemMan = CItemMan.ms_pInstance;
    if (itemMan !== null) {
      const parent = itemMan.GetShopItem(stockSN);
      if (parent !== null) {
        let itemSN = parent.ItemSN;
        let amount = parent.Unit;
        if (parent.Category === ItemCategory.Package) {
          for (const mapping of itemMan.GetPackageMapList(parent.SN)) {
            const child = itemMan.GetShopItem(mapping.StockSN);
            if (child === null) continue;
            itemSN = child.ItemSN;
            amount = mapping.Units * child.Unit;
          }
        }
        CTranxCtrl.ms_pInstance?.AddTranx({
          kind: Number(user.m_strTranxInfo.length !== 0),
          stockSN,
          itemSN,
          amount,
          price: parent.Price,
        });
      }
    }
    user.ResetTranxInfo();
  }

  /** 004047B0: 322 [E1 len + reference][E4 serial,result][error: string8]. */
  OnPurchaseConfirmTw(n: CReceivedPacket): void {
    const r = new BillingReader(n.m_pBlock.subarray(n.m_uOffset, n.m_uLength));
    try {
      const reference = r.string(), serial = r.u32(), result = r.u32();
      const message = result !== 0 ? r.string() : "";
      r.end();
      const purchase = this.localPurchases.get(serial);
      if (!this.m_fLocalBilling || !purchase || purchase.reference !== reference) return;
      if (result !== 0) this.LocalPurchaseError(purchase.user, message);
      else {
        const p = new CSendPacket(S2C_ShopPacket.OnPurchaseRes, CipherDegree.kPacketEncryptedCRC8);
        p.Encode1(0); p.EncodeBuffer(EncodeVariantTime(new Date()));
        if (purchase.user.m_fTranxInProgress === 0) {
          purchase.user.m_pSocket?.SendPacket(p);
          this.RecordPurchaseTransaction(purchase.user, purchase.stock);
        }
      }
      this.FinishLocalPurchase(serial);
    } catch {
      console.warn("[Shop] Invalid billing 322; purchase remains pending for retry.");
    }
  }

  /** CBillingProcess::OnDigiQAuthen (004044C0) — billing 342.
   * [E4 SID][E4 BID][E1 length + character name][E4 result].
   * Zero succeeds: client 209/12, then query cash using the EXISTING user
   * SID/BID (native does not assign the returned pair to the user).
   * Nonzero fails: client 209/13 with the following E1-length message.
   */
  OnDigiQAuthen(n: CReceivedPacket): void {
    if (n.m_uLength - n.m_uOffset < 8) return;
    const sid = n.Decode4();
    const bid = n.Decode4();
    const name = DecodeBillingString(n);
    if (name === null || n.m_uLength - n.m_uOffset < 4) return;
    const result = n.Decode4();
    const user = CLocalUserTable.ms_pInstance!.FindUser(name);
    if (!user || user.m_fTranxInProgress !== 0) return;
    const p = new CSendPacket(S2C_ShopPacket.OnDigiQAuthenRes, CipherDegree.kPacketEncryptedCRC8);
    if (result !== 0) {
      const message = DecodeBillingString(n);
      if (message === null) return;
      p.Encode1(13);
      p.EncodeStr(message);
      user.m_pSocket?.SendPacket(p);
    } else {
      p.Encode1(12);
      p.Encode4(sid);
      p.Encode4(bid);
      user.m_pSocket?.SendPacket(p);
      this.RequestRemainCashTw(user);
    }
  }

  /** the CBillingSocketTw IssueSend path (vtbl+108 PutPacket, vtbl+64 Flush). */
  Send(p: CSendPacket): void {
    this.m_pSocket?.SendPacket(p);
  }

  /** Port-side destruction of the owned billing transport and pending state. */
  Stop(): void {
    for (const purchase of this.localPurchases.values()) {
      purchase.user.m_pPurchaseTranx = null;
    }
    this.localPurchases.clear();
    if (this.m_pSocket !== null) {
      this.m_pSocket.hooks.onClose = () => {};
      this.m_pSocket.Close();
      this.m_pSocket = null;
    }
    this.m_fConnected = 0;
    if (CBillingProcess.ms_pInstance === this) CBillingProcess.ms_pInstance = null;
  }
}
