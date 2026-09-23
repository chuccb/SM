/** Native source unit: FX/FxShop/User.cpp. */
import { CRand } from "../core/CRand.ts";
import { CSendPacket } from "../core/Packet.ts";
import { EncodeVariantTime } from "../core/VariantTime.ts";
import { CDynInfoCalculator_GetLevel } from "../common/LevelTable.ts";
import { CHARGE_KEY_MIN, CHARGE_KEY_MODULUS, NEXONCLUB_EMAIL_DOMAIN } from "./Defs.ts";
import type { CClientSocket } from "./ClientSocket.ts";
import { CMainSystem } from "./MainSystem.ts";
import type { _USERACCOUNT, UserInventory, CouponMap } from "./Recordsets.ts";

/** Four dwords copied from the OnPurchaseOKTw stack record.
 * Rollback reads ItemSN, PreInventorySN, the stack flag, and the amount delta. */
export interface DBTranxInfo {
  ItemSN: number;
  PreInventorySN: number;
  IsNew: number;
  Amount: number;
}

// ============================ CUser ============================

/** CUser — the shop-side user (0xC30 bytes in the original; fully models
 *  native transaction structures and member variables). */
export class CUser {
  /** CRT default state before CApp/CThread calls srand. This fallback keeps
   * isolated CUser construction faithful; the running service uses the
   * logical worker stream owned by CMainSystem. */
  static readonly #defaultRandom = new CRand();

  m_strName = ""; // CNamedObject (lowercased index key)
  m_nGlobalSerialNo = 0;
  m_pSocket: CClientSocket | null = null; // +3092 (dword 773)
  m_nAuthenCode = 0; // +3116 (byte) — the CM 2 authencode (1 → [E1 1][E1 101])
  m_nSID = -1; // +3108 (dword 777) — CUser::GetSID/SetSID (the account SID); set from the
  // client's p7 second dword (FxShop.exe.c:19013) and echoed in MC 3
  m_nBID = -1; // +3112 (dword 778) — CUser::GetBID/SetBID (the SID pair's second dword)
  /** user+0x9A. prGetUserInfoShop writes @CommunitySvr at _USERACCOUNT+130;
   * operator= copies that word here. RequestGift / coupon Encode2 read it
   * (FxShop.exe.lst 00402D06, 00402F44, 004030E4). */
  m_nCommunitySvr = 0;
  m_nCash = 0; // cached FxUserDynamic.Money (game currency, NOT billing cash)
  m_nExp = 0; // +0xAC — dyninfo Exp; CUser::SetLevel and coupon category 101 read it
  m_nBillingCash = 0; // +3104 — CUser::SetCash, independent of FxUserDynamic.Money
  m_nSelectedUserIdx = 0; // socket-side selection
  m_nLevel = 0; // +3100 — CUser::SetLevel (CDynInfoCalculator::GetLevel(Exp))
  m_strNexonClubId = ""; // +0xBC — CUser::SetNexonClubId
  m_vecUserInventory: UserInventory[] = []; // +0xC8 — grows with purchases
  m_fModifiedClient = 0;
  m_nConnCount = 0;

  // ---------------- TranxInfo (+2872..2908, dwords 718..729) ----------------
  // Native TranxInfo starts at +2872 with 7 dwords before the list/string.
  // 718/719 are cleared by ResetTranxInfo and 718 is set to 0 in present/
  // purchase flows (00416F90, 00416076, 0041725B). Their purpose is unused/
  // reserved in observed paths but must be zeroed for faithful reset.
  m_nTranxReserved0 = 0;   // +2872 (dword 718): reserved, always 0 in observed writes
  m_nTranxReserved1 = 0;   // +2876 (dword 719): reserved, only cleared by Reset
  m_nTranxStockSN = 0;     // +2880 (dword 720): stock item SN being transacted
  m_nTranxItemSN = 0;      // +2884 (dword 721): item SN
  m_nTranxAmount = 0;      // +2888 (dword 722): amount/units
  m_nTranxPreSN = 0;       // +2892 (dword 723): pre-inventory SN
  m_nTranxState = 0;       // +2896 (dword 724): transaction state / rollback flag
  m_listTranxInfo: DBTranxInfo[] = []; // +2900 (dword 725): STL list<DBTranxInfo>
  m_strTranxInfo = "";     // +2904 (dword 726..728): transaction reference string
  m_nTranxResult = 0;      // +2916 (dword 729): transaction result code

  // ---------------- CouponTranx (+3008..3044, dwords 752..760) ----------------
  m_strCoupon = "";        // +3008 (dword 752..754): coupon serial string
  m_nCouponID = 0;         // +3020 (dword 755): coupon ID / index
  m_nCouponState = 0;      // +3024 (dword 756): coupon state
  m_listCouponMap: CouponMap[] = []; // +3028 (dword 757): STL list<CouponMap>
  m_strCouponId = "";      // +3032 (dword 758..760): registered user ID for coupon

  constructor(socket: CClientSocket | null) {
    this.m_pSocket = socket;
    this.SetChargeKey();
  }

  GetName(): string {
    return this.m_strName;
  }

  SetName(name: string): void {
    this.m_strName = name;
  }

  GetGlobalSerialNo(): number {
    return this.m_nGlobalSerialNo;
  }

  SetGlobalSerialNo(n: number): void {
    this.m_nGlobalSerialNo = n;
  }

  /** CUser::SetChargeKey (0041EE90); the constructor at 004200E8 consumes
   * the same CRT worker stream with the same modulo expression. */
  SetChargeKey(): void {
    const random = CMainSystem.ms_pInstance?.m_WorkerRandom ?? CUser.#defaultRandom;
    this.m_nChargeKey = random.rand() % CHARGE_KEY_MODULUS + CHARGE_KEY_MIN;
  }

  /** CUser::SetCash (00401460) — signed DWORD at +3104. */
  SetCash(cash: number): void {
    this.m_nBillingCash = cash | 0;
  }

  /** CUser::SetLevel (0041EBB0) — GetLevel of the cached Exp at +0xAC. */
  SetLevel(): void {
    this.m_nLevel = CDynInfoCalculator_GetLevel(this.m_nExp);
  }

  /** CUser::SetNexonClubId (0041FC60): range-based byte search in Email,
   * then erase the last pattern-length bytes, NOT the matched substring.
   * Account strings on this path use the port's raw Latin-1 byte mapping.
   */
  SetNexonClubId(account: _USERACCOUNT): void {
    const email = account.Email;
    this.m_strNexonClubId = email.includes(NEXONCLUB_EMAIL_DOMAIN)
      ? email.slice(0, -NEXONCLUB_EMAIL_DOMAIN.length)
      : "";
  }

  /** CUser::GetNexonClubId (0041F000) returns const char*. Its billing
   * callers construct a string from that C pointer, stopping at the first
   * NUL. Preserve the full stored value; expose its C-string view here.
   */
  GetNexonClubId(): string {
    const end = this.m_strNexonClubId.indexOf("\0");
    return end < 0 ? this.m_strNexonClubId : this.m_strNexonClubId.slice(0, end);
  }

  /**
   * CUser::ResetTranxInfo (0041F170) — strictly mirrors official disassembly:
   * clears TranxInfo and CouponTranx structures and associated state lists.
   */
  ResetTranxInfo(): void {
    // TranxInfo (+2872): 7 dwords + list + string + result — exactly mirrors
    // 0041F170: clears 0B38/0B3C/0B40/0B44/0B48/0B4C/0B50/0B54/0B58/0B64.
    this.m_nTranxReserved0 = 0;
    this.m_nTranxReserved1 = 0;
    this.m_nTranxStockSN = 0;
    this.m_nTranxItemSN = 0;
    this.m_nTranxAmount = 0;
    this.m_nTranxPreSN = 0;
    this.m_nTranxState = 0;
    this.m_nTranxResult = 0;
    this.m_listTranxInfo = [];
    this.m_strTranxInfo = "";

    // CouponTranx (+3008): string, ID, state, list, id string — mirrors
    // 0041F170 tail: 0BC0/0BD8/0BCC/0BD0/0BD4.
    this.m_strCoupon = "";
    this.m_nCouponID = 0;
    this.m_nCouponState = 0;
    this.m_listCouponMap = [];
    this.m_strCouponId = "";
  }

  /** CUser::MakePreInventoryPacket — native empty list shell. */
  MakePreInventoryPacket(packet: CSendPacket): void {
    packet.Encode1(0);
  }

  /** CUser::MakeUserInventoryPacket — native 201 per-user inventory body. */
  MakeUserInventoryPacket(packet: CSendPacket): void {
    packet.Encode4(this.m_vecUserInventory.length);
    for (const inventory of this.m_vecUserInventory) {
      packet.Encode4(inventory.SN);
      packet.Encode1(inventory.Slot);
      packet.Encode4(inventory.ItemSN);
      packet.EncodeStr(inventory.Verbose);
      packet.EncodeBuffer(EncodeVariantTime(inventory.dateAcquired));
    }
  }

  m_fTranxInProgress = 0; // user+20 — the billing-tranx guard (207/210/214/221/222/223/verify)
  m_nChargeKey = 0; // user+3044 (0xBE4) — the OnVerifyKey charge key
  m_fRemainCashRequested = 0; // user+3048 (0xBE8) — set by the 214 handler
  m_fCartProcessing = 0; // user+3056 (0xBF0) — set while a cart purchase walks
  m_pPurchaseTranx: object | null = null; // port-side pending-purchase marker, not a native pointer offset
  m_anCart: { stockSN: number; cnt: number }[] = []; // user+2920 (2 dwords per entry)
  m_nCartCount = 0; // user+3052
  /** user+0xB28 — the cart-list STL string. Not the purchase walk at +2920. */
  m_strCartList = "";
  /** user+0xB34 — InitUserCart's strlen/7, or AddCartList's strlen/5.
   *  Client 214 encodes the low byte; the string is included only when this dword is nonzero. */
  m_nCartListCount = 0;
}
