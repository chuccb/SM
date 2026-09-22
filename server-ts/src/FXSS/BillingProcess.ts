/** Native source unit: FX/FxShop/BillingProcess.cpp. */
import { CDBMan } from "../db/DBMan.ts";
import { CReceivedPacket, CSendPacket, CipherDegree } from "../core/Packet.ts";
import { ItemCategory, IsInventoryAddable } from "../common/Item.ts";
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
import { CCenterProcess } from "./CenterProcess.ts";
import { EncodeVariantTime } from "../core/VariantTime.ts";
import { SHOP_PERMANENT_EXPIRY_LEVEL, SHOP_PERMANENT_VALIDITY_DAYS, CART_RECEIPT_CODE, CART_RECEIPT_RESULT } from "./Defs.ts";
import { GetShopMainPool } from "./runtime/MainPoolRuntime.ts";

const BILLING_RECONNECT_TICKS = 0x28;
const BILLING_RTT_TICKS = 0x5dc;
const MAX_BILLING_CONNECT_ATTEMPTS = 10_000;

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

export class CBillingProcess {
  static ms_pInstance: CBillingProcess | null = null;

  m_aBillingSvr: BILLINGSVR[] = [];
  m_fConnected = 0;
  m_pSocket: CBillingSocketTw | null = null;
  m_nRetryCount = 0;
  m_fLocalBilling = false;
  private localPurchases = new Map<number, LocalPurchase>();

  constructor(public db: CDBMan) {
    CBillingProcess.ms_pInstance = this;
  }

  UpdateBillingSvrList(): void {
    this.m_aBillingSvr = this.db.GetBillingSvrs();
  }

  m_nConnectAttempts = 0;

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
        console.error("[Shop] BillingSocket Connected closed... ");
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
        console.log("[Shop] Connection to Billing Server established");
        const hello = new CBillingSendPacket(Shop2Billing_TwPacket.OnConnEstablished);
        hello.Encode4(BILLING_GAME);
        hello.Encode4(this.m_nSvrTag);
        this.Send(hello);
        return this.m_fConnected;
      } catch {
        console.log("[Shop] Connection to Billing Server failed.");
        if (++this.m_nConnectAttempts > MAX_BILLING_CONNECT_ATTEMPTS) {
          console.error("[Shop] CMainSystem:TerminateProcess() called, ExitProcess();");
          process.exit(1);
        }
        continue;
      }
    }
    return 0;
  }

  async Init(): Promise<void> {
    this.m_fLocalBilling = usesLocalBilling(this.db);
    this.UpdateBillingSvrList();
    if ((await this.ConnectToSvr()) !== 0) this.m_fConnected = 1;
  }

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

  RequestRemainCashTw(user: CUser): void {
    if (this.m_fConnected === 0) return;
    if (!user.m_pSocket) return;
    const ip = user.m_pSocket.m_strPeerAddress;
    const name = user.GetName().split("\0", 1)[0]!;
    const p = new CBillingSendPacket(Shop2Billing_TwPacket.RequestRemainCashTw);
    p.Encode4(user.m_nSID);
    p.Encode4(user.m_nBID);
    p.Encode4(BILLING_GAME);
    p.Encode4(this.m_nSvrTag);
    p.Encode1(name.length);
    p.EncodeBuffer(Buffer.from(name, "latin1"));
    p.Encode4(user.GetGlobalSerialNo());
    p.Encode1(ip.length);
    p.EncodeBuffer(Buffer.from(ip, "latin1"));
    this.Send(p);
  }

  m_nSvrTag = 0;

  RequestGift(user: CUser, _targetId: string, stockSN: number, price: number): void {
    const p = CBillingSendPacket.FromBillingPacket(Shop2Billing_LegacyPacket.RequestGift);
    p.Encode4(user.GetGlobalSerialNo());
    p.Encode4(0);
    p.Encode4(0);
    p.Encode4(stockSN);
    p.Encode4(price);
    p.EncodeStr(user.GetNexonClubId());
    p.EncodeStr(user.GetName());
    p.Encode1(CMainSystem.ms_pInstance!.m_nFXAttr & 0xff);
    p.Encode2(user.m_nUserAccountHiword);
    p.EncodeStr(user.m_strTranxInfo);
    this.Send(p);
  }

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
    p.Encode1(CMainSystem.ms_pInstance!.m_nFXAttr & 0xff);
    p.Encode2(user.m_nUserAccountHiword);
  }

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
    this.Send(p);
  }

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
    p.Encode4(user.GetGlobalSerialNo());
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
    const isGift = user.m_strTranxInfo.length > 0;
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

  TwRequestRTT(): void {
    const p = new CBillingSendPacket(Shop2Billing_TwPacket.TwRequestRTT);
    p.Encode1(123);
    this.Send(p);
  }

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

  OnPurchaseOKTw(n: CReceivedPacket): void {
    const r = new BillingReader(n.m_pBlock.subarray(n.m_uOffset, n.m_uLength));
    try {
      r.u32(); r.u32(); r.u32();
      const reference = r.string();
      const serial = r.u32();
      r.u32();
      const result = r.u32();
      const message = result === 1 ? r.string() : "";
      r.end();

      if (this.m_fLocalBilling) {
        const purchase = this.localPurchases.get(serial);
        if (!purchase) {
          if (result === 0) this.Send(this.MakePurchaseConfirmTw(reference, serial, 0xffffffff, 2));
          return;
        }
        if (purchase.reference !== null) {
          if (reference === purchase.reference && result === 0) this.Send(purchase.request);
          return;
        }
        if (result !== 0) {
          this.LocalPurchaseError(purchase.user, message);
          this.FinishLocalPurchase(serial);
          return;
        }
        if (!/^[a-f0-9]{32}$/.test(reference)) return;
        purchase.reference = reference;
        purchase.request = this.MakePurchaseConfirmTw(reference, serial, purchase.stock,
          purchase.user.m_pSocket && purchase.user.m_fTranxInProgress === 0 ? 0 : 2);
        purchase.lastSend = Date.now();
        this.Send(purchase.request);
        return;
      }

      const user = CLocalUserTable.ms_pInstance?.FindUserFromGlobalSerialNo(serial);
      if (!user || user.m_fTranxInProgress !== 0) {
        if (result === 0) this.Send(this.MakePurchaseConfirmTw(reference, serial, 0xffffffff, 2));
        return;
      }
      if (result !== 0) {
        const isGift = user.m_strTranxInfo.length > 0;
        const p = new CSendPacket(S2C_ShopPacket.OnPurchaseRes, CipherDegree.kPacketEncryptedCRC8);
        p.Encode1(isGift ? 5 : 1);
        p.EncodeStr(message);
        user.m_pSocket?.SendPacket(p);
        user.ResetTranxInfo();
        return;
      }
      const grantOk = this.GrantExternalPurchase(user);
      const confirmResult = grantOk ? 0 : 1;
      if (grantOk) {
        user.m_nTranxState = 1;
        user.m_nTranxResult = 1;
      } else {
        user.m_nTranxResult = 0;
      }
      this.Send(this.MakePurchaseConfirmTw(reference, serial, user.m_nTranxStockSN, confirmResult));
      if (!grantOk) {
        this.RollbackExternalGrant(user);
        user.ResetTranxInfo();
      }
    } catch {
      console.warn("[Shop] Invalid billing 312; purchase remains pending for retry.");
    }
  }

  private GrantExternalPurchase(user: CUser): boolean {
    const itemMan = CItemMan.ms_pInstance;
    if (!itemMan) return false;
    const parentSN = user.m_nTranxStockSN;
    const parent = itemMan.GetShopItem(parentSN);
    if (!parent) return false;
    const isGift = user.m_strTranxInfo.length > 0;
    const id = isGift ? user.m_strTranxInfo : user.GetName();
    if (isGift && this.db.prConfirmUnregisteredId(id) === 0) return false;

    const packageRows = parent.Category === ItemCategory.Package ? itemMan.GetPackageMapList(parent.SN) : [];
    const grants: { shopItem: ShopItem; units: number }[] = [];
    if (parent.Category === ItemCategory.Package) {
      for (const pkg of packageRows) {
        const child = itemMan.GetShopItem(pkg.StockSN);
        if (!child) return false;
        grants.push({ shopItem: child, units: pkg.Units * child.Unit });
      }
      if (grants.length === 0) return false;
    } else {
      grants.push({ shopItem: parent, units: parent.Unit });
    }

    const validityPeriod = parent.ValidityPeriod;
    const validityLevel = parent.ValidityLevel;
    const expiryDays = validityPeriod || SHOP_PERMANENT_VALIDITY_DAYS;
    const expiryLevel = validityLevel === 0 ? SHOP_PERMANENT_EXPIRY_LEVEL : (user.m_nLevel + validityLevel) | 0;

    let ok = true;
    for (const g of grants) {
      const child = g.shopItem;
      const units = g.units;
      user.m_nTranxItemSN = child.ItemSN;
      user.m_nTranxAmount = units;

      if (isGift) {
        const preSN = this.db.prAddPreInventory(id, 0, child.ItemSN, child.SN, units, validityPeriod, validityLevel, "", "");
        if (preSN < 0) { ok = false; break; }
        user.m_listTranxInfo.push({ ItemSN: child.ItemSN, Amount: units, PreInventorySN: preSN, IsNew: 0, ValidityPeriod: validityPeriod });
      } else {
        if (child.Category === ItemCategory.PremiumTicket) {
          const res = this.db.prSetPremiumTicket(id, validityPeriod);
          if (res === 0) { ok = false; break; }
          CCenterProcess.ms_pInstance?.SendAuthenCode(user.GetGlobalSerialNo(), 1);
          user.m_listTranxInfo.push({ ItemSN: child.ItemSN, Amount: units, PreInventorySN: 0, IsNew: 1, ValidityPeriod: validityPeriod });
        } else {
          const addable = IsInventoryAddable(child.Category);
          const res = this.db.prAddInventoryShop(id, child.ItemSN, child.SN, units, expiryDays, expiryLevel, addable);
          if (res === 0) { ok = false; break; }
          user.m_listTranxInfo.push({ ItemSN: child.ItemSN, Amount: units, PreInventorySN: 0, IsNew: res, ValidityPeriod: validityPeriod });
        }
      }
    }
    return ok;
  }

  private RollbackExternalGrant(user: CUser): void {
    const isGift = user.m_strTranxInfo.length > 0;
    const id = isGift ? user.m_strTranxInfo : user.GetName();
    for (const entry of user.m_listTranxInfo) {
      if (isGift) {
        try {
          const shard = this.db.GetUserHashNo(id);
          (this.db as unknown as { inventory: { [k: number]: { query: (s: string) => { run: (...a: unknown[]) => unknown } } } }).inventory[shard]?.query("DELETE FROM FxPreInventory WHERE SN = ?").run(entry.PreInventorySN);
        } catch {}
      } else {
        const itemMan = CItemMan.ms_pInstance;
        const ui = itemMan?.GetUserItem(entry.ItemSN);
        if (ui && ui.Category === ItemCategory.PremiumTicket) {
          try {
            this.db.prSetPremiumTicket(id, 0);
            CCenterProcess.ms_pInstance?.SendAuthenCode(user.GetGlobalSerialNo(), 0);
          } catch {}
        } else if (entry.IsNew === 2) {
          try { this.db.prUpdateInventoryAmountDelta(id, entry.ItemSN, -entry.Amount); } catch {}
        } else {
          try { this.db.prDeleteInventory(id, entry.ItemSN); } catch {}
        }
      }
    }
    user.m_listTranxInfo = [];
  }

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

  OnPurchaseConfirmTw(n: CReceivedPacket): void {
    const r = new BillingReader(n.m_pBlock.subarray(n.m_uOffset, n.m_uLength));
    try {
      const reference = r.string(), serial = r.u32(), result = r.u32();
      const message = result !== 0 ? r.string() : "";
      r.end();

      if (this.m_fLocalBilling) {
        const purchase = this.localPurchases.get(serial);
        if (!purchase || purchase.reference !== reference) return;
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
        return;
      }

      const user = CLocalUserTable.ms_pInstance?.FindUserFromGlobalSerialNo(serial);
      if (!user || user.m_fTranxInProgress !== 0) return;
      if (result !== 0) {
        if (user.m_nTranxStockSN !== 0) this.RollbackExternalGrant(user);
        const isGift = user.m_strTranxInfo.length > 0;
        const p = new CSendPacket(S2C_ShopPacket.OnPurchaseRes, CipherDegree.kPacketEncryptedCRC8);
        p.Encode1(isGift ? 5 : 1);
        p.EncodeStr(message);
        user.m_pSocket?.SendPacket(p);
        user.ResetTranxInfo();
        return;
      }

      const isCart = user.m_fCartProcessing !== 0;
      if (!isCart) {
        const p = new CSendPacket(S2C_ShopPacket.OnPurchaseRes, CipherDegree.kPacketEncryptedCRC8);
        p.Encode1(0);
        p.EncodeBuffer(EncodeVariantTime(new Date()));
        user.m_pSocket?.SendPacket(p);
      }
      const itemMan = CItemMan.ms_pInstance;
      if (itemMan) {
        const parent = itemMan.GetShopItem(user.m_nTranxStockSN);
        if (parent) {
          let itemSN = parent.ItemSN;
          let amount = parent.Unit;
          if (parent.Category === ItemCategory.Package) {
            for (const mapping of itemMan.GetPackageMapList(parent.SN)) {
              const child = itemMan.GetShopItem(mapping.StockSN);
              if (!child) continue;
              itemSN = child.ItemSN;
              amount = mapping.Units * child.Unit;
            }
          }
          CTranxCtrl.ms_pInstance?.AddTranx({
            kind: Number(user.m_strTranxInfo.length !== 0),
            stockSN: user.m_nTranxStockSN,
            itemSN,
            amount,
            price: parent.Price,
          });
        }
      }
      user.ResetTranxInfo();

      if (isCart) {
        const pool = GetShopMainPool() as unknown as { PurchaseCartList?: (u: CUser) => void; m_fCartProcessing?: number } | null;
        const purchaseCartList = (pool as { PurchaseCartList?: (u: CUser) => void } | null)?.PurchaseCartList;
        if (typeof purchaseCartList === "function") {
          const idx = user.m_nCartCount;
          const entry = user.m_anCart[idx];
          if (entry) {
            if (entry.cnt <= 0) user.m_nCartCount--;
            if (user.m_nCartCount < 0) {
              user.m_fCartProcessing = 0;
              if (user.m_pSocket) {
                const p215 = new CSendPacket(S2C_ShopPacket.OnPurchaseCartListRes, CipherDegree.kPacketEncryptedCRC8);
                p215.Encode1(CART_RECEIPT_CODE);
                p215.Encode1(CART_RECEIPT_RESULT);
                p215.EncodeBuffer(EncodeVariantTime(new Date()));
                user.m_pSocket.SendPacket(p215);
              }
              user.ResetTranxInfo();
            } else {
              const next = user.m_anCart[user.m_nCartCount];
              if (next) next.cnt = (next.cnt - 1) | 0;
              purchaseCartList.call(pool, user);
            }
          } else {
            user.m_fCartProcessing = 0;
          }
        } else {
          user.m_fCartProcessing = 0;
        }
      }
    } catch {
      console.warn("[Shop] Invalid billing 322; purchase remains pending for retry.");
    }
  }

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

  Send(p: CSendPacket): void {
    this.m_pSocket?.SendPacket(p);
  }

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
