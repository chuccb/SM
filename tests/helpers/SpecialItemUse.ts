import { randomUUID } from "node:crypto";
import { CSendPacket } from "../../Common/CSendPacket.ts";
import type { _USERINVENTORY } from "../../Common/DB/Rows.ts";
import type {
  CDBMan,
  SpecialItemUseSubmission,
  GameResultSubmission,
} from "../../FXGS/CDBMan.ts";
import { Received } from "./Clients.ts";
import {
  NativeMoneyEnvironment,
  type NativeMoneyFixture,
} from "./MoneyPickup.ts";
import { HouseLive } from "./HouseClaim.ts";
import vectors from "../fixtures/special-item-use-vectors.json";

export type SpecialVector = (typeof vectors.Cases)[number];
export const NativeSpecialEnvironment = NativeMoneyEnvironment;
export type NativeSpecialFixture = NativeMoneyFixture;
/** Independent client spelling: do not call production special-item encoders. */
export function SpecialRequest(
  slot = 1,
  index = 44,
  quantity = 1,
  sn = 0x12345678,
  x = 0x80ff,
  y = 0xff80,
  opaque = 90,
): CSendPacket {
  const p = new CSendPacket(146)
    .Encode1(slot)
    .Encode2(x)
    .Encode2(y)
    .Encode1(opaque)
    .Encode1(index)
    .Encode1(quantity);
  if (quantity > 0) p.Encode4(sn);
  return p;
}
export function SendSpecial(
  e: NativeSpecialFixture,
  slot = 1,
  index = 44,
  quantity = 1,
  sn = 0x12345678,
): void {
  e.table.OnPacket(
    Received(SpecialRequest(slot, index, quantity, sn)),
    e.room.m_rgPlayer[slot]!.m_pClientSocket!,
  );
}
export function SpecialReceiptCount(db: CDBMan): number {
  return db.session.db
    .query<{ n: number }, []>("SELECT count(*) AS n FROM RuntimeSpecialItemUse")
    .get()!.n;
}
/** Fixture stock ONLY. These are not inventory pickup/shop/equip gameplay.
 * Full network integration seeds SQL BEFORE the genuine connection loads it. */
export function SeedSpecialInventory(
  e: NativeSpecialFixture,
  slot = 1,
  amount = 3,
): _USERINVENTORY {
  const user = e.room.m_rgPlayer[slot]!;
  e.session.db
    .query(
      "INSERT INTO FxUserInventory(SN,ID,ItemID,Slot,Amount,ExpireDate,Verbose,CreatedAt) VALUES(?,?,?,?,?,?,?,?)",
    )
    .run(
      0x12345678,
      user.GetName(),
      0xfedcba98,
      255,
      amount,
      0,
      "opaque-description",
      12345,
    );
  user.m_aInventory = e.db.LoadInventory(user.GetName());
  return user.m_aInventory[0]!;
}
export function SpecialLive(e: NativeSpecialFixture) {
  return {
    ...HouseLive(e),
    Shop: [...e.room.m_aShopItemAttempted],
    Inventories: e.room.m_rgPlayer.map(
      (u) => u?.GetInventoryStateSnapshot() ?? null,
    ),
  };
}
export function SpecialSubmission(
  row: SpecialVector = vectors.Cases.find(
    (r) =>
      r.ItemIndex === 45 &&
      r.Slot === 1 &&
      r.PlayerState === 3 &&
      r.Quantity === 1 &&
      r.ChannelType === 0,
  )!,
  id = "StockUser",
): SpecialItemUseSubmission {
  if (row.ModernStatus !== "relayed" || !row.Quantity || row.Type === null)
    throw new Error("Paid safe model required");
  return {
    RoundID: randomUUID(),
    UseSequence: 1,
    ChannelIndex: 0,
    SessionIndex: 17,
    SessionSerialNo: 91,
    StartTick: 100,
    ChannelType: 0,
    GlobalSerialNo: 1000 + row.Slot,
    Request: {
      Slot: row.Slot,
      X: row.X,
      Y: row.Y,
      Opaque: row.Opaque,
      ItemIndex: row.ItemIndex,
      Quantity: row.Quantity,
      InventorySN: row.InventorySN,
    },
    ItemType: row.Type,
    PlayerState: row.PlayerState,
    RefreshStateTime: row.NativeRefreshTime ? 0xfffffff0 : null,
    Before: {
      SN: row.InventorySN,
      ID: id,
      ItemID: 0xfedcba98,
      Slot: 255,
      Amount: row.BeforeAmount,
      ExpireDate: 1,
      Verbose: "opaque-description",
      CreatedAt: 12345,
    },
    AfterAmount: row.BeforeAmount - row.Quantity,
    Packet: Buffer.from(row.NativeResponse!, "hex"),
  };
}
export function SeedSpecialUser(
  db: CDBMan,
  input: SpecialItemUseSubmission,
): void {
  const r = input.Before;
  db.session.db
    .query(
      "INSERT INTO FxUserAccount(ID,UserHashNo,Password) VALUES(?,?,'disabled-test-fixture')",
    )
    .run(r.ID, db.GetUserHashNo(r.ID));
  db.session.db
    .query(
      "INSERT INTO FxUserDynamic(ID,Money,Exp,Win,Draw,Lose,TicketDate) VALUES(?,17,1200,7,8,9,12345)",
    )
    .run(r.ID);
  db.session.db
    .query(
      "INSERT INTO FxUserInventory(SN,ID,ItemID,Slot,Amount,ExpireDate,Verbose,CreatedAt) VALUES(?,?,?,?,?,?,?,?)",
    )
    .run(
      r.SN,
      r.ID,
      r.ItemID,
      r.Slot,
      r.Amount,
      r.ExpireDate,
      r.Verbose,
      r.CreatedAt,
    );
}
export function EmptySpecialResult(
  input: SpecialItemUseSubmission,
): GameResultSubmission {
  const packet = new CSendPacket(163)
    .Encode1(0)
    .Encode1(255)
    .Encode1(0)
    .Encode1(0)
    .Encode1(0);
  for (let i = 0; i < 8; i++) packet.Encode1(0);
  return {
    RoundID: input.RoundID,
    ChannelIndex: input.ChannelIndex,
    SessionIndex: input.SessionIndex,
    SessionSerialNo: input.SessionSerialNo,
    StartTick: input.StartTick,
    ElapsedMilliseconds: 100,
    WinningColor: -1,
    Reason: "timeout",
    InvalidGame: false,
    CountedSlots: [],
    Changes: [],
    Packet: packet.GetBuffer(),
  };
}
