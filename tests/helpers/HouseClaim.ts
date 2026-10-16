import { randomUUID } from "node:crypto";
import { CSendPacket } from "../../Common/CSendPacket.ts";
import type {
  CDBMan,
  HouseClaimSubmission,
  GameResultSubmission,
} from "../../FXGS/CDBMan.ts";
import {
  PlanTakeHouse,
  MakeTakeHousePacket,
  type HouseCell,
  type HouseDropRequest,
} from "../../FXGS/HouseClaim.ts";
import { Received } from "./Clients.ts";
import {
  NativeMoneyEnvironment,
  type NativeMoneyFixture,
} from "./MoneyPickup.ts";
import vectors from "../fixtures/house-claim-vectors.json";

export type HouseVector = (typeof vectors.Cases)[number];
export const NativeHouseEnvironment = NativeMoneyEnvironment;
export type NativeHouseFixture = NativeMoneyFixture;
/** Independent request spelling, not MakeTakeHouseRequest, for handler tests. */
export function HouseRequest(
  slot = 1,
  cells: readonly HouseCell[] = [
    [0, 0],
    [0, 1],
  ],
  drops: readonly HouseDropRequest[] = [],
): CSendPacket {
  const p = new CSendPacket(161).Encode1(slot).Encode1(cells.length);
  for (const [row, column] of cells) p.Encode1(row).Encode1(column);
  p.Encode1(drops.length);
  for (const [a, b, c] of drops) p.Encode1(a).Encode1(b).Encode1(c);
  return p;
}
export function SendHouse(
  e: NativeHouseFixture,
  slot = 1,
  cells: readonly HouseCell[] = [
    [0, 0],
    [0, 1],
  ],
  drops: readonly HouseDropRequest[] = [],
): void {
  e.table.OnPacket(
    Received(HouseRequest(slot, cells, drops)),
    e.room.m_rgPlayer[slot]!.m_pClientSocket!,
  );
}
export function HouseReceiptCount(db: CDBMan): number {
  return db.session.db
    .query<{ n: number }, []>("SELECT count(*) AS n FROM RuntimeHouseClaim")
    .get()!.n;
}
export function HouseSubmission(
  row: HouseVector = vectors.Cases.find((r) => r.Safe && r.Delta > 0)!,
  id = "HouseUser",
): HouseClaimSubmission {
  const plan = PlanTakeHouse(
      {
        States: row.StatesBefore,
        Counts: row.CountsBefore,
        NextBoxItem: row.Next,
      },
      row.Slot,
      row.Color,
      row.Cells as unknown as HouseCell[],
      row.Drops as unknown as HouseDropRequest[],
    ),
    before = { ID: id, Money: row.Money, Exp: 1200, Win: 7, Draw: 8, Lose: 9 };
  return {
    RoundID: randomUUID(),
    ClaimSequence: 1,
    ChannelIndex: 0,
    SessionIndex: 17,
    SessionSerialNo: 91,
    StartTick: 100,
    GlobalSerialNo: 1000 + row.Slot,
    Plan: plan,
    Before: before,
    After: { ...before, Money: row.MoneyAfter },
    Packet: MakeTakeHousePacket(plan).GetBuffer(),
  };
}
export function SeedHouseUser(db: CDBMan, input: HouseClaimSubmission): void {
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
export function EmptyHouseResult(
  input: HouseClaimSubmission,
): GameResultSubmission {
  const p = new CSendPacket(163)
    .Encode1(0)
    .Encode1(255)
    .Encode1(0)
    .Encode1(0)
    .Encode1(0);
  for (let i = 0; i < 8; i++) p.Encode1(0);
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
    Packet: p.GetBuffer(),
  };
}
export function HouseLive(e: NativeHouseFixture) {
  return {
    Users: e.room.m_rgPlayer.map(
      (u) =>
        u && [
          u.GetGlobalSerialNo(),
          u.GetAuthencode(),
          u.GetDynamicInfoSnapshot(),
        ],
    ),
    Tuples: e.clients.map((p) =>
      p.m_aUser.map((u) => [
        u.m_nSessionIdx,
        u.m_nSessionSerialNo,
        u.m_nSlotIdx,
      ]),
    ),
    Slots: e.room.m_rgSlotInfo.map((s) => s.toString("hex")),
    States: [...e.room.m_aPlayerState],
    Context: JSON.stringify(e.room.GetCurrentGameContext()),
    Calculator: e.room.m_dynInfoCalculator.GetStateBytes().toString("hex"),
    Launch: e.room.GetGameLaunchState(),
    LastUpdate: e.room.GetLastUpdateTime(),
    Start: e.clock.GetStartGameTime(),
    End: e.clock.GetEndGameTime(),
    Stopped: e.clock.m_dwTimeStopped,
    Dirty: e.room.m_nModified,
    Stage: e.room.m_nGameState,
    Playing: e.room.m_bPlaying,
    Ghosts: [
      e.room.m_nGhostCount,
      ...e.room.m_anSlotGhost,
      ...e.room.m_anGhostSlot,
    ],
    Sync: e.room.m_syncGameObjMan.GetObjectCount(),
    Key: e.room.GetResultRoundID(),
  };
}
