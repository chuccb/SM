import vectors from "../fixtures/game-result-vectors.json";
import { CUser } from "../../Common/CUser.ts";
import { CFastFile } from "../../Common/CFastFile.ts";
import { CTextCodec } from "../../Common/CTextCodec.ts";
import { CGameClock } from "../../FXGS/CGameClock.ts";
import {
  CGameSession,
  type GameResultServices,
  type GameSessionRemovalServices,
} from "../../FXGS/CGameSession.ts";
import { CGameMapTmplList } from "../../FXGS/CGameMapTmplList.ts";
import { CBomberAttr } from "../../FXGS/CBomberAttr.ts";
import { CDBMan, type GameResultSubmission } from "../../FXGS/CDBMan.ts";
import { ChannelType, SessionLimit } from "../../Common/OfficialValues.ts";
import { g_nLevel2ExpTable } from "../../Common/Protocol/OfficialTables.ts";
import { UserInfo } from "./Accounts.ts";
import { MemoryClient } from "./Clients.ts";
import { randomUUID } from "node:crypto";

export const NormalResultCase = vectors.Cases.find(
  (r) => r.Name === "normal-w0-t45001",
)!;
export type ResultVector = (typeof vectors.Cases)[number];
const files = new CFastFile();
files.FastFileInit("FXGS/FxServer");
const bombers = new CBomberAttr();
bombers.Load(files);
const maps = new CGameMapTmplList();
maps.CreateTmplList(files);
export const ResultResources = { bombers, maps };
/** Trusted result-tail fixture. NO network start/physics/client evidence. */
export function ResultEnvironment(
  row: ResultVector = NormalResultCase,
  services?: GameResultServices,
  channelType?: number,
  removalServices?: GameSessionRemovalServices,
) {
  let now = 100;
  const clock = new CGameClock(() => now);
  const room = new CGameSession(
    17,
    91,
    "Result lifecycle",
    "",
    0,
    new CTextCodec(),
    bombers,
    maps,
    channelType ??
      (row.PremiumChannel ? ChannelType.Premium : ChannelType.Normal),
    clock,
    services,
    removalServices,
  );
  const peers = new Map<number, MemoryClient>();
  for (let slot = 0; slot < SessionLimit.Players; slot++) {
    const spec = row.Players[slot];
    if (!spec) continue;
    let peer = peers.get(spec.Socket);
    if (!peer) {
      peer = new MemoryClient();
      peers.set(spec.Socket, peer);
    }
    const info = Object.assign(UserInfo(`Result${slot}`), spec.State.Dynamic, {
      Exp: g_nLevel2ExpTable[spec.Level - 1]!,
    });
    const user = new CUser(info, spec.GlobalSerialNo);
    if (spec.State.DynamicModified) user.IncDecExp(0);
    user.SetSimpleInfoModified(spec.State.SimpleInfoModified);
    user.SetFakeLevel(spec.State.FakeLevel);
    user.SetLevelIcon(spec.State.LevelIconEnabled, spec.State.LevelIconSN);
    user.SetAuthenCode(spec.Authencode);
    for (let i = 0; i < spec.State.GamesSinceFlush; i++) user.IncGame();
    info.Exp = spec.State.Dynamic.Exp;
    user.m_pClientSocket = peer;
    peer.m_aUser.push(user);
    user.m_nSlotIdx = slot;
    user.m_nSessionIdx = room.m_nIdx;
    user.m_nSessionSerialNo = room.m_ulSerialNo;
    room.m_rgPlayer[slot] = user;
    room.m_rgSlotInfo[slot]![2] = spec.Color;
  }
  room.PrepareRoundStatistics();
  room.m_dynInfoCalculator.SetHasPremium(row.CalculatorPremium);
  for (let slot = 0; slot < SessionLimit.Players; slot++) {
    for (let i = 0; i < row.KillCounts[slot]!; i++)
      room.m_dynInfoCalculator.SetKillerIndex(0, slot);
    for (let i = 0; i < row.SaveCounts[slot]!; i++)
      room.m_dynInfoCalculator.SetSaverIndex(i, slot);
    room.m_rgSlotInfo[slot]![2] = row.CurrentColors[slot]!;
    room.m_aPlayerState[slot] = row.States[slot]!;
    room.m_aShopItemAttempted[slot] = row.ShopAttempts[slot]!;
    if (row.Departed[slot]) {
      const user = room.m_rgPlayer[slot]!;
      room.m_rgPlayer[slot] = undefined;
      user.m_nSessionIdx = SessionLimit.NoSession;
      user.m_nSessionSerialNo = 0xffffffff;
    }
  }
  return {
    room,
    clock,
    clients: [...peers.values()],
    time: (n: number) => {
      now = n;
    },
  };
}
export function ResultSubmission(row = NormalResultCase): GameResultSubmission {
  return {
    RoundID: randomUUID(),
    ChannelIndex: 0,
    SessionIndex: 17,
    SessionSerialNo: 91,
    StartTick: 100,
    ElapsedMilliseconds: row.Duration,
    WinningColor: row.WinningColor,
    Reason: "claims",
    InvalidGame:
      row.Name === "same-socket-invalid" ||
      row.Name === "single-invalid" ||
      row.Name === "all-empty",
    CountedSlots: [],
    Changes: row.Expected.Players.flatMap((p) =>
      p
        ? [
            {
              Slot: p.Slot,
              GlobalSerialNo: p.GlobalSerialNo,
              Category: p.Category,
              ExperienceDelta: p.ExperienceDelta,
              Before: p.Before.Dynamic,
              After: p.After.Dynamic,
            },
          ]
        : [],
    ),
    Packet: Buffer.from(row.Expected.Packet, "hex"),
  };
}
/** Test-only direct fixture rows, NOT a replacement auth or registration path. */
export function SeedResultUsers(db: CDBMan, input: GameResultSubmission): void {
  for (const { Before: d } of input.Changes) {
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
}
