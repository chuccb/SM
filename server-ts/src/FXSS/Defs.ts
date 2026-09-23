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

/** prGetUserCartList / prAddUserCartList parameter widths.
 *  @ID is 0x10 (0040A33A / 0040A53F). @StockSN is 0x46 (0040A34B / 0040A554). */
export const CART_USER_ID_BYTES = 0x10;
export const CART_LIST_BYTES = 0x46;

/** CDBMan::InitUserCart (0040A399, magic 0x24924925) — strlen(output) / 7. */
export const CART_LIST_COUNT_DIVISOR = 7;

/** CDBMan::AddCartList (0040A5D7, magic 0xCCCCCCCD) — strlen / 5. */
export const CART_ADD_COUNT_DIVISOR = 5;

/** Client 204 OnPurchaseRes error codes — native FxShop 204 handler.
 *  1 generic, 3 unregistered, 4 already owned, 5 gift failure,
 *  6 gift limit over, 7 under age, 8 not ready, 11 owned limit reached. */
export const PURCHASE_RESULT = {
  Success: 0,
  GenericFailure: 1,
  UnregisteredUser: 3,
  AlreadyOwned: 4,
  GiftFailure: 5,
  GiftLimitOver: 6,
  GiftUnderAge: 7,
  NotReady: 8,
  OwnedLimitReached: 11,
} as const;

/** Billing orphan marker used in 321 when user not found or busy (0xFFFFFFFF). */
export const BILLING_ORPHAN_STOCK = 0xffffffff;

/** Billing 321 result (00404297 / 004042A5 / 00404343). */
export const PURCHASE_CONFIRM = {
  Charge: 0,
  Refuse: 1,
  Absent: 2,
} as const;

/** Client 208 OnUseCouponRes codes — native FxShop 208.
 *  0 success, 7 generic coupon failure (local/unsupported/unregistered), 8 billing-side failure. */
export const COUPON_RESULT = {
  Success: 0,
  Invalid: 7,
  BillingFailure: 8,
} as const;

/** CDBMan::AddPreInventory @Type 200. Gift purchase (00409041) and coupon present share it. */
export const PRESENT_PREINVENTORY_TYPE = 200;

/** Coupon grant constants — native OnCheckCoupon 00403150. */
export const COUPON_PREINVENTORY_TYPE = PRESENT_PREINVENTORY_TYPE;
export const COUPON_STOCK_SN = 10;
export const COUPON_BILLING_SUCCESS = 0;
export const COUPON_BILLING_SUCCESS_ALT = 3;

/** Gift pre-inventory cap that surfaces the native -2 path. */
export const GIFT_PREINVENTORY_LIMIT = 100;

/** prAddPreInventory's gift-cap return. A refused gift stores it in TranxResult; a later 312 reads it. */
export const GIFT_LIMIT_RESULT = -2;

/** CBillingProcess — native constants from FxShop.exe.c:479 / 1548 / 1780. */
export const BILLING_GAME = 4;
export const BILLING_CONNECT_SLEEP_MS = 0x3e8; // 1000 ms
export const BILLING_TERMINATE_THRESHOLD = 10_000;
export const BILLING_RECONNECT_TICKS = 0x28; // 40
export const BILLING_RTT_TICKS = 0x5dc; // 1500
