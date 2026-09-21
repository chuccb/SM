/** Native source unit: FX/FxShop/User.cpp. */
import { CSendPacket } from "../core/Packet.ts";
import { EncodeVariantTime } from "../core/VariantTime.ts";
import { CDynInfoCalculator_GetLevel } from "../shared/LevelTable.ts";
import { NEXONCLUB_EMAIL_DOMAIN } from "./Defs.ts";
import type { CClientSocket } from "./ClientSocket.ts";
import type { CWebSocket } from "./WebSocket.ts";
import type { _USERACCOUNT, _USERDYNINFO, UserInventory } from "./Recordsets.ts";

// ============================ CUser ============================

/** CUser — the shop-side user (0xC30 bytes in the original; only fields the
 *  handlers touch are modeled). */
export class CUser {
  m_strName = ""; // CNamedObject (lowercased index key)
  m_nGlobalSerialNo = 0;
  m_pSocket: CClientSocket | null = null; // +3092
  m_nAuthenCode = 0; // +3116 (byte) — the CM 2 authencode (1 → [E1 1][E1 101])
  m_nSID = -1; // +3108 — CUser::GetSID/SetSID (the account SID); set from the
  // client's p7 second dword (FxShop.exe.c:19013) and echoed in MC 3
  m_nBID = -1; // +3112 — CUser::GetBID/SetBID (the SID pair's second dword)
  m_strCoupon = ""; // +3008 — the client 219 coupon (CMainPool::OnRequestUseCoupon)
  m_strCouponId = ""; // +3032 — the client 219 registered id
  m_strTranxInfo = ""; // +2904 — the per-user transaction string (ResetTranxInfo clears it)
  m_nUserAccountHiword = 0; // +152 = _USERACCOUNT+128 — the billing tail E2 (HIWORD)
  m_nCash = 0; // cached FxUserDynamic.Money (game currency, NOT billing cash)
  m_nBillingCash = 0; // +3104 — CUser::SetCash, independent of FxUserDynamic.Money
  m_nSelectedUserIdx = 0; // socket-side selection
  m_nLevel = 0; // +3100 — CUser::SetLevel (CDynInfoCalculator::GetLevel(Exp))
  m_strNexonClubId = ""; // +0xBC — CUser::SetNexonClubId
  m_vecUserInventory: UserInventory[] = []; // +0xC8 — grows with purchases
  m_fModifiedClient = 0;
  m_nConnCount = 0;

  constructor(socket: CClientSocket | null) {
    this.m_pSocket = socket;
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

  /** CUser::SetCash (00401460) — signed DWORD at +3104. */
  SetCash(cash: number): void {
    this.m_nBillingCash = cash | 0;
  }

  /** CUser::SetLevel — CDynInfoCalculator::GetLevel(dyninfo Exp). */
  SetLevel(dyn: _USERDYNINFO): void {
    this.m_nLevel = CDynInfoCalculator_GetLevel(dyn.Exp);
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

  /** CUser::ResetTranxInfo (0041F170), the native fields modeled here.
   * Cart/connection guards and the separate local settlement marker are NOT
   * reset by this native routine. Native transaction lists remain unmodeled. */
  ResetTranxInfo(): void {
    this.m_strTranxInfo = "";
    this.m_strCoupon = "";
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

  m_fTranxInProgress = 0; // user+20 — the billing-tranx guard (210/214/221/223)
  m_fRemainCashRequested = 0; // user+3048 — set by the 214 handler
  m_fCartProcessing = 0; // user+3056 — set while a cart purchase walks
  m_nChargeKey = 0; // user+2280 — the OnVerifyKey charge key
  m_pChargeSocket: CWebSocket | null = null; // user+12 — bound by OnVerifyKey
  m_pPurchaseTranx: object | null = null; // port-side pending-purchase marker, not a native pointer offset
  m_anCart: { stockSN: number; cnt: number }[] = []; // user+2920 (2 dwords per entry)
  m_nCartCount = 0; // user+3052
}
