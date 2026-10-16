import { randomUUID } from "node:crypto";
import { CSendPacket } from "../../Common/CSendPacket.ts";
import type { CItemAttr } from "../../FXGS/CItemAttr.ts";
import { GameStage } from "../../Common/OfficialValues.ts";
import type { CDBMan, MoneyPickupSubmission } from "../../FXGS/CDBMan.ts";
import {
  GameLaunchFixture,
  LaunchReadyPacket,
  DiscoverLaunchPeer,
} from "./GameLaunch.ts";
import { Received } from "./Clients.ts";
import vectors from "../fixtures/item-pickup-vectors.json";

export type MoneyVector = (typeof vectors.MoneyPreviews)[number];
/** Trusted SQLite fixture, NOT a spawn/position/actor authorization service. */
export function MoneySubmission(
  row: MoneyVector = vectors.MoneyPreviews[0]!,
): MoneyPickupSubmission {
  const before = {
    ID: `Wallet${row.Slot}`,
    Money: row.Before,
    Exp: 1200,
    Win: 7,
    Draw: 8,
    Lose: 9,
  };
  return {
    RoundID: randomUUID(),
    ClaimSequence: 1,
    ChannelIndex: 0,
    SessionIndex: 17,
    SessionSerialNo: 91,
    StartTick: 100,
    Slot: row.Slot,
    GlobalSerialNo: 1000 + row.Slot,
    BoxIndex: row.Box,
    ItemIndex: row.Item,
    Authencode: row.Authencode,
    AmountParameter: row.Amount,
    Multiplier: row.Multiplier,
    Delta: row.Delta,
    DiagnosticAmountExceeded: row.DiagnosticAmountExceeded,
    Before: before,
    After: { ...before, Money: row.After },
    Packet: Buffer.from(row.Response, "hex"),
  };
}
export function SeedMoneyUser(db: CDBMan, input: MoneyPickupSubmission): void {
  const d = input.Before;
  db.session.db
    .query(
      "INSERT INTO FxUserAccount(ID,UserHashNo,Password) VALUES(?,?,'disabled-test-fixture')",
    )
    .run(d.ID, db.GetUserHashNo(d.ID));
  db.session.db
    .query(
      "INSERT INTO FxUserDynamic(ID,Money,Exp,Win,Draw,Lose,TicketDate) VALUES(?,?,?,?,?,?,12345)",
    )
    .run(d.ID, d.Money, d.Exp, d.Win, d.Draw, d.Lose);
}
export function NativeMoneyEnvironment(
  items?: CItemAttr,
  counts: readonly number[] = [2, 1],
) {
  const n = counts.reduce((a, b) => a + b, 0),
    names =
      n === 3
        ? ["Alice", "Partner", "Bob"]
        : Array.from({ length: n }, (_, i) => `Native${i}`);
  const e = GameLaunchFixture(counts, undefined, () => 1, 100, undefined, {
    UserNames: names,
    ...(items ? { Items: items } : {}),
  });
  e.table.OnPacket(Received(new CSendPacket(106)), e.clients[0]!);
  for (const [i, peer] of e.clients.entries()) {
    if (!DiscoverLaunchPeer(e.room, peer, 42000 + i))
      throw new Error("Fixture discovery failed");
    e.table.OnPacket(Received(LaunchReadyPacket(e.room, peer)), peer);
  }
  if (
    e.room.m_nGameState !== GameStage.Running ||
    !e.room.GetGameLaunchState().NativeLaunch
  )
    throw new Error(
      "Money fixture MUST launch through real106/discovery/109/150",
    );
  e.clear();
  return e;
}
export type NativeMoneyFixture = ReturnType<typeof NativeMoneyEnvironment>;
export function SendMoney(
  e: NativeMoneyFixture,
  slot = 1,
  box = 0,
  item = 25,
): void {
  e.table.OnPacket(
    Received(new CSendPacket(144).Encode1(slot).Encode1(box).Encode1(item)),
    e.room.m_rgPlayer[slot]!.m_pClientSocket!,
  );
}
export function MoneyReceiptCount(db: CDBMan): number {
  return db.session.db
    .query<{ n: number }, []>("SELECT count(*) AS n FROM RuntimeMoneyPickup")
    .get()!.n;
}
export function SubmitMoneyRoundClaims(e: NativeMoneyFixture): void {
  // Native event4 deaths followed by the surviving team's event6 claims.
  e.table.OnPacket(
    Received(
      new CSendPacket(146)
        .Encode1(0x42)
        .Encode2(0)
        .Encode2(0)
        .Encode1(0xff)
        .Encode1(0),
    ),
    e.clients[1]!,
  );
  for (const slot of [0, 1])
    e.table.OnPacket(
      Received(
        new CSendPacket(146)
          .Encode1(0x60 | slot)
          .Encode2(0)
          .Encode2(0),
      ),
      e.clients[0]!,
    );
}
