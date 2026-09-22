/** Native source unit: FX/FxShop/MainPool.cpp. */
import { CDBMan } from "../db/DBMan.ts";
import { CReceivedPacket, CSendPacket, CipherDegree } from "../core/Packet.ts";
import { EncodeVariantTime } from "../core/VariantTime.ts";
import { C2S_ShopPacket, S2C_ShopPacket } from "../protocol/PacketIDs.ts";
import { MC_ShopServerSendPacket } from "../protocol/CenterProtocol.ts";
import { CItemMan } from "./ItemMan.ts";
import type { _USERACCOUNT, _USERDYNINFO } from "./Recordsets.ts";
import { ItemCategory, IsInventoryAddable } from "../shared/Item.ts";
import {
  CART_RECEIPT_CODE,
  CART_RECEIPT_RESULT,
  CHARGE_VERIFY_RESULT,
  SHOP_PERMANENT_EXPIRY_LEVEL,
  SHOP_PERMANENT_VALIDITY_DAYS,
} from "./Defs.ts";
import { BILLING_ERROR } from "../LocalBilling/Defs.ts";
import { CUser } from "./User.ts";
import type { CClientSocket } from "./ClientSocket.ts";
import { CLocalUserTable } from "./LocalUserTable.ts";
import { CUserPool } from "./UserPool.ts";
import { CTranxCtrl, TRANSACTION_PAGE_BYTES } from "./TranxCtrl.ts";
import { CBillingProcess } from "./BillingProcess.ts";
import { CCenterProcess } from "./CenterProcess.ts";
import { CMainSystem } from "./MainSystem.ts";
import { RegisterShopMainPool } from "./MainPoolRuntime.ts";
import type { CWebSocket } from "./WebSocket.ts";

// FxShop.exe @0x47ECA0 — 購買商品時發生錯誤
const ERR_PURCHASE = "購買商品時發生錯誤";

/** CMainPool — the client dispatch (FxShop.exe.c:20547). */
export class CMainPool extends CUserPool {
  private static m_pInstance: CMainPool | null = null;

  static get ms_pInstance(): CMainPool | null {
    return CMainPool.m_pInstance;
  }

  static set ms_pInstance(pool: CMainPool | null) {
    CMainPool.m_pInstance = pool;
    RegisterShopMainPool(pool);
  }

  billingProcess!: CBillingProcess; // the digicell link (wired by CFxShopApp's ctor)

  constructor(public db: CDBMan) {
    super();
    CMainPool.ms_pInstance = this;
  }

  /** CMainPool::OnPacket — the 20547 switch; unknown ids fall to
   *  CUserPool::OnPacket (the 20 RTT handler). */
  override OnPacket(n: CReceivedPacket, socket: CClientSocket): void {
    const type = n.Decode1();
    switch (type) {
      case C2S_ShopPacket.OnReqConnectToSvr:
        this.OnReqConnectToSvr(n, socket);
        return;
      case C2S_ShopPacket.OnConnEstablished:
        this.OnConnEstablished(n, socket);
        return;
      case C2S_ShopPacket.RequestRemainCashTw:
        this.OnRequestRemainCashTw(n, socket);
        return;
      case C2S_ShopPacket.OnReqPurchase:
        this.OnReqPurchase(n, socket);
        return;
      case C2S_ShopPacket.OnRequestDeleteItem:
        this.OnRequestDeleteItem(n, socket);
        return;
      case C2S_ShopPacket.OnUserSlotInfo:
        this.OnUserSlotInfo(n, socket);
        return;
      case C2S_ShopPacket.OnRequestModifyItemVerbose:
        this.OnRequestModifyItemVerbose(n, socket);
        return;
      case C2S_ShopPacket.OnRequestShopItemList:
        CItemMan.ms_pInstance!.SendShopItemList(socket);
        return;
      case C2S_ShopPacket.OnRequestCharge:
        this.OnRequestCharge(n, socket);
        return;
      case C2S_ShopPacket.OnRequestStringTable:
        CItemMan.ms_pInstance!.SendStringTable(socket);
        return;
      case C2S_ShopPacket.OnRequestUserItemList:
        this.OnRequestUserItemList(n, socket);
        return;
      case C2S_ShopPacket.OnRequestPresent:
        this.OnRequestPresent(n, socket);
        return;
      case C2S_ShopPacket.OnRequestUseCoupon:
        this.OnRequestUseCoupon(n, socket);
        return;
      case C2S_ShopPacket.OnRequestPackageMap:
        CItemMan.ms_pInstance!.SendPackageMap(socket);
        return;
      case C2S_ShopPacket.OnRequestCartList:
        this.OnRequestCartList(n, socket);
        return;
      case C2S_ShopPacket.OnRequestAddCartList:
        this.OnRequestAddCartList(n, socket);
        return;
      case C2S_ShopPacket.OnReqPurchaseCartList:
        this.OnReqPurchaseCartList(n, socket);
        return;
      case C2S_ShopPacket.OnReqDigiQAuthorization:
        this.OnReqDigiQAuthorization(n, socket);
        return;
      case C2S_ShopPacket.OnRequestTranxData:
        this.OnRequestTranxData(n, socket);
        return;
      case C2S_ShopPacket.OnRequestShopSvrInfo:
        this.OnRequestShopSvrInfo(n, socket);
        return;
      default: {
        // CUserPool::OnPacket — rewind the type byte first
        n.m_uOffset = 0;
        super.OnPacket(n, socket);
      }
    }
  }

  /** CMainPool::OnConnEstablished (00415980) — client 7.
   * [E1 count][count × (EStr name, E4 serial, E4 SID, E4 BID)][E1 selected].
   * Cross-check .lst 00415A52/00415A5C/00415A68: +3112/+3108/+3096.
   * The second DWORD is NOT cash (+3104). CM 3 echoes serial and SID.
   */
  OnConnEstablished(n: CReceivedPacket, socket: CClientSocket): void {
    const count = n.Decode1();
    socket.AddNewUsers(count);
    this.AddNewSocket(socket);
    let i = 0;
    for (; i < count; i++) {
      const user = socket.GetUser(i)!;
      const name = n.DecodeStr();
      const sn = n.Decode4();
      const sid = n.Decode4(); // +3108
      const bid = n.Decode4(); // +3112
      user.SetName(name);
      user.SetGlobalSerialNo(sn);
      user.m_nSID = sid;
      user.m_nBID = bid;
      if (CLocalUserTable.ms_pInstance!.Insert(user) === 0) break;
    }
    if (i < count) {
      console.error(`[Shop] Cannot insert user to local user table, ${i} th user`);
      for (let j = 0; j < i; j++) CLocalUserTable.ms_pInstance!.Remove(socket.GetUser(j)!);
      socket.Close();
      return;
    }
    socket.m_nSelectedUserIdx = n.Decode1();
    // → center MC 3 with the shop's extra per-user SID column (user+3108)
    const p = new CSendPacket(MC_ShopServerSendPacket.OnConnEstablished);
    p.Encode1(count);
    for (let j = 0; j < count; j++) {
      const u = socket.GetUser(j)!;
      p.EncodeStr(u.GetName());
      p.Encode4(u.GetGlobalSerialNo());
      p.Encode4(u.m_nSID); // CUser::GetSID — the client-supplied billing SID
    }
    CCenterProcess.ms_pInstance?.SendPacket(p);
  }

  /** CMainPool::OnReqConnectToSvr (00415210) — client 6:
   * [E1 serverType][E4 target], with no version word. The native 00415232
   * calls Decode1, NOT Decode2. Forward all socket users to Center MC 2;
   * SelectedUserIdx is not involved in this request.
   */
  OnReqConnectToSvr(n: CReceivedPacket, socket: CClientSocket): void {
    const type = n.Decode1();
    const target = n.Decode4();
    const p = new CSendPacket(MC_ShopServerSendPacket.OnReqConnectToSvr);
    const count = socket.GetUserCount();
    p.Encode1(count);
    for (let i = 0; i < count; i++) p.Encode4(socket.GetUser(i)!.GetGlobalSerialNo());
    p.Encode1(type);
    p.Encode4(target);
    CCenterProcess.ms_pInstance?.SendPacket(p);
  }

  /** CMainPool::OnCenterResConnectToSvr (004152E0) — Center CM 1:
   * [E1 n][n×E4 serial][E1 result][==1: E1 type, E4 idx, E4 ip, E2 port].
   * Every user must exist and have no billing transaction in progress.
   * Abort on the first failure; otherwise send client 6 to the LAST user.
   */
  OnCenterResConnectToSvr(n: CReceivedPacket): void {
    const count = n.Decode1();
    let target: CUser | null = null;
    for (let i = 0; i < count; i++) {
      target = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(n.Decode4());
      if (!target || target.m_fTranxInProgress !== 0) return;
    }
    // Zero-count native code uses an invalid target; keep the port safe.
    if (!target || !target.m_pSocket) return;
    const result = n.Decode1();
    const p = new CSendPacket(S2C_ShopPacket.OnReqConnectToSvrRes, CipherDegree.kPacketEncryptedCRC8);
    p.Encode1(result);
    if (result === 1) {
      const svrType = n.Decode1();
      const svrIdx = n.Decode4();
      const ip = n.Decode4();
      const port = n.Decode2();
      p.Encode1(svrType);
      p.Encode4(svrIdx);
      p.Encode4(ip);
      p.Encode2(port);
    }
    target.m_pSocket.SendPacket(p);
  }

  /** CMainPool::OnCenterResConnEstablished — center CM 2, the shop variant:
   *  [E1 n][n×(E4 serial, E1 authencode, E1 billingFlag)][E1 result].
   *  On success each user's account/dyninfo reload and the client 18
   *  initial-info packet go out (+207/201 when anyone owns inventory). */
  OnCenterResConnEstablished(n: CReceivedPacket): void {
    const count = n.Decode1();
    const serials: number[] = [];
    const authencodes: number[] = []; // the per-user authencode bytes
    const billingFlags: number[] = []; // the ptr+24 dword array
    for (let i = 0; i < count; i++) {
      serials.push(n.Decode4());
      authencodes.push(n.Decode1());
      billingFlags.push(n.Decode1());
    }
    const result = n.Decode1();

    // resolve every user + reload the _USERACCOUNT/_USERDYNINFO pair; any
    // miss zeroes the ok flag and the original closes serial[0]'s socket
    let ok = true;
    const users: (CUser | null)[] = [];
    for (let i = 0; i < count; i++) {
      const u = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(serials[i]!);
      if (!u) { ok = false; break; }
      users.push(u);
    }
    const accounts: _USERACCOUNT[] = [];
    const dyns: _USERDYNINFO[] = [];
    for (let i = 0; ok && i < count; i++) {
      const row = this.db.prGetUserInfoShop(users[i]!.GetName());
      if (!row) { ok = false; break; }
      accounts.push({
        SN: row.SN, Name: row.Name, Password: row.Password, Email: row.Email, EmailRcv: row.EmailRcv,
        Gender: row.Gender, Address: row.Address, Tel: row.Tel, Reveal: row.Reveal, Profile: row.Profile,
        TotalConn: row.TotalConn, LastConn: row.LastConn, Permission: row.Permission, money: row.money,
        win: row.win, draw: row.draw, lose: row.lose, ShopCardNo: row.ShopCardNo, CommunitySvr: row.CommunitySvr,
      });
      dyns.push({
        Exp: (this.db.prGetUserDynamic(users[i]!.GetName()) as { Exp?: number } | undefined)?.Exp ?? 0,
        Money: row.money, Win: row.win, Draw: row.draw, Lose: row.lose, PremiumDate: null,
      });
    }

    // the failure tail (result flag 0): close serial[0]'s socket (no reply anywhere)
    if (!ok) {
      const first = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(serials[0]!);
      first?.m_pSocket?.Close();
      return;
    }

    // the socket comes from serial[0]'s user; the target from ITS SelectedUserIdx
    const first = users[0]!;
    const socket = first.m_pSocket;
    if (!socket) return;
    const sel = socket.m_nSelectedUserIdx;
    if (sel > 2) {
      console.error(`[Shop] Invalid SelectedUserIdx (${sel})`);
      socket.Close();
      return;
    }
    const target = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(serials[sel] ?? serials[0]!);
    if (!target || !this.m_setUser.has(target)) {
      socket.Close();
      return;
    }
    if (result === 0) {
      const name = target.GetName();
      console.error(
        `[Shop] Connection failed from center server(${name}:0x${target.GetGlobalSerialNo().toString(16).padStart(8, "0")})`,
      );
      socket.Close();
      return;
    }

    // _USERACCOUNT::operator= + the dyninfo copy; SetLevel / SetNexonClubId;
    // user+3116 = the authencode of the selected user
    const account = accounts[sel] ?? accounts[0]!;
    const dyn = dyns[sel] ?? dyns[0]!;
    target.m_nCash = dyn.Money;
    target.SetLevel(dyn);
    target.SetNexonClubId(account);
    target.m_nAuthenCode = authencodes[sel] ?? 0;

    // client 18 OnInitialInfo
    const itemMan = CItemMan.ms_pInstance!;
    const system = CMainSystem.ms_pInstance!;
    const p = new CSendPacket(S2C_ShopPacket.OnInitialInfo, CipherDegree.kPacketEncryptedCRC8);
    if (target.m_nAuthenCode === 1) {
      p.Encode1(1);
      p.Encode1(101);
    } else {
      p.Encode1(0);
    }
    p.Encode4(itemMan.m_nShopItemHash);
    p.Encode4(itemMan.m_nStringHash);
    p.Encode4(itemMan.m_nPackageMapHash);
    p.EncodeStr(system.m_strChargeUrl);
    p.EncodeStr(system.m_strAuthUrl);
    p.Encode1(1);
    p.Encode1(0);
    p.Encode1(1);
    p.Encode1(billingFlags[sel] ?? 0);
    if ((billingFlags[sel] ?? 0) !== 0) this.billingProcess.RequestRemainCashTw(target);
    itemMan.MakeBonusMap(p);
    target.m_pSocket?.SendPacket(p);

    // 207/201 only when any of the users already owns inventory (the shop
    // never fills the in-memory vectors — purchases go straight to the DB —
    // so in practice this branch stays silent, exactly like the original).
    if (users.some((u) => u && u.m_vecUserInventory.length > 0)) {
      const p207 = new CSendPacket(S2C_ShopPacket.OnPreInventory, CipherDegree.kPacketEncryptedCRC8);
      p207.Encode1(users.length);
      for (const u of users) u!.MakePreInventoryPacket(p207);
      target.m_pSocket?.SendPacket(p207);
      const p201 = new CSendPacket(S2C_ShopPacket.OnUserInventory, CipherDegree.kPacketEncryptedCRC8);
      p201.Encode1(users.length);
      for (const u of users) u!.MakeUserInventoryPacket(p201);
      target.m_pSocket?.SendPacket(p201);
    }
  }

  /** client 205 → CBillingProcess::RequestRemainCashTw (no client reply in
   *  this handler — the answer comes back through billing 302). */
  OnRequestRemainCashTw(_n: CReceivedPacket, socket: CClientSocket): void {
    const user = socket.GetUser(socket.m_nSelectedUserIdx);
    if (!user) return;
    this.billingProcess.RequestRemainCashTw(user);
  }

  /** CMainPool::OnReqPurchase — client 206 [E2 stockSN]: ignored unless the
   *  stock item exists; then OnReqPurchaseStockItem. */
  OnReqPurchase(n: CReceivedPacket, socket: CClientSocket): void {
    const stockSN = n.Decode2();
    if (CItemMan.ms_pInstance!.GetShopItem(stockSN) === null) return;
    const user = socket.GetUser(socket.m_nSelectedUserIdx);
    if (!user) return;
    this.OnReqPurchaseStockItem(user, stockSN);
  }

  /** CMainPool::OnReqPurchaseStockItem — the purchase state machine.
   *  Replies ride client 204 [E1 code][EStr message]. */
  OnReqPurchaseStockItem(user: CUser, stockSN: number): void {
    if (user.m_fTranxInProgress !== 0) return; // native 00415EA0, user+20
    const itemMan = CItemMan.ms_pInstance!;
    const shopItem = itemMan.GetShopItem(stockSN);
    if (!shopItem) {
      this.PurchaseError(user, 1, ERR_PURCHASE);
      return;
    }
    if (this.billingProcess.m_fLocalBilling && shopItem.MoneyType === 0) {
      this.billingProcess.RequestPurchaseTw(user, shopItem);
      return;
    }
    // A port-side purchase is already in flight → error 1.
    if (user.m_pPurchaseTranx !== null) {
      this.PurchaseError(user, 1, ERR_PURCHASE);
      return;
    }
    const id = user.GetName();

    // FxShop 00415EA0 switches on the STOCK category. nAttr1 is an owned
    // quantity limit only for category 13, not a universal maximum.
    const packages = shopItem.Category === ItemCategory.Package ? itemMan.GetPackageMapList(shopItem.SN) : [];
    if (shopItem.Category === ItemCategory.Package) {
      for (const pkg of packages) {
        const sub = itemMan.GetShopItem(pkg.StockSN);
        if (!sub) {
          this.PurchaseError(user, 5, ERR_PURCHASE);
          user.ResetTranxInfo();
          return;
        }
        const owned = (this.db.prIsValidInventory(id, sub.ItemSN) + this.db.prIsValidPreInventory(id, sub.ItemSN)) | 0;
        // Native's category-15 exemption tests the PARENT, which is 11 in
        // this branch. A category-15 CHILD is therefore not exempt.
        if (owned !== 0 && sub.Category !== ItemCategory.Consumable && sub.Category !== ItemCategory.LimitedItem) {
          this.PurchaseError(user, 4, ERR_PURCHASE);
          user.ResetTranxInfo();
          return;
        }
        const ui = itemMan.GetUserItem(sub.ItemSN);
        if (ui && sub.Category === ItemCategory.LimitedItem && owned >= ui.nAttr1) {
          this.PurchaseError(user, 11, ERR_PURCHASE); // package branch has no formatted limit text
          user.ResetTranxInfo();
          return;
        }
      }
    } else if (shopItem.Category === ItemCategory.LimitedItem) {
      const ui = itemMan.GetUserItem(shopItem.ItemSN);
      if (!ui) {
        console.error(`[Shop] Invalid item sn (OnReqPurchaseStockItem) = ${shopItem.ItemSN}`);
        this.PurchaseError(user, 1, ERR_PURCHASE);
        user.ResetTranxInfo();
        return;
      }
      const owned = (this.db.prIsValidInventory(id, shopItem.ItemSN) + this.db.prIsValidPreInventory(id, shopItem.ItemSN)) | 0;
      if (owned >= ui.nAttr1) {
        this.PurchaseError(user, 11, formatLimit(ui.nAttr1));
        user.ResetTranxInfo();
        return;
      }
    } else if (!IsInventoryAddable(shopItem.Category)) {
      const owned = (this.db.prIsValidInventory(id, shopItem.ItemSN) + this.db.prIsValidPreInventory(id, shopItem.ItemSN)) | 0;
      if (owned !== 0) {
        this.PurchaseError(user, 4, ERR_PURCHASE);
        user.ResetTranxInfo();
        return;
      }
    }

    // MoneyType 0 = the digicell billing path (a silent no-op while the
    // billing link is down — the original never replies either).
    if (shopItem.MoneyType === 0) {
      this.billingProcess.RequestPurchaseTw(user, shopItem);
      return;
    }

    // MoneyType != 0 uses game Money. Native flat packages grant each
    // child's ItemSN and Units*Unit, but retain the PARENT StockSN/validity.
    // Native also keeps earlier grants on failure; the last result wins.
    // This is deliberately distinct from the local billing atomic settlement.
    let ok = 1;
    const grants = shopItem.Category === ItemCategory.Package
      ? packages.map(pkg => {
          const sub = itemMan.GetShopItem(pkg.StockSN)!;
          return { itemSN: sub.ItemSN, units: Math.imul(pkg.Units, sub.Unit) };
        })
      : [{ itemSN: shopItem.ItemSN, units: shopItem.Unit }];
    for (const grant of grants) {
      if (shopItem.Price > user.m_nCash) ok = 0;
      else if (shopItem.Category === ItemCategory.PremiumTicket) {
        ok = this.db.prSetPremiumTicket(id, shopItem.ValidityPeriod);
        if (ok !== 0) CCenterProcess.ms_pInstance?.SendAuthenCode(user.GetGlobalSerialNo(), 1);
      } else {
        const item = itemMan.GetUserItem(grant.itemSN);
        const days = shopItem.ValidityPeriod || SHOP_PERMANENT_VALIDITY_DAYS;
        const expiryLevel = shopItem.ValidityLevel === 0 ? SHOP_PERMANENT_EXPIRY_LEVEL : (user.m_nLevel + shopItem.ValidityLevel) | 0;
        ok = item ? this.db.prAddInventoryShop(id, grant.itemSN, shopItem.SN, grant.units, days, expiryLevel, IsInventoryAddable(item.Category)) : 0;
      }
    }
    if (ok !== 0) {
      // Native ignores SetMoney's failure result: this is NOT an atomic
      // cross-shard settlement. Do not confuse it with the local points path.
      this.db.prSetMoney(id, -shopItem.Price);
      user.m_nCash -= shopItem.Price;
      if (user.m_fCartProcessing === 0) {
        // success: client 204 [E1 0][8B SystemTimeToVariantTime double]
        const p = new CSendPacket(S2C_ShopPacket.OnPurchaseRes, CipherDegree.kPacketEncryptedCRC8);
        p.Encode1(0);
        p.EncodeBuffer(EncodeVariantTime(new Date()));
        user.m_pSocket?.SendPacket(p);
      }
    } else if (user.m_fCartProcessing === 0) {
      this.PurchaseError(user, 1, ERR_PURCHASE);
    }
    user.ResetTranxInfo();
  }

  PurchaseError(user: CUser, code: number, msg: string): void {
    const p = new CSendPacket(S2C_ShopPacket.OnPurchaseRes, CipherDegree.kPacketEncryptedCRC8);
    p.Encode1(code);
    p.EncodeStr(msg);
    user.m_pSocket?.SendPacket(p);
  }

  /** CMainPool::OnRequestDeleteItem — client 207 [E4 itemSN] (>= 0):
   *  CDBMan::DeleteInventory.  No client reply. */
  OnRequestDeleteItem(n: CReceivedPacket, socket: CClientSocket): void {
    const itemSN = n.Decode4();
    if (itemSN < 0) return;
    const user = socket.GetUser(socket.m_nSelectedUserIdx);
    if (!user) return;
    this.db.prDeleteInventory(user.GetName(), itemSN);
  }

  /** CMainPool::OnUserSlotInfo — client 210 [E2 n][n×(E1 slot, E2 itemSN)],
   *  guarded by user+20; CDBMan::UpdateInventorySlot per pair.  No reply. */
  OnUserSlotInfo(n: CReceivedPacket, socket: CClientSocket): void {
    const count = n.Decode2();
    const user = socket.GetUser(socket.m_nSelectedUserIdx);
    if (!user || user.m_fTranxInProgress !== 0) return;
    for (let i = 0; i < count; i++) {
      if (user.m_fTranxInProgress !== 0) break;
      const slot = n.Decode1();
      const itemSN = n.Decode2();
      this.db.prUpdateInventorySlot(user.GetName(), itemSN, slot);
    }
  }

  /** CMainPool::OnRequestModifyItemVerbose — client 212
   *  [E1 slot][E4 itemSN][EStr verbose] → prUpdateInventoryVerbose. */
  OnRequestModifyItemVerbose(n: CReceivedPacket, socket: CClientSocket): void {
    n.Decode1(); // slot
    const itemSN = n.Decode4();
    const verbose = n.DecodeStr();
    const user = socket.GetUser(socket.m_nSelectedUserIdx);
    if (!user) return;
    this.db.prUpdateInventoryVerbose(user.GetName(), itemSN, verbose);
  }

  /** CMainPool::OnRequestCharge — client 214, nothing decoded. Guards on
   * user+20 and answers client 206 with
   * [E1 CMainSystem+4 FX attr][E4 serial][E4 user+0xBE4 charge key], then
   * flags user+0xBE8. The last DWORD is not either cash balance. */
  OnRequestCharge(_n: CReceivedPacket, socket: CClientSocket): void {
    const user = socket.GetUser(socket.m_nSelectedUserIdx);
    if (!user || user.m_fTranxInProgress !== 0) return;
    const p = new CSendPacket(S2C_ShopPacket.OnReqPurchaseRes, CipherDegree.kPacketEncryptedCRC8);
    p.Encode1(CMainSystem.ms_pInstance!.m_nFXAttr & 0xff);
    p.Encode4(user.GetGlobalSerialNo());
    p.Encode4(user.m_nChargeKey);
    socket.SendPacket(p);
    user.m_fRemainCashRequested = 1;
  }

  /** CMainPool::OnRequestUserItemList — client 217 → 202 PutUserItemList. */
  OnRequestUserItemList(_n: CReceivedPacket, socket: CClientSocket): void {
    const p = new CSendPacket(S2C_ShopPacket.OnUserItemList, CipherDegree.kPacketEncryptedCRC8);
    CItemMan.ms_pInstance!.PutUserItemList(p);
    socket.SendPacket(p);
  }

  /** CMainPool::OnRequestPresent — client 218 [E2 stockSN][EStr targetId]:
   *  ConfirmRegisteredId, then the billing gift request. */
  OnRequestPresent(n: CReceivedPacket, socket: CClientSocket): void {
    const stockSN = n.Decode2();
    const targetId = n.DecodeStr();
    const user = socket.GetUser(socket.m_nSelectedUserIdx);
    if (!user) return;
    if (this.billingProcess.m_fLocalBilling) { this.PurchaseError(user, 1, BILLING_ERROR.unsupported); return; }
    if (this.db.prConfirmUnregisteredId(targetId) === 0) {
      const p = new CSendPacket(S2C_ShopPacket.OnPurchaseRes, CipherDegree.kPacketEncryptedCRC8);
      p.Encode1(3);
      p.EncodeStr(ERR_PURCHASE);
      socket.SendPacket(p);
      return;
    }
    if (!CBillingProcess.ms_pInstance || !CBillingProcess.ms_pInstance.IsConnected()) {
      const p = new CSendPacket(S2C_ShopPacket.OnPurchaseRes, CipherDegree.kPacketEncryptedCRC8);
      p.Encode1(5);
      p.EncodeStr(ERR_PURCHASE);
      socket.SendPacket(p);
      return;
    }
    const item = CItemMan.ms_pInstance!.GetShopItem(stockSN);
    CBillingProcess.ms_pInstance.RequestGift(user, targetId, stockSN, item?.Price ?? 0);
  }

  /** CMainPool::OnRequestUseCoupon — client 219 [EStr coupon][EStr id]. */
  OnRequestUseCoupon(n: CReceivedPacket, socket: CClientSocket): void {
    const coupon = n.DecodeStr();
    const id = n.DecodeStr();
    const user = socket.GetUser(socket.m_nSelectedUserIdx);
    if (!user) return;
    if (this.billingProcess.m_fLocalBilling) {
      const p = new CSendPacket(S2C_ShopPacket.OnUseCouponRes, CipherDegree.kPacketEncryptedCRC8);
      p.Encode1(7); // existing client-visible coupon refusal, no claim that it was redeemed
      socket.SendPacket(p);
      return;
    }
    if (id.length === 0 || this.db.prConfirmUnregisteredId(id) !== 0) {
      // CMainPool::OnRequestUseCoupon stores the pair on the user (+3008/+3032)
      user.m_strCoupon = coupon;
      user.m_strCouponId = id;
      CBillingProcess.ms_pInstance?.RequestCheckCoupon(user);
      return;
    }
    const p = new CSendPacket(S2C_ShopPacket.OnUseCouponRes, CipherDegree.kPacketEncryptedCRC8);
    p.Encode1(7);
    socket.SendPacket(p);
  }

  /** CMainPool::OnRequestCartList — client 221, guarded by user+20:
   *  CDBMan::InitUserCart then client 214 [E1 count(user+2868)]
   *  [count != 0: EStr list]. */
  OnRequestCartList(_n: CReceivedPacket, socket: CClientSocket): void {
    const user = socket.GetUser(socket.m_nSelectedUserIdx);
    if (!user || user.m_fTranxInProgress !== 0) return;
    const cart = this.db.prGetUserCartList(user.GetName());
    const list = cart.stockSN;
    const count = list ? list.split(",").filter((x) => x.length > 0).length : 0;
    const p = new CSendPacket(S2C_ShopPacket.OnCartList, CipherDegree.kPacketEncryptedCRC8);
    p.Encode1(count);
    if (count !== 0) p.EncodeStr(list);
    socket.SendPacket(p);
  }

  /** CMainPool::OnRequestAddCartList — client 222 [EStr list] → prAddUserCartList. */
  OnRequestAddCartList(n: CReceivedPacket, socket: CClientSocket): void {
    const list = n.DecodeStr();
    const user = socket.GetUser(socket.m_nSelectedUserIdx);
    if (!user) return;
    this.db.prAddUserCartList(user.GetName(), list);
  }

  /** CMainPool::OnReqPurchaseCartList — client 223
   * [E1 count][count×(E2 stockSN, E1 cnt)], guarded by user+20. Native stores
   * count as the next empty slot: a bonus remains at that index, while a miss
   * decrements it to the last client row. It then consumes the current row's
   * first unit before entering PurchaseCartList. */
  OnReqPurchaseCartList(n: CReceivedPacket, socket: CClientSocket): void {
    const user = socket.GetUser(socket.m_nSelectedUserIdx);
    if (!user || user.m_fTranxInProgress !== 0) return;
    if (this.billingProcess.m_fLocalBilling) { this.PurchaseError(user, 1, BILLING_ERROR.unsupported); return; }

    user.m_fCartProcessing = 1;
    user.m_nCartCount = n.Decode1();
    user.m_anCart = [];
    let billingTotal = 0;
    let hasUnknownStock = false;
    for (let i = 0; i < user.m_nCartCount; i++) {
      const stockSN = n.Decode2();
      const cnt = n.Decode1();
      user.m_anCart.push({ stockSN, cnt });
      const item = CItemMan.ms_pInstance!.GetShopItem(stockSN);
      if (!item) {
        hasUnknownStock = true;
      } else if (item.MoneyType === 0) {
        billingTotal = (billingTotal + item.Price) | 0;
      }
    }
    if (hasUnknownStock) {
      // Native dereferences the missing ShopItem while summing the cart.
      // Reject that undefined path before any purchase side effect.
      user.m_fCartProcessing = 0;
      return;
    }

    // AddBonusCartItem writes {StockSN,1} at the next-empty-slot index. With
    // no matching threshold, native changes that index to the final input row.
    if (CItemMan.ms_pInstance!.AddBonusCartItem(billingTotal, user, user.m_nCartCount) === 0) {
      user.m_nCartCount--;
    }
    const first = user.m_anCart[user.m_nCartCount];
    if (!first) {
      // Zero/malformed carts index outside the native fixed array. Reject that
      // undefined path without leaving the port's user permanently cart-busy.
      user.m_fCartProcessing = 0;
      return;
    }
    first.cnt = (first.cnt - 1) | 0;
    this.PurchaseCartList(user);
  }

  /** CMainPool::PurchaseCartList — consume the cart from its highest index. */
  PurchaseCartList(user: CUser): void {
    for (;;) {
      const entry = user.m_anCart[user.m_nCartCount];
      if (!entry) {
        user.m_fCartProcessing = 0;
        return;
      }
      this.OnReqPurchaseStockItem(user, entry.stockSN);
      const item = CItemMan.ms_pInstance!.GetShopItem(entry.stockSN);
      if (item === null || item.MoneyType === 0) return; // billing entry pauses this native walk
      user.ResetTranxInfo();

      if (entry.cnt <= 0) user.m_nCartCount--;
      if (user.m_nCartCount < 0) {
        // Native clears user+0xBF0 before client 215 [E1 9][E1 0][8B date].
        user.m_fCartProcessing = 0;
        if (user.m_pSocket) {
          const p = new CSendPacket(S2C_ShopPacket.OnPurchaseCartListRes, CipherDegree.kPacketEncryptedCRC8);
          p.Encode1(CART_RECEIPT_CODE);
          p.Encode1(CART_RECEIPT_RESULT);
          p.EncodeBuffer(EncodeVariantTime(new Date()));
          user.m_pSocket.SendPacket(p);
        }
        user.ResetTranxInfo();
        return;
      }
      const next = user.m_anCart[user.m_nCartCount]!;
      next.cnt = (next.cnt - 1) | 0;
    }
  }

  /** CMainPool::OnReqDigiQAuthorization (00416B80) — client 224.
   * Check selected user/+20 BEFORE reading the two client EStr fields.
   * The third billing string is copied from the character's C-string name.
   */
  OnReqDigiQAuthorization(n: CReceivedPacket, socket: CClientSocket): void {
    const user = socket.GetUser(socket.m_nSelectedUserIdx);
    if (!user || user.m_fTranxInProgress !== 0) return;
    const account = n.DecodeStr();
    const password = n.DecodeStr();
    const name = user.GetName().split("\0", 1)[0]!;
    CBillingProcess.ms_pInstance?.RequestDigiQAuthorization(account, password, name);
  }

  /** CMainPool::OnRequestTranxData — client 225 [E2 year][E2 month][E2 day][E4 offset]
   *  → CTranxCtrl::GetData → 211 [E2 len][bytes][E4 nextOffset]. */
  OnRequestTranxData(n: CReceivedPacket, socket: CClientSocket): void {
    const year = n.Decode2();
    const month = n.Decode2();
    const day = n.Decode2();
    const offset = n.Decode4();
    const user = socket.GetUser(socket.m_nSelectedUserIdx);
    if (!user) return;
    const buf = new Uint8Array(TRANSACTION_PAGE_BYTES);
    const page = CTranxCtrl.ms_pInstance!.GetData(year, month, day, buf, offset);
    const p = new CSendPacket(S2C_ShopPacket.OnTranxData, CipherDegree.kPacketEncryptedCRC8);
    p.Encode2(page.length);
    p.EncodeBuffer(buf.subarray(0, page.length), page.length);
    p.Encode4(page.nextOffset);
    socket.SendPacket(p);
  }

  /** CMainPool::OnRequestShopSvrInfo — client 226 → client 212
   *  (CCenterProcess::MakeShopInfoPacket, FxShop.exe.c:3923):
   *  [E4 count][count×(E4 ip, E4 port)] — the port is READ as the stored u16
   *  but ENCODED as an E4.  The list is what the center pushed as CM 6. */
  OnRequestShopSvrInfo(_n: CReceivedPacket, socket: CClientSocket): void {
    const center = CCenterProcess.ms_pInstance!;
    const p = new CSendPacket(S2C_ShopPacket.OnShopSvrInfo, CipherDegree.kPacketEncryptedCRC8);
    p.Encode4(center.m_nSvrCount);
    for (let i = 0; i < center.m_nSvrCount; i++) {
      p.Encode4(center.m_anSvrIP[i]!);
      p.Encode4(center.m_anSvrPort[i]!);
    }
    socket.SendPacket(p);
  }

  /** CMainPool::OnVerifyKey — the web mall charge handshake (9802).
   * [E4 serial][E4 key] → a raw little-endian int: 1 ok, -3 unmatched,
   * -4 absent/busy. user+20 is the only state gate; success does not bind or
   * consume the key, so later verification requests can validate it again. */
  OnVerifyKey(n: CReceivedPacket, socket: CWebSocket): void {
    const serial = n.Decode4();
    const key = n.Decode4();
    const user = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(serial);
    let result: number;
    if (!user || user.m_fTranxInProgress !== 0) {
      result = CHARGE_VERIFY_RESULT.Unavailable;
      console.log("[Shop] ChargeKey failed..");
    } else if (user.m_nChargeKey === key) {
      result = CHARGE_VERIFY_RESULT.Success;
    } else {
      result = CHARGE_VERIFY_RESULT.KeyMismatch;
      console.log(`[Shop] ChargeKey unmatched.. ${user.GetName()}`);
    }
    const reply = new ArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    new DataView(reply).setInt32(0, result, true);
    socket.SendBuffer(reply);
  }
}

// FxShop.exe lpszFormat_ @0x47EC48 — 已持有或收到此道具%d個以上，無法再購入
// (Big5, embedded as latin1 so the wire bytes are the original ANSI bytes)
const LIMIT_FORMAT_HEAD =
    "\xa4\x77\xab\xf9\xa6\xb3\xa9\xce\xa6\xac\xa8\xec\xa6\xb9\xb9\x44\xa8\xe3";
const LIMIT_FORMAT_TAIL =
    "\xad\xd3\xa5\x48\xa4\x57\xa1\x41\xb5\x4c\xaa\x6b\xa6\x41\xc1\xca\xa4\x4a";

function formatLimit(limit: number): string {
  return LIMIT_FORMAT_HEAD + String(limit) + LIMIT_FORMAT_TAIL;
}
