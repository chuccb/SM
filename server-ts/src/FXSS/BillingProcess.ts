/** Native source unit: FX/FxShop/BillingProcess.cpp. */
import { CDBMan } from "../db/DBMan.ts";
import { CReceivedPacket, CSendPacket } from "../core/Packet.ts";
import { ItemCategory, IsInventoryAddable } from "../common/Item.ts";
import {
  Shop2Billing_LegacyPacket,
  Shop2Billing_CouponPacket,
  Billing2Shop_TwPacket,
  Shop2Billing_TwPacket,
  S2C_ShopPacket,
} from "../core/protocol/PacketIDs.ts";
import { CouponMap, type ShopItem } from "./Recordsets.ts";
import { CSendPacket as CBillingSendPacket, DecodeBillingString } from "./Packet.ts";
import { EncodeCP950 } from "../core/Encoding.ts";
import { CBillingSocketTw } from "./BillingSocket.ts";
import { usesLocalBilling } from "../services/LocalBilling/Config.ts";
import { BillingReader, string8 } from "../services/LocalBilling/Protocol.ts";
import { BILLING_ERROR, LOCAL_BILLING_RETRY_MS, RESERVATION_MS } from "../services/LocalBilling/Defs.ts";
import { CUser } from "./User.ts";
import { CItemMan } from "./ItemMan.ts";
import { CLocalUserTable } from "./LocalUserTable.ts";
import { CTranxCtrl } from "./TranxCtrl.ts";
import { CMainSystem } from "./MainSystem.ts";
import { CCenterProcess } from "./CenterProcess.ts";
import { EncodeVariantTime } from "../core/VariantTime.ts";
import {
  SHOP_PERMANENT_EXPIRY_LEVEL,
  SHOP_PERMANENT_VALIDITY_DAYS,
  PURCHASE_RESULT,
  PURCHASE_CONFIRM,
  BILLING_ORPHAN_STOCK,
  PRESENT_PREINVENTORY_TYPE,
  COUPON_PREINVENTORY_TYPE,
  COUPON_STOCK_SN,
  COUPON_BILLING_SUCCESS,
  COUPON_BILLING_SUCCESS_ALT,
  COUPON_RESULT,
  GIFT_LIMIT_RESULT,
  BILLING_GAME,
  BILLING_CONNECT_SLEEP_MS,
  BILLING_TERMINATE_THRESHOLD,
  BILLING_RECONNECT_TICKS,
  BILLING_RTT_TICKS,
} from "./Defs.ts";

interface BILLINGSVR {
  SN: number;
  ip: string;
  port: number;
}

/** CDBMan::AddNewInventory(char const *) maps prAddInventory's 10 to 2 (00408C93). */
const INVENTORY_GRANT_STACKED = 2;

interface ExternalGrant {
  ok: boolean;
  /** TranxResult after a refused grant. Only a failed non-premium gift stores its negative proc code. */
  result: number;
}

function granted(): ExternalGrant {
  return { ok: true, result: 0 };
}

function refused(result = 0): ExternalGrant {
  return { ok: false, result };
}

function expiryDays(period: number): number {
  return period === 0 ? SHOP_PERMANENT_VALIDITY_DAYS : period;
}

function selfExpiryLevel(level: number, userLevel: number): number {
  return level === 0 ? SHOP_PERMANENT_EXPIRY_LEVEL : (userLevel + level) | 0;
}

function giftExpiryLevel(level: number): number {
  return level === 0 ? SHOP_PERMANENT_EXPIRY_LEVEL : level;
}

interface LocalPurchase {
  user: CUser;
  stock: number;
  request: CSendPacket;
  reference: string | null;
  lastSend: number;
  started: number;
}

/** char const* construction used by RequestGift's EncodeStr temporaries. */
function cString(text: string): string {
  const end = text.indexOf("\0");
  return end < 0 ? text : text.slice(0, end);
}

function copyCouponMap(entry: CouponMap): CouponMap {
  const copy = new CouponMap();
  copy.CouponSN = entry.CouponSN;
  copy.ItemSN = entry.ItemSN;
  copy.Units = entry.Units;
  copy.ValidityPeriod = entry.ValidityPeriod;
  copy.Validitylevel = entry.Validitylevel;
  return copy;
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

  /** dword_498040 — billing server cursor / attempt counter, seeded from ServerIndex (+5). */
  m_nBillingSvrCursor = -1;
  m_nConnectAttempts = 0;

  async ConnectToSvr(): Promise<number> {
    // First call seeds cursor from ServerIndex, matching native dword_498040 init (FxShop.exe.c:479)
    if (this.m_nBillingSvrCursor === -1) {
      this.m_nBillingSvrCursor = this.m_nSvrTag;
      this.m_nConnectAttempts = this.m_nSvrTag;
    }
    if (this.m_aBillingSvr.length === 0) {
      console.log("[Shop] No billing server information!");
      return 0;
    }
    // Native loops forever until success or >10000 attempts, picking server at cursor % count,
    // sleeping 0x3E8 ms between failures (FxShop.exe.c:514), terminating at >10000.
    while (true) {
      const count = this.m_aBillingSvr.length;
      if (count === 0) {
        console.log("[Shop] No billing server information!");
        return 0;
      }
      const idx = ((this.m_nBillingSvrCursor % count) + count) % count;
      const svr = this.m_aBillingSvr[idx]!;
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
        if (socket.m_bConnected) {
          socket.bunSocket = conn;
          this.m_pSocket = socket;
          this.m_fConnected = 1;
          console.log("[Shop] Connection to Billing Server established");
          const hello = new CBillingSendPacket(Shop2Billing_TwPacket.OnConnEstablished);
          hello.Encode4(BILLING_GAME);
          hello.Encode4(this.m_nSvrTag);
          this.Send(hello);
          return this.m_fConnected;
        }
      } catch {
        // fall through to failure path
      }
      console.log("[Shop] Connection to Billing Server failed.");
      await Bun.sleep(BILLING_CONNECT_SLEEP_MS);
      this.m_nBillingSvrCursor++;
      this.m_nConnectAttempts++;
      if (this.m_nBillingSvrCursor > BILLING_TERMINATE_THRESHOLD || this.m_nConnectAttempts > BILLING_TERMINATE_THRESHOLD) {
        console.error("[Shop] CMainSystem:TerminateProcess() called, ExitProcess();");
        process.exit(1);
      }
    }
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
    // Billing link uses Tw framing for both families. After Tw header decode,
    // the payload is either:
    //   Tw: [E4 outer opcode 302/312/322/342/352][body...]
    //   Legacy: [E1 family 0/1][E1 opcode 6/7/8 or 0/1][body...]
    // Tw opcodes are big-endian DWORDs 302 etc, whose first byte is 0, so
    // checking first byte alone is insufficient. We first peek the DWORD;
    // if it matches a known Tw outer, dispatch as Tw, otherwise try legacy.
    const savedOffset = n.m_uOffset;
    if (n.m_uLength - n.m_uOffset >= 4) {
      const outerPeek = n.Decode4At(n.m_uOffset);
      switch (outerPeek) {
        case Billing2Shop_TwPacket.OnRemainCashTw:
        case Billing2Shop_TwPacket.OnPurchaseOKTw:
        case Billing2Shop_TwPacket.OnPurchaseConfirmTw:
        case Billing2Shop_TwPacket.OnDigiQAuthen:
        case Billing2Shop_TwPacket.OnTwRTT: {
          const outer = n.Decode4();
          switch (outer) {
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
          return;
        }
        default:
          break;
      }
    }
    // Legacy family framing: [E1 family][E1 opcode]
    if (n.m_uLength - n.m_uOffset >= 2) {
      const family = n.m_pBlock[n.m_uOffset]!;
      const opcode = n.m_pBlock[n.m_uOffset + 1]!;
      if (family === 1 && (opcode === 0 || opcode === 1)) {
        n.m_uOffset += 2;
        if (opcode === 0) this.OnCheckCoupon(n);
        else this.OnUseCoupon(n);
        return;
      }
      if (family === 0 && (opcode === 6 || opcode === 7 || opcode === 8)) {
        n.m_uOffset += 2;
        if (opcode === 6) this.OnGiftLimitOver(n);
        else if (opcode === 7) this.OnGiftUnderAge(n);
        else this.OnNotReady(n);
        return;
      }
      // Unknown family 0/1 opcodes are legacy and intentionally ignored
      // (matches native default return in OnPacket).
      if (family === 0 || family === 1) return;
    }
    n.m_uOffset = savedOffset;
  }

  /** CBillingProcess::OnGiftLimitOver (004017E0) — legacy billing gift cap.
   *  [E4 serial][E4 extra] → client 204 [E1 6][E1 0] + ResetTranxInfo. */
  OnGiftLimitOver(n: CReceivedPacket): void {
    if (n.m_uLength - n.m_uOffset < 8) return;
    const serial = n.Decode4();
    n.Decode4(); // extra dword ignored
    const user = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(serial);
    if (!user || user.m_fTranxInProgress !== 0) return;
    const p = new CSendPacket(S2C_ShopPacket.OnPurchaseRes);
    p.Encode1(PURCHASE_RESULT.GiftLimitOver);
    p.Encode1(0);
    user.m_pSocket?.SendPacket(p);
    user.ResetTranxInfo();
  }

  /** CBillingProcess::OnGiftUnderAge (004018B0) — one Decode4, then 204 code 7. */
  OnGiftUnderAge(n: CReceivedPacket): void {
    if (n.m_uLength - n.m_uOffset < 4) return;
    const serial = n.Decode4();
    const user = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(serial);
    if (!user || user.m_fTranxInProgress !== 0) return;
    const p = new CSendPacket(S2C_ShopPacket.OnPurchaseRes);
    p.Encode1(PURCHASE_RESULT.GiftUnderAge);
    user.m_pSocket?.SendPacket(p);
    user.ResetTranxInfo();
  }

  /** CBillingProcess::OnNotReady (00401970) — one Decode4, then 204 code 8. */
  OnNotReady(n: CReceivedPacket): void {
    if (n.m_uLength - n.m_uOffset < 4) return;
    const serial = n.Decode4();
    const user = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(serial);
    if (!user || user.m_fTranxInProgress !== 0) return;
    const p = new CSendPacket(S2C_ShopPacket.OnPurchaseRes);
    p.Encode1(PURCHASE_RESULT.NotReady);
    user.m_pSocket?.SendPacket(p);
    user.ResetTranxInfo();
  }

  /** CBillingProcess::OnCheckCoupon (00403150) — family 1 opcode 0.
   *  [E4 serial][E1 result][E4 couponSN]. Result 0/3 continues; any other
   *  result, or an empty coupon string, sends that result byte and resets.
   *  The catalog is appended to the user's list. A still-empty list, or no
   *  counted grant, sends 208 code 8. Experience is applied but does not
   *  count. A counted grant chains RequestUseCoupon and sends no 208. */
  OnCheckCoupon(n: CReceivedPacket): void {
    if (n.m_uLength - n.m_uOffset < 9) return;
    const serial = n.Decode4();
    const result = n.Decode1();
    const couponSN = n.Decode4();
    const user = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(serial);
    if (!user || user.m_fTranxInProgress !== 0) return;

    const accepted = result === COUPON_BILLING_SUCCESS || result === COUPON_BILLING_SUCCESS_ALT;
    if (!accepted || user.m_strCoupon.length === 0) {
      this.sendCouponCode(user, result);
      return;
    }

    user.m_nCouponID = couponSN | 0;
    const itemMan = CItemMan.ms_pInstance;
    if (!itemMan) {
      this.sendCouponCode(user, COUPON_RESULT.BillingFailure);
      return;
    }
    for (const entry of itemMan.GetCouponMapList(user.m_nCouponID)) {
      user.m_listCouponMap.push(copyCouponMap(entry));
    }
    if (user.m_listCouponMap.length === 0) {
      this.sendCouponCode(user, COUPON_RESULT.BillingFailure);
      return;
    }

    let granted = false;
    for (const entry of user.m_listCouponMap) {
      if (this.grantCouponMapEntry(user, itemMan, entry)) granted = true;
    }
    if (granted) {
      this.RequestUseCoupon(user);
      return;
    }
    this.sendCouponCode(user, COUPON_RESULT.BillingFailure);
  }

  /** CBillingProcess::OnUseCoupon (00403440) — family 1 opcode 1.
   *  [E4 serial][E1 result][E4 ignored]. Success is result 0/3 and a coupon
   *  id above 0. The count is the stored list size, including entries whose
   *  UserItem is missing; only entries with a UserItem are encoded. */
  OnUseCoupon(n: CReceivedPacket): void {
    if (n.m_uLength - n.m_uOffset < 9) return;
    const serial = n.Decode4();
    const result = n.Decode1();
    n.Decode4();
    const user = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(serial);
    if (!user || user.m_fTranxInProgress !== 0) return;

    const accepted = result === COUPON_BILLING_SUCCESS || result === COUPON_BILLING_SUCCESS_ALT;
    if (!accepted || user.m_nCouponID <= 0) {
      this.sendCouponCode(user, result);
      return;
    }

    const itemMan = CItemMan.ms_pInstance;
    const packet = new CSendPacket(S2C_ShopPacket.OnUseCouponRes);
    packet.Encode1(COUPON_RESULT.Success);
    packet.Encode4(user.m_listCouponMap.length);
    for (const entry of user.m_listCouponMap) {
      const userItem = itemMan?.GetUserItem(entry.ItemSN);
      if (!userItem) continue;
      packet.Encode4(entry.ItemSN);
      packet.Encode4(entry.Units);
      packet.Encode4(entry.ValidityPeriod);
      packet.Encode4(userItem.Category === ItemCategory.Experience ? user.m_nLevel : entry.Validitylevel);
    }
    user.m_pSocket?.SendPacket(packet);
    user.ResetTranxInfo();
  }

  /** 208 plus ResetTranxInfo. A missing client socket still resets. */
  private sendCouponCode(user: CUser, code: number): void {
    const packet = new CSendPacket(S2C_ShopPacket.OnUseCouponRes);
    packet.Encode1(code);
    user.m_pSocket?.SendPacket(packet);
    user.ResetTranxInfo();
  }

  /** One stored coupon-map entry. False means this entry does not count,
   * including the official experience path that still applies the delta. */
  private grantCouponMapEntry(user: CUser, itemMan: CItemMan, entry: CouponMap): boolean {
    const userItem = itemMan.GetUserItem(entry.ItemSN);
    if (!userItem) return false;
    const units = entry.Units | 0;
    const validityPeriod = entry.ValidityPeriod !== 0 ? entry.ValidityPeriod : SHOP_PERMANENT_VALIDITY_DAYS;
    const expiryLevel = entry.Validitylevel !== 0
      ? (user.m_nLevel + entry.Validitylevel) | 0
      : SHOP_PERMANENT_EXPIRY_LEVEL;

    if (user.m_strCouponId.length > 0) {
      const preSN = this.db.prAddPreInventory(
        user.m_strCouponId,
        COUPON_PREINVENTORY_TYPE,
        entry.ItemSN,
        COUPON_STOCK_SN,
        units,
        validityPeriod,
        expiryLevel,
        user.GetName(),
        "",
      );
      return preSN > 0;
    }

    switch (userItem.Category) {
      case ItemCategory.PremiumTicket:
        if (this.db.prSetPremiumTicket(user.GetName(), entry.Validitylevel) === 0) return false;
        if (user.m_nAuthenCode !== 1) CCenterProcess.ms_pInstance?.SendAuthenCode(user.GetGlobalSerialNo(), 1);
        return true;
      case ItemCategory.Money:
        // SetMoney is true when prSetMoney's return is >= 0. This adapter's 0 is that success.
        return this.db.prSetMoney(user.GetName(), units) === 0;
      case ItemCategory.Experience:
        user.m_nExp = (user.m_nExp + units) | 0;
        user.SetLevel();
        this.db.prSetFxExp(user.GetName(), units);
        return false;
      default: {
        const added = this.db.prAddInventoryShop(
          user.GetName(),
          entry.ItemSN,
          COUPON_STOCK_SN,
          units,
          validityPeriod,
          expiryLevel,
          IsInventoryAddable(userItem.Category),
        );
        return added !== 0;
      }
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

  /** CBillingProcess::RequestGift (00402BA0).
   *  Price is ShopItem+0x34, not a caller argument. The last string is the
   *  recipient. A missing ShopItem is an undefined native dereference. */
  RequestGift(user: CUser, targetId: string, stockSN: number): void {
    const shopItem = CItemMan.ms_pInstance?.GetShopItem(stockSN);
    if (!shopItem || shopItem.SN < 0 || this.m_fConnected === 0) return;
    const p = CBillingSendPacket.FromBillingPacket(Shop2Billing_LegacyPacket.RequestGift);
    p.Encode4(user.GetGlobalSerialNo());
    p.Encode4(0);
    p.Encode4(0);
    p.Encode4(stockSN);
    p.Encode4(shopItem.Price);
    p.EncodeStr(user.GetNexonClubId());
    p.EncodeStr(cString(user.GetName()));
    p.Encode1(CMainSystem.ms_pInstance!.m_nFXAttr & 0xff);
    p.Encode2(user.m_nCommunitySvr);
    p.EncodeStr(cString(user.m_strTranxInfo));
    p.EncodeStr(cString(targetId));
    this.Send(p);
  }

  /** 00402E10. Returns 0 when the user is missing or already in a transaction. */
  RequestCheckCoupon(user: CUser): number {
    if (!user || user.m_fTranxInProgress !== 0) return 0;
    const p = CBillingSendPacket.FromCouponPacket(Shop2Billing_CouponPacket.RequestCheckCoupon);
    this.EncodeCouponBody(p, user);
    this.Send(p);
    return 1;
  }

  /** 00402FB0. Same guard and body as RequestCheckCoupon, opcode 1. */
  RequestUseCoupon(user: CUser): number {
    if (!user || user.m_fTranxInProgress !== 0) return 0;
    const p = CBillingSendPacket.FromCouponPacket(Shop2Billing_CouponPacket.RequestUseCoupon);
    this.EncodeCouponBody(p, user);
    this.Send(p);
    return 1;
  }

  private EncodeCouponBody(p: CSendPacket, user: CUser): void {
    p.Encode4(user.GetGlobalSerialNo());
    p.EncodeStr(user.m_strCoupon);
    p.EncodeStr(user.GetNexonClubId());
    p.EncodeStr(user.GetName());
    p.Encode1(CMainSystem.ms_pInstance!.m_nFXAttr & 0xff);
    p.Encode2(user.m_nCommunitySvr);
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
    const errCode = isGift ? PURCHASE_RESULT.GiftFailure : PURCHASE_RESULT.GenericFailure;
    const p = new CSendPacket(S2C_ShopPacket.OnPurchaseRes);
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
    const p = new CSendPacket(S2C_ShopPacket.OnRemainCashTw);
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
          if (result === 0) this.Send(this.MakePurchaseConfirmTw(reference, serial, BILLING_ORPHAN_STOCK, 2));
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
        if (result === 0) this.Send(this.MakePurchaseConfirmTw(reference, serial, BILLING_ORPHAN_STOCK, PURCHASE_CONFIRM.Absent));
        return;
      }
      if (result !== 0) {
        this.refuseExternalPurchase(user, message);
        return;
      }
      // 312 grants and answers 321. It does not tell the client, roll back, or reset.
      // A later 322 is what commits the receipt or undoes a confirmed grant.
      const grant = this.grantExternalPurchase(user, serial);
      if (grant.ok) {
        user.m_nTranxResult = 1;
        user.m_nTranxState = 1;
      } else {
        user.m_nTranxResult = grant.result;
      }
      this.Send(this.MakePurchaseConfirmTw(
        reference,
        serial,
        user.m_nTranxStockSN,
        grant.ok ? PURCHASE_CONFIRM.Charge : PURCHASE_CONFIRM.Refuse,
      ));
    } catch {
      console.warn("[Shop] Invalid billing 312; purchase remains pending for retry.");
    }
  }

  /** 312 result != 0 (00403DB4). A gift whose last proc returned -2 uses the shop category, not UserItem. */
  private refuseExternalPurchase(user: CUser, message: string): void {
    if (user.m_strTranxInfo.length === 0) {
      this.sendPurchaseResult(user, PURCHASE_RESULT.GenericFailure, message);
    } else if (user.m_nTranxResult === GIFT_LIMIT_RESULT) {
      const parent = CItemMan.ms_pInstance?.GetShopItem(user.m_nTranxStockSN) ?? null;
      if (parent?.Category === ItemCategory.Consumable) {
        this.sendPurchaseResult(user, PURCHASE_RESULT.GiftLimitOver, message, 1);
      } else {
        // A missing shop item would fault the category compare. Refuse as already owned.
        this.sendPurchaseResult(user, PURCHASE_RESULT.AlreadyOwned, message);
      }
    } else {
      this.sendPurchaseResult(user, PURCHASE_RESULT.GiftFailure, message);
    }
    user.ResetTranxInfo();
  }

  /** Grant the purchase prepared by OnReqPurchaseStockItem / OnRequestPresent.
   * Package children overwrite the item and amount; the stock stays the parent. */
  private grantExternalPurchase(user: CUser, serial: number): ExternalGrant {
    const itemMan = CItemMan.ms_pInstance;
    const parent = itemMan?.GetShopItem(user.m_nTranxStockSN) ?? null;
    if (!itemMan || !parent) return refused();
    const gift = user.m_strTranxInfo.length > 0;
    if (parent.Category !== ItemCategory.Package) return this.grantExternalLine(user, parent, gift, serial);
    if (this.externalPackageRefused(user, parent, gift)) return refused();

    for (const mapping of itemMan.GetPackageMapList(parent.SN)) {
      const child = itemMan.GetShopItem(mapping.StockSN);
      if (!child) return refused();
      user.m_nTranxItemSN = child.ItemSN;
      user.m_nTranxAmount = Math.imul(child.Unit, mapping.Units);
      const step = this.grantExternalLine(user, parent, gift, serial);
      if (!step.ok) return step;
    }
    return granted();
  }

  /** Owned category 15 refuses the package. Every other owned category continues.
   * A missing child makes official return without 321; billing would then retry and grant again, so this port refuses the charge. */
  private externalPackageRefused(user: CUser, parent: ShopItem, gift: boolean): boolean {
    const itemMan = CItemMan.ms_pInstance;
    if (!itemMan) return true;
    const owner = gift ? user.m_strTranxInfo : user.GetName();
    for (const mapping of itemMan.GetPackageMapList(parent.SN)) {
      const child = itemMan.GetShopItem(mapping.StockSN);
      if (!child) return true;
      const owned = this.db.prIsValidPreInventory(owner, child.ItemSN) !== 0
        || this.db.prIsValidInventory(owner, child.ItemSN) !== 0;
      if (owned && child.Category === ItemCategory.StackableItem) return true;
    }
    return false;
  }

  private grantExternalLine(user: CUser, parent: ShopItem, gift: boolean, serial: number): ExternalGrant {
    if (parent.Category === ItemCategory.PremiumTicket) {
      return gift ? this.grantGift(user, parent, false) : this.grantPremiumTicket(user, parent, serial);
    }
    return gift ? this.grantGift(user, parent, true) : this.grantInventory(user, parent);
  }

  private grantPremiumTicket(user: CUser, parent: ShopItem, serial: number): ExternalGrant {
    if (this.db.prSetPremiumTicket(user.GetName(), parent.ValidityPeriod) === 0) return refused();
    CCenterProcess.ms_pInstance?.SendAuthenCode(serial, 1);
    user.m_listTranxInfo.push({
      ItemSN: user.m_nTranxItemSN,
      PreInventorySN: 0,
      IsNew: 0,
      Amount: parent.ValidityPeriod,
    });
    return granted();
  }

  /** AddNewInventory's 0 leaves the official success flag set and would confirm a missing row. Refuse that charge. */
  private grantInventory(user: CUser, parent: ShopItem): ExternalGrant {
    const item = CItemMan.ms_pInstance?.GetUserItem(user.m_nTranxItemSN) ?? null;
    if (!item) return refused();
    const added = this.db.prAddInventoryShop(
      user.GetName(),
      user.m_nTranxItemSN,
      user.m_nTranxStockSN,
      user.m_nTranxAmount,
      expiryDays(parent.ValidityPeriod),
      selfExpiryLevel(parent.ValidityLevel, user.m_nLevel),
      IsInventoryAddable(item.Category),
    );
    if (added === 0) return refused();
    user.m_listTranxInfo.push({
      ItemSN: user.m_nTranxItemSN,
      PreInventorySN: 0,
      IsNew: added === INVENTORY_GRANT_STACKED ? 1 : 0,
      Amount: user.m_nTranxAmount,
    });
    return granted();
  }

  /** Premium gift failure does not keep the proc code. Every other gift failure does. */
  private grantGift(user: CUser, parent: ShopItem, keepFailureCode: boolean): ExternalGrant {
    const preSN = this.addGiftInventory(user, parent);
    if (preSN < 0) return refused(keepFailureCode ? preSN : 0);
    user.m_listTranxInfo.push({
      ItemSN: 0,
      PreInventorySN: preSN,
      IsNew: 0,
      Amount: parent.Category === ItemCategory.PremiumTicket ? parent.ValidityPeriod : 0,
    });
    return granted();
  }

  /** AddPreInventory(CUser *): type 200, parent stock, sender name, and no user-level add. */
  private addGiftInventory(user: CUser, parent: ShopItem): number {
    return this.db.prAddPreInventory(
      user.m_strTranxInfo,
      PRESENT_PREINVENTORY_TYPE,
      user.m_nTranxItemSN,
      user.m_nTranxStockSN,
      user.m_nTranxAmount,
      expiryDays(parent.ValidityPeriod),
      giftExpiryLevel(parent.ValidityLevel),
      user.GetName(),
      "",
    );
  }

  /** 322 failure walks the grant list only after a confirmed charge (TranxState != 0). */
  private rollbackExternalGrant(user: CUser): void {
    if (user.m_strTranxInfo.length > 0) {
      for (const entry of user.m_listTranxInfo) {
        this.db.prLoadInventory(entry.PreInventorySN, user.m_strTranxInfo, 0, 0, 0, 0, 0, 0, 1);
      }
      return;
    }
    const itemMan = CItemMan.ms_pInstance;
    for (const entry of user.m_listTranxInfo) {
      const item = itemMan?.GetUserItem(entry.ItemSN) ?? null;
      if (!item) break;
      if (item.Category === ItemCategory.PremiumTicket) {
        // Adding zero days does not revoke a future ticket. Official still notifies center.
        this.db.prSetPremiumTicket(user.GetName(), 0);
        CCenterProcess.ms_pInstance?.SendAuthenCode(user.GetGlobalSerialNo(), 0);
      } else if (entry.IsNew !== 0) {
        this.db.prUpdateInventoryAmountDelta(user.GetName(), entry.ItemSN, -entry.Amount);
      } else {
        this.db.prDeleteInventory(user.GetName(), entry.ItemSN);
      }
    }
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
          const p = new CSendPacket(S2C_ShopPacket.OnPurchaseRes);
          p.Encode1(PURCHASE_RESULT.Success); p.EncodeBuffer(EncodeVariantTime(new Date()));
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
      // Native 322 never resumes PurchaseCartList. A billing cart entry stays paused.
      if (result !== 0) this.cancelExternalPurchase(user, message);
      else this.confirmExternalPurchase(user);
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
    const p = new CSendPacket(S2C_ShopPacket.OnDigiQAuthenRes);
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

  /** 322 success: client 204, then the receipt, then reset. The log uses the post-grant item and amount. */
  private confirmExternalPurchase(user: CUser): void {
    this.sendPurchaseSuccess(user);
    const parent = CItemMan.ms_pInstance?.GetShopItem(user.m_nTranxStockSN) ?? null;
    CTranxCtrl.ms_pInstance?.AddTranx({
      kind: user.m_strTranxInfo.length === 0 ? 0 : 1,
      stockSN: user.m_nTranxStockSN,
      itemSN: user.m_nTranxItemSN,
      amount: user.m_nTranxAmount,
      price: parent === null ? -1 : parent.Price,
    });
    user.ResetTranxInfo();
  }

  private cancelExternalPurchase(user: CUser, message: string): void {
    if (user.m_nTranxState !== 0) this.rollbackExternalGrant(user);
    const code = user.m_strTranxInfo.length === 0 ? PURCHASE_RESULT.GenericFailure : PURCHASE_RESULT.GiftFailure;
    this.sendPurchaseResult(user, code, message);
    user.ResetTranxInfo();
  }

  private sendPurchaseSuccess(user: CUser): void {
    const packet = new CSendPacket(S2C_ShopPacket.OnPurchaseRes);
    packet.Encode1(PURCHASE_RESULT.Success);
    packet.EncodeBuffer(EncodeVariantTime(new Date()));
    user.m_pSocket?.SendPacket(packet);
  }

  private sendPurchaseResult(user: CUser, code: number, message: string, extra?: number): void {
    const packet = new CSendPacket(S2C_ShopPacket.OnPurchaseRes);
    packet.Encode1(code);
    packet.EncodeStr(message);
    if (extra !== undefined) packet.Encode1(extra);
    user.m_pSocket?.SendPacket(packet);
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
