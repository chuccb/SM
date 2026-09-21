/** Port-only declaration module for FxShop native constants.
 *
 * CUser::SetNexonClubId (FxShop 0041FC60): exact case-sensitive byte pattern.
 * The native erase length is the pattern's byte length, NOT a parsed domain.
 */
export const NEXONCLUB_EMAIL_DOMAIN = "@nexonclub.com";

/** CDBMan::AddNewInventory(user), 00408D10 / 00408D26.
 * Zero stock validity maps to these native expiry sentinels. Despite their
 * names, DateCreated / LevelCreated are expiry time / expiry level in GS.
 */
export const SHOP_PERMANENT_VALIDITY_DAYS = 100_000;
export const SHOP_PERMANENT_EXPIRY_LEVEL = 2000;

/** CUser constructor / SetChargeKey (004200E8 / 0041EE93): the exact
 * modulo operand and additive base in `rand() % 100000 + 1`. This CRT's
 * RAND_MAX is 32767, so currently emitted keys are 1..32768. */
export const CHARGE_KEY_MODULUS = 100_000;
export const CHARGE_KEY_MIN = 1;

/** CMainPool::OnVerifyKey raw int32 reply values (004158E0). */
export const CHARGE_VERIFY_RESULT = {
  Success: 1,
  KeyMismatch: -3,
  Unavailable: -4,
} as const;

/** CMainPool::PurchaseCartList's client-215 two-byte result prefix. */
export const CART_RECEIPT_CODE = 9;
export const CART_RECEIPT_RESULT = 0;

/** CTranxCtrl::GetData / client 225 response page capacity. */
export const TRANSACTION_PAGE_BYTES = 500;
