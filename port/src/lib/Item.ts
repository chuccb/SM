/** Shared item limits and category meanings verified in FxServer/FxShop and
 * CAItem. These TS labels describe native values; no recovered enum names
 * are claimed. Keep the server's row budget distinct from purchase policy. */
export const USER_INVENTORY_LOAD_LIMIT = 400; // InitUserInventory 0040AF55
export const INVENTORY_SLOT_NONE = 0xff; // DB Slot byte, not FxItem.nAttr2
export const SLOT_DECORATION_COUNT = 9;
export const CHAR_DECO_COUNT = 5;
export const ItemCategory = {
  Functional: 2,
  Emotion: 3,
  EnterEffect: 4,
  LevelIcon: 5,
  LevelChanger: 6,
  SlotDecoration: 10,
  CharDeco: 12,
  Bomb: 14,
} as const;

/** Resource names passed to native HasFunctionalItem, also present verbatim
 * in CAItem.FxItem.strAttr. They are identifiers, not localized item titles. */
export const FunctionalItem = {
  RoomTicket: "Item/RoomTicket",
  SuperChief: "Item/SuperChief",
  BanReflex: "Item/BanReflex",
} as const;
