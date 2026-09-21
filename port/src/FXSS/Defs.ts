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

/** CTranxCtrl::GetData / client 225 response page capacity. */
export const TRANSACTION_PAGE_BYTES = 500;
