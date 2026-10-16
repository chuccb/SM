import { SessionLimit } from "./OfficialValues.ts";

/** Modern operational limits. These are NOT claimed to be original game constants. */
export const RuntimePolicy = {
  MaxBufferedReceiveBytes: 128 * 1024,
  MaxBufferedSendBytes: 256 * 1024,
  MaxSmartStreamBytes: 4 * 1024 * 1024,
  MaxPacketsPerSecond: 250,
  IdleTimeoutSeconds: 120,
  SessionTransferTimeoutMs: 30_000,
  PasswordHash: {
    algorithm: "argon2id",
    memoryCost: 19_456,
    timeCost: 2,
  } as const,
  MaxPasswordBytes: 128,
  MaxChatInputBytes: 1000,
  // OnEventItem149's log-only label: modern bound, not a native item-name size.
  MaxEventItemNameBytes: 1024,
  MaxGreetingBytes: 1024,
  // Defensive resource parse bound; NOT a recovered native ship-array capacity.
  MaxShipAttributeRows: 4096,
  // Modern all-or-nothing dynamic-write helper; one ordinary room at a time.
  MaxDynamicBatchUsers: SessionLimit.Players,
  MaxPlayersPerChannel: 2048,
  MaxConnectionsPerService: 2048,
  MaxConnectionsPerIP: 16,
  MaxAccountsPerMinutePerIP: 5,
  MaxRelayDatagramsPerSecond: 4000,
  // Per GS: discovery only; no unauthenticated endpoint reflection or host map.
  MaxGameUDPDatagramsPerSecond: 2000,
  MaxGameUDPDatagramsPerSecondPerIP: 32,
  MaxGameUDPSourceIPs: 4096,
  MaxRelayHosts: 8192,
  MaxRelayBytesPerSecondPerHost: 64 * 1024,
  MaintenanceIntervalMs: 5000,
  BusyTimeoutMs: 5000,
  // Startup WAL pragma ONLY: backoff within ONE BusyTimeoutMs budget, not SQL replay.
  SQLiteJournalModeRetryDelayMs: 10,
  // Modern durable result receipt; never a client protocol or original table.
  GameResultReceiptVersion: 1,
  MaxGameResultReceiptBytes: 32 * 1024,
  // Native money arithmetic is preserved; these receipt limits are modern.
  MoneyPickupReceiptVersion: 1,
  MaxMoneyPickupReceiptBytes: 4 * 1024,
  HouseClaimReceiptVersion: 1,
  MaxHouseClaimReceiptBytes: 32 * 1024,
  SpecialItemUseReceiptVersion: 1,
  MaxSpecialItemUseReceiptBytes: 32 * 1024,
  MaxInventoryVerboseBytes: 4096,
  // Modern import/string limits, NOT recovered SQL varchar lengths or prices.
  MaxUserItemDefinitions: 0xffff,
  MaxUserItemAttributeBytes: 4096,
  MaxUserItemNameBytes: 4096,
  LegacyUserItemTemplateBytes: 255,
  // Native expired rows do NOT count toward400. Bound trusted read-side
  // projection work explicitly; not a recovered SQL LIMIT/rowset capacity.
  MaxNativeInventoryLoadRows: 65_536,
  // Native30 counts successful loads, not fetched rows. Bound pure projection
  // work separately; these strings/work limits are NOT recovered SQL widths.
  MaxNativePreInventoryLoadRows: 65_536,
  MaxPreInventoryDescriptionBytes: 4096,
  MaxPreInventoryAttributeBytes: 4096,
  SchemaVersion: 6,
} as const;

/** Modern SQLite Unix-second/no-expiry -> OLE DATE wire bridge. These are
 * standard epoch units, NOT recovered native CTime/DateCreated semantics. */
export const InventoryDateBridge = {
  SecondsPerDay: 86_400,
  UnixEpochVariantDays: 25_569,
  NoExpiryVariantTime: 0,
} as const;
