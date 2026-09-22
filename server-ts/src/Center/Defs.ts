/** Port-only declaration module for Center-local native constants; these are not UserInfo DB shard settings. */

/** CUser::DeferDisconnectTimeout (00415620..00415625): elapsed > 0x445C, not >=. */
export const CONNECTION_TIMEOUT_MS = 17_500;
/** CGlobalUserTable::InsertConnectingList (00408360): unsigned serial % 6. */
export const CONNECTING_LIST_BUCKET_COUNT = 6;
/** CUser ctor / SetFree: no current server index. */
export const SERVER_IDX_NONE = -0x80000000;
/** CTimerThread::Proc (00415020), OnTimer (00414F20). */
export const TIMER_INTERVAL_MS = 400;
export const TIMEOUT_SWEEP_TICKS = 4;
export const SERVER_STATE_BROADCAST_TICKS = 2;
/** CLocalServerMan::SendLocalSvrStatePacket(false): rotating recipients per call. */
export const SERVER_STATE_BROADCAST_BATCH_SIZE = 10;
export const USER_COUNT_REPORT_TICKS = 750;
export const CLOCK_REPORT_TICKS = 1_500;
/** CUser::CheckConnectingToSvr premium gate — server type 41 is the premium channel (enterable only with authencode 1). */
export const PREMIUM_CHANNEL_TYPE = 41;
