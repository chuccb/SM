import { afterEach, expect, test } from "bun:test";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { ServerResponse } from "../Common/Protocol/PacketTypes.ts";
import { CProtocolError } from "../Common/CProtocolError.ts";
import {
  GameStage,
  GamePlayerState,
  GameResultTiming,
  SessionModified,
  IntegerRange,
} from "../Common/OfficialValues.ts";
import { CItemAttr } from "../FXGS/CItemAttr.ts";
import type { MoneyPickupSubmission } from "../FXGS/CDBMan.ts";
import {
  LaunchItems,
  LaunchReadyPacket,
  DiscoverLaunchPeer,
} from "./helpers/GameLaunch.ts";
import {
  NativeMoneyEnvironment,
  SendMoney,
  MoneyReceiptCount,
  SubmitMoneyRoundClaims,
  type NativeMoneyFixture,
} from "./helpers/MoneyPickup.ts";
import { Received } from "./helpers/Clients.ts";
import vectors from "./fixtures/item-pickup-vectors.json";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function create(items?: CItemAttr) {
  const e = NativeMoneyEnvironment(items);
  cleanup.push(e.close);
  return e;
}
function send(e: NativeMoneyFixture, p: CSendPacket, sender = 0) {
  e.table.OnPacket(Received(p), e.clients[sender]!);
}
function noPackets(e: NativeMoneyFixture) {
  for (const p of e.clients) expect(p.packets).toEqual([]);
}
function response(e: NativeMoneyFixture, fields: readonly number[]) {
  for (const peer of e.clients) {
    const p = peer.Take(156);
    expect([p.Decode1(), p.Decode1(), p.Decode1(), p.Decode1()]).toEqual([
      ...fields,
    ]);
    p.AssertEnd();
  }
  e.clear();
}
function live(e: NativeMoneyFixture) {
  return {
    Users: e.room.m_rgPlayer.map(
      (u) =>
        u && [
          u.GetGlobalSerialNo(),
          u.GetAuthencode(),
          u.GetDynamicInfoSnapshot(),
        ],
    ),
    Tuples: e.clients.map((c) =>
      c.m_aUser.map((u) => [
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
function frozenInput(input: MoneyPickupSubmission) {
  return JSON.stringify({
    ...input,
    Packet: Buffer.from(input.Packet).toString("hex"),
  });
}
function fault(e: NativeMoneyFixture) {
  e.session.db.exec(
    "CREATE TRIGGER TestMoneyFailure BEFORE INSERT ON RuntimeMoneyPickup BEGIN SELECT RAISE(FAIL,'fixture money write failure'); END",
  );
}
function repair(e: NativeMoneyFixture) {
  e.session.db.exec("DROP TRIGGER TestMoneyFailure");
}
function onlyMoneyRandom(e: NativeMoneyFixture, draw = 1) {
  let n = 0;
  e.room.m_rgPlayer[1]!.SetAuthenCode(1);
  e.random(() => {
    n++;
    return draw;
  });
  return () => n;
}
function neverClock(e: NativeMoneyFixture) {
  const current = e.clock.GetCurrentTime,
    elapsed = e.clock.ElapsedTime;
  e.clock.GetCurrentTime = () => {
    throw new Error(
      "Frozen pickup MUST retry before absolute clock/timers/results",
    );
  };
  e.clock.ElapsedTime = () => {
    throw new Error("Frozen pickup MUST NOT sample duration");
  };
  return () => {
    e.clock.GetCurrentTime = current;
    e.clock.ElapsedTime = elapsed;
  };
}

// Every environment launches via106/discovery/109/150. Trusted fixture values
// exercise arithmetic/races only; these are NOT official clients or spawn proof.
test("ALL800 frozen real-resource C++ money images now pass the ACTUAL native-round144 ->atomic SQLite ->live wallet/claim ->exact156 path", () => {
  let e: NativeMoneyFixture | undefined;
  for (const [i, row] of vectors.MoneyPreviews.entries()) {
    if (i % 250 === 0) {
      e = create();
      neverClock(e);
    }
    const env = e!,
      user = env.room.m_rgPlayer[row.Slot]!,
      ctx = env.room.GetCurrentGameContext();
    // Explicit trusted fixture arrangement, not client-set money/auth/gender.
    user.m_userInfo.Money = row.Before;
    user.SetAuthenCode(row.Authencode);
    user.m_userInfo.Gender = (row.Authencode + 1) & 255;
    user.m_userInfo.Authority = 23;
    env.session.db
      .query("UPDATE FxUserDynamic SET Money=? WHERE ID=?")
      .run(row.Before, user.GetName());
    const before = user.GetDynamicInfoSnapshot(),
      world = live(env);
    let draws = 0;
    env.random(() => {
      draws++;
      return row.Draw;
    });
    expect(ctx.m_aBoxItemState[row.Box]).toBe(0);
    SendMoney(env, row.Slot, row.Box, row.Item);
    expect(draws).toBe(row.RandomDraws);
    expect(user.GetDynamicInfoSnapshot()).toEqual({
      ...before,
      Dynamic: { ...before.Dynamic, Money: row.After },
      DynamicModified: 1,
    });
    expect(env.db.GetUserInfo(user.GetName())!.Money).toBe(row.After);
    expect(ctx.m_aBoxItemState[row.Box]).toBe(1);
    const state = env.room.GetMoneyPickupState(),
      receipt = env.db.GetMoneyPickupReceipt(
        env.room.GetResultRoundID()!,
        state.Sequence,
      )!;
    expect(state).toEqual({
      Sequence: (i % 250) + 1,
      Pending: false,
      Attempts: (i % 250) + 1,
      Failure: undefined,
    });
    expect(MoneyReceiptCount(env.db)).toBe(state.Sequence);
    expect(receipt.Packet.toString("hex")).toBe(row.Response);
    const body = JSON.parse(receipt.Payload);
    expect([
      body.Before.Money,
      body.After.Money,
      body.Multiplier,
      body.Delta,
      body.DiagnosticAmountExceeded,
    ]).toEqual([
      row.Before,
      row.After,
      row.Multiplier,
      row.Delta,
      row.DiagnosticAmountExceeded,
    ]);
    for (const peer of env.clients)
      expect(peer.packets.map((p) => p.m_pBlock.toString("hex"))).toEqual([
        row.Response,
      ]);
    env.clear();
    const after = live(env);
    expect({ ...after, Users: world.Users, Context: world.Context }).toEqual(
      world,
    );
    // Duplicate validates body/resource/owner but does NOT query SQL or RNG.
    const original = env.db.CommitMoneyPickup;
    env.db.CommitMoneyPickup = () => {
      throw new Error("Claimed duplicate MUST NOT reach SQLite");
    };
    try {
      SendMoney(env, row.Slot, row.Box, row.Item);
    } finally {
      env.db.CommitMoneyPickup = original;
    }
    noPackets(env);
    expect(draws).toBe(row.RandomDraws);
    expect(env.room.GetMoneyPickupState()).toEqual(state);
    expect(
      env.db.GetGameResultReceipt(env.room.GetResultRoundID()!),
    ).toBeUndefined();
  }
});
test("genuine EIGHT-actor/four-socket native room credits room slots0..7 independently; auth BYTE1 alone draws, each durable four-field156 reaches all peers once", () => {
  const e = NativeMoneyEnvironment(undefined, [2, 2, 2, 2]);
  cleanup.push(e.close);
  neverClock(e);
  const auth = [0, 1, 2, 255, 1, 0, 1, 0];
  let draws = 0;
  e.random(() => {
    draws++;
    return 1;
  });
  for (const [slot, code] of auth.entries()) {
    const user = e.room.m_rgPlayer[slot]!;
    user.SetAuthenCode(code);
    SendMoney(e, slot, 249 - slot, 25);
    response(e, [slot, 249 - slot, 25, code === 1 ? 2 : 1]);
    expect(user.m_userInfo.Money).toBe(code === 1 ? 20 : 10);
    expect(e.db.GetUserInfo(user.GetName())!.Money).toBe(code === 1 ? 20 : 10);
    expect(e.room.GetMoneyPickupState().Sequence).toBe(slot + 1);
    expect(
      JSON.parse(
        e.db.GetMoneyPickupReceipt(e.room.GetResultRoundID()!, slot + 1)!
          .Payload,
      ).GlobalSerialNo,
    ).toBe(user.GetGlobalSerialNo());
  }
  expect(draws).toBe(3);
  expect(MoneyReceiptCount(e.db)).toBe(8);
  expect(e.table.GetPendingMoneyPickupCount()).toBe(0);
});
test("10 SYNTHETIC resource definitions exercise the complete coordinator too: diagnostic>10000 is NOT a cap, IMUL can wrap/zero, no-op still claims+receipts", () => {
  for (const row of vectors.SyntheticMoneyPreviews) {
    const items = new CItemAttr();
    items.m_aItemAttr.push(...LaunchItems.m_aItemAttr);
    items.m_aItemAttr[row.Item] = Object.freeze({
      ...items.m_aItemAttr[row.Item]!,
      Type: 99,
      Parameters: Object.freeze([row.Amount, 0, 0, 0, 0]),
    });
    const e = create(items),
      user = e.room.m_rgPlayer[row.Slot]!;
    user.m_userInfo.Money = row.Before;
    user.SetAuthenCode(row.Authencode);
    e.session.db
      .query("UPDATE FxUserDynamic SET Money=? WHERE ID=?")
      .run(row.Before, user.GetName());
    let draws = 0;
    e.random(() => {
      draws++;
      return row.Draw;
    });
    neverClock(e);
    SendMoney(e, row.Slot, row.Box, row.Item);
    expect(draws).toBe(1);
    expect(user.m_userInfo.Money).toBe(row.After);
    expect(user.GetDynamicInfoSnapshot().DynamicModified).toBe(1);
    expect(e.db.GetUserInfo(user.GetName())!.Money).toBe(row.After);
    const receipt = e.db.GetMoneyPickupReceipt(e.room.GetResultRoundID()!, 1)!;
    expect(receipt.Packet.toString("hex")).toBe(row.Response);
    expect(JSON.parse(receipt.Payload).DiagnosticAmountExceeded).toBe(
      row.DiagnosticAmountExceeded,
    );
    for (const peer of e.clients)
      expect(peer.packets.map((p) => p.m_pBlock.toString("hex"))).toEqual([
        row.Response,
      ]);
    expect(MoneyReceiptCount(e.db)).toBe(1);
    expect(e.room.GetMoneyPickupState().Sequence).toBe(1);
  }
});
test("lost SQL acknowledgement + mutated CALLER packet: retry reuses exact frozen key/randomness/Before/After/bytes, credits and publishes ONCE", () => {
  const e = create(),
    draws = onlyMoneyRandom(e),
    before = live(e),
    original = e.db.CommitMoneyPickup,
    inputs: string[] = [];
  e.db.CommitMoneyPickup = function (input) {
    inputs.push(frozenInput(input));
    const status = original.call(this, input);
    if (inputs.length === 1) {
      Buffer.from(
        input.Packet.buffer,
        input.Packet.byteOffset,
        input.Packet.byteLength,
      ).fill(0);
      throw new Error("fixture lost ack AFTER COMMIT");
    }
    return status;
  };
  SendMoney(e);
  expect(live(e)).toEqual(before);
  noPackets(e);
  expect(draws()).toBe(1);
  expect(e.db.GetUserInfo("Partner")!.Money).toBe(20);
  expect(MoneyReceiptCount(e.db)).toBe(1);
  expect(e.room.GetMoneyPickupState()).toEqual({
    Sequence: 0,
    Pending: true,
    Attempts: 1,
    Failure: "storage",
  });
  expect(e.table.GetPendingMoneyPickupCount()).toBe(1);
  expect(e.table.GetPendingResultCount()).toBe(0);
  neverClock(e);
  e.room.Update();
  expect(inputs).toHaveLength(2);
  expect(inputs[0]).toBe(inputs[1]);
  expect(draws()).toBe(1);
  expect(e.room.m_rgPlayer[1]!.m_userInfo.Money).toBe(20);
  expect(e.db.GetUserInfo("Partner")!.Money).toBe(20);
  expect(e.room.GetMoneyPickupState()).toEqual({
    Sequence: 1,
    Pending: false,
    Attempts: 2,
    Failure: undefined,
  });
  expect(e.room.GetLastUpdateTime()).toBe(before.LastUpdate);
  expect(e.table.GetPendingMoneyPickupCount()).toBe(0);
  response(e, [1, 0, 25, 2]);
  SendMoney(e);
  noPackets(e);
  expect(draws()).toBe(1);
  expect(MoneyReceiptCount(e.db)).toBe(1);
});
test("real SQL insertion failures freeze ALL world/timer/result/room-list progress; driver retries before clock and does not consume the delayed frame", () => {
  const e = create(),
    draws = onlyMoneyRandom(e),
    ctx = e.room.GetCurrentGameContext();
  ctx.AddBomb(0x23, 0x11);
  e.room.m_aPlayerState[2] = GamePlayerState.PendingDie;
  ctx.m_aPlayerStateTime[2] = 0;
  e.room.m_nModified |= SessionModified.Title;
  const before = live(e);
  fault(e);
  SendMoney(e);
  expect(live(e)).toEqual(before);
  noPackets(e);
  const restore = neverClock(e);
  e.time(12000);
  for (let i = 0; i < 3; i++) {
    e.table.UpdateGameSessions();
    expect(live(e)).toEqual(before);
    expect(e.notices).toEqual([]);
    noPackets(e);
    expect(e.table.GetPendingMoneyPickupCount()).toBe(1);
    expect(e.table.GetUpdateFailures()).toEqual([]);
    expect(e.room.UpdateResultLifecycle()).toBe(false);
    expect(e.room.DeferHandleGameEnd()).toBe(false);
  }
  expect(draws()).toBe(1);
  expect(e.room.GetMoneyPickupState().Attempts).toBe(4);
  expect(e.db.GetUserInfo("Partner")!.Money).toBe(0);
  expect(MoneyReceiptCount(e.db)).toBe(0);
  repair(e);
  e.table.UpdateGameSessions();
  response(e, [1, 0, 25, 2]);
  expect(e.room.GetLastUpdateTime()).toBe(before.LastUpdate);
  expect(e.room.m_aPlayerState[2]).toBe(GamePlayerState.PendingDie);
  expect(ctx.m_aBomb).toEqual(JSON.parse(before.Context).m_aBomb);
  expect(e.room.GetMoneyPickupState()).toEqual({
    Sequence: 1,
    Pending: false,
    Attempts: 5,
    Failure: undefined,
  });
  restore();
  e.room.Update();
  expect(e.room.GetLastUpdateTime()).toBe(12000);
  expect(e.room.m_aPlayerState[2]).toBe(GamePlayerState.Inactive);
  expect(
    e.clients.every((p) =>
      p.packets.some((b) => b.m_nPacketType === ServerResponse.BomberEvent),
    ),
  ).toBe(true);
});
test("ALL-FIVE CAS conflicts freeze the original calculation; retries never silently rebase or reroll; only explicit original-state repair unfreezes", () => {
  for (const field of ["Money", "Exp", "Win", "Draw", "Lose"] as const) {
    const e = create(),
      draws = onlyMoneyRandom(e),
      before = live(e);
    e.session.db
      .query(`UPDATE FxUserDynamic SET ${field}=${field}+1 WHERE ID='Partner'`)
      .run();
    const original = e.db.CommitMoneyPickup,
      inputs: string[] = [];
    e.db.CommitMoneyPickup = function (input) {
      inputs.push(frozenInput(input));
      return original.call(this, input);
    };
    SendMoney(e);
    expect(live(e)).toEqual(before);
    noPackets(e);
    expect(e.room.GetMoneyPickupState().Failure).toBe("conflict");
    expect(MoneyReceiptCount(e.db)).toBe(0);
    neverClock(e);
    e.room.Update();
    expect(live(e)).toEqual(before);
    noPackets(e);
    expect(draws()).toBe(1);
    expect(new Set(inputs).size).toBe(1);
    e.session.db
      .query(`UPDATE FxUserDynamic SET ${field}=${field}-1 WHERE ID='Partner'`)
      .run();
    e.room.Update();
    response(e, [1, 0, 25, 2]);
    expect(draws()).toBe(1);
    expect(e.room.m_rgPlayer[1]!.m_userInfo.Money).toBe(20);
    expect(e.db.GetUserInfo("Partner")!.Money).toBe(20);
    expect(MoneyReceiptCount(e.db)).toBe(1);
    expect(new Set(inputs).size).toBe(1);
  }
});
test("only EXACT money retry is eligible: whole local group/owner/body/resource validation precedes retry and even claimed-box no-op", () => {
  const e = create(),
    draws = onlyMoneyRandom(e),
    original = e.db.CommitMoneyPickup;
  let calls = 0;
  e.db.CommitMoneyPickup = () => {
    calls++;
    return "conflict";
  };
  e.room.GetCurrentGameContext().m_aBoxItemState[9] = 1;
  SendMoney(e);
  const before = live(e);
  for (const [slot, box, item] of [
    [0, 0, 25],
    [1, 1, 25],
    [1, 0, 26],
    [1, 0, 0],
    [1, 9, 25],
    [1, 250, 25],
    [1, 0, 71],
    [2, 0, 25],
  ]) {
    expect(() =>
      send(e, new CSendPacket(144).Encode1(slot!).Encode1(box!).Encode1(item!)),
    ).toThrow(CProtocolError);
    expect(live(e)).toEqual(before);
    noPackets(e);
  }
  for (const p of [
    new CSendPacket(144).Encode1(1),
    new CSendPacket(144).Encode1(1).Encode1(0).Encode1(25).Encode1(0),
  ])
    expect(() => send(e, p)).toThrow(CProtocolError);
  const secondary = e.clients[0]!.m_aUser[1]!,
    serial = secondary.m_nSessionSerialNo;
  secondary.m_nSessionSerialNo++;
  expect(() => SendMoney(e)).toThrow(CProtocolError);
  secondary.m_nSessionSerialNo = serial;
  expect(calls).toBe(1);
  expect(draws()).toBe(1);
  expect(live(e)).toEqual(before);
  e.db.CommitMoneyPickup = original;
  SendMoney(e);
  response(e, [1, 0, 25, 2]);
  expect(draws()).toBe(1);
  expect(e.room.GetMoneyPickupState().Attempts).toBe(2);
});
test("pending money blocks network and direct battle/aircraft/ghost/throw/mode/removal/deletion/statistics/start/result paths, while native UpdateGameEtc stays no-op", () => {
  const e = create();
  fault(e);
  SendMoney(e);
  const before = live(e);
  neverClock(e);
  for (const opcode of [
    96, 97, 98, 99, 100, 101, 102, 103, 104, 106, 109, 122, 123, 130, 131, 132,
    133, 145, 146, 148, 149, 151, 152, 153, 156, 160, 171, 187,
  ])
    expect(() => send(e, new CSendPacket(opcode))).toThrow(CProtocolError);
  for (const action of [
    () => e.table.DestroyPlayer(e.clients[0]!),
    () => e.room.DeleteAllUser(e.clients[0]!),
    () => e.room.DealWithGhostOfLeavingPlayer(e.clients[0]!),
    () => e.room.PrepareRoundStatistics(),
    () => e.room.BeginResultLifecycle(),
    () => e.room.SendGameTypeNormal(),
    () => e.room.SendGameTypeMod(),
  ])
    expect(action).toThrow(CProtocolError);
  for (const method of [
    e.room.OnRequestEatObstacle,
    e.room.OnEventItem,
    e.room.OnItemThrow,
    e.room.OnRequestGenerateGhost,
  ]) {
    const p = Received(new CSendPacket(0));
    p.Decode1();
    expect(() => method.call(e.room, p, e.clients[0]!)).toThrow(CProtocolError);
  }
  expect(DiscoverLaunchPeer(e.room, e.clients[0]!)).toBe(false);
  e.room.UpdateBombTimers(100000);
  e.room.UpdateGameEtc();
  expect(e.room.DeferHandleGameEnd()).toBe(false);
  expect(e.room.UpdateResultLifecycle()).toBe(false);
  expect(e.room.DeferReturnPrepareStage()).toBe(false);
  expect(e.room.DoReturnPrepareStage()).toBe(false);
  expect(live(e)).toEqual(before);
  noPackets(e);
  expect(e.table.GetPendingMoneyPickupCount()).toBe(1);
  expect(e.db.GetGameResultReceipt(e.room.GetResultRoundID()!)).toBeUndefined();
});
test("FIRST money preflight validates every native participant, including a stale OTHER socket, before RNG, frozen plan, SQL or any claim", () => {
  const e = create(),
    draws = onlyMoneyRandom(e),
    other = e.room.m_rgPlayer[2]!,
    originalSerial = other.m_nSessionSerialNo;
  const original = e.db.CommitMoneyPickup;
  let calls = 0;
  e.db.CommitMoneyPickup = function (input) {
    calls++;
    return original.call(this, input);
  };
  other.m_nSessionSerialNo++;
  const before = live(e);
  expect(() => SendMoney(e)).toThrow(CProtocolError);
  expect(live(e)).toEqual(before);
  noPackets(e);
  expect(draws()).toBe(0);
  expect(calls).toBe(0);
  expect(e.room.IsMoneyPickupPending()).toBe(false);
  expect(MoneyReceiptCount(e.db)).toBe(0);
  other.m_nSessionSerialNo = originalSerial;
  SendMoney(e);
  response(e, [1, 0, 25, 2]);
  expect(draws()).toBe(1);
  expect(calls).toBe(1);
});
test("even already-READY native end claims cannot capture163/XP/WDL/IncGame ahead of an unresolved coin; successful retry ends its tick before later settlement", () => {
  const e = create(),
    draws = onlyMoneyRandom(e),
    key = e.room.GetResultRoundID()!;
  e.time(45101);
  SubmitMoneyRoundClaims(e);
  e.clear();
  expect(e.room.GetGameEndDecision().Ready).toBe(true);
  const before = live(e);
  fault(e);
  SendMoney(e);
  expect(live(e)).toEqual(before);
  noPackets(e);
  const restore = neverClock(e);
  e.table.UpdateGameSessions();
  expect(live(e)).toEqual(before);
  noPackets(e);
  expect(e.db.GetGameResultReceipt(key)).toBeUndefined();
  expect(e.table.GetPendingResultCount()).toBe(0);
  expect(e.table.GetPendingMoneyPickupCount()).toBe(1);
  repair(e);
  e.table.UpdateGameSessions();
  response(e, [1, 0, 25, 2]);
  expect(e.room.m_nGameState).toBe(GameStage.Running);
  expect(e.db.GetGameResultReceipt(key)).toBeUndefined();
  for (const user of e.room.m_rgPlayer)
    if (user) expect(user.GetDynamicInfoSnapshot().GamesSinceFlush).toBe(0);
  restore();
  expect(e.room.UpdateResultLifecycle()).toBe(true);
  expect(e.room.m_nGameState).toBe(GameStage.Result);
  const receipt = JSON.parse(e.db.GetGameResultReceipt(key)!.Payload),
    partner = receipt.Changes.find((c: { Slot: number }) => c.Slot === 1);
  expect([partner.Before.Money, partner.After.Money]).toEqual([20, 20]);
  expect(draws()).toBe(1);
  expect(e.db.GetUserInfo("Partner")!.Money).toBe(20);
  expect(MoneyReceiptCount(e.db)).toBe(1);
});
test("detached diagnostics reveal no wallet/ID/plan and cannot mutate the private pending sequence", () => {
  const e = create();
  fault(e);
  SendMoney(e);
  const state = e.room.GetMoneyPickupState();
  expect(Object.keys(state).sort()).toEqual([
    "Attempts",
    "Failure",
    "Pending",
    "Sequence",
  ]);
  (state as { Sequence: number; Pending: boolean }).Sequence = 999;
  (state as { Sequence: number; Pending: boolean }).Pending = false;
  expect(e.room.GetMoneyPickupState()).toEqual({
    Sequence: 0,
    Pending: true,
    Attempts: 1,
    Failure: "storage",
  });
  expect(e.table.GetPendingMoneyPickupCount()).toBe(1);
  expect(e.table.GetPendingResultCount()).toBe(0);
});
test("a truthful receipt read-back is REQUIRED even for a zero/no-op wallet: a success string alone must NEVER claim or publish156", () => {
  const e = create(),
    original = e.db.CommitMoneyPickup;
  e.db.CommitMoneyPickup = () => "committed";
  SendMoney(e, 1, 0, 32);
  noPackets(e);
  expect(MoneyReceiptCount(e.db)).toBe(0);
  expect(e.room.GetCurrentGameContext().m_aBoxItemState[0]).toBe(0);
  expect(e.room.GetMoneyPickupState()).toEqual({
    Sequence: 0,
    Pending: true,
    Attempts: 1,
    Failure: "storage",
  });
  e.db.CommitMoneyPickup = original;
  SendMoney(e, 1, 0, 32);
  response(e, [1, 0, 32, 1]);
  expect(e.db.GetUserInfo("Partner")!.Money).toBe(0);
  expect(e.room.m_rgPlayer[1]!.GetDynamicInfoSnapshot().DynamicModified).toBe(
    1,
  );
  expect(MoneyReceiptCount(e.db)).toBe(1);
  expect(e.room.GetMoneyPickupState().Sequence).toBe(1);
});
test("outer SQL savepoint cannot produce network success before the REAL top-level commit", () => {
  const e = create(),
    draws = onlyMoneyRandom(e),
    before = live(e);
  expect(() =>
    e.session.db.transaction(() => {
      SendMoney(e);
      expect(live(e)).toEqual(before);
      noPackets(e);
      throw new Error("fixture outer rollback");
    })(),
  ).toThrow("outer rollback");
  expect(MoneyReceiptCount(e.db)).toBe(0);
  expect(e.room.IsMoneyPickupPending()).toBe(true);
  expect(draws()).toBe(1);
  SendMoney(e);
  response(e, [1, 0, 25, 2]);
  expect(draws()).toBe(1);
  expect(MoneyReceiptCount(e.db)).toBe(1);
});
test("late SQL adapter transaction cannot confirm an UNCOMMITTED wallet view as durable After, even when its old receipt exists", () => {
  const e = create(),
    original = e.db.CommitMoneyPickup;
  let first = true;
  e.db.CommitMoneyPickup = function (input) {
    const status = original.call(this, input);
    if (first) {
      first = false;
      e.session.db.exec(
        "UPDATE FxUserDynamic SET Money=0 WHERE ID='Partner'; BEGIN; UPDATE FxUserDynamic SET Money=10 WHERE ID='Partner'",
      );
    }
    return status;
  };
  try {
    SendMoney(e);
    noPackets(e);
    expect(e.room.IsMoneyPickupPending()).toBe(true);
    expect(e.room.m_rgPlayer[1]!.m_userInfo.Money).toBe(0);
  } finally {
    if (e.session.db.inTransaction) e.session.db.exec("ROLLBACK");
  }
  e.db.CommitMoneyPickup = original;
  neverClock(e);
  e.room.Update();
  noPackets(e);
  expect(e.room.GetMoneyPickupState().Failure).toBe("stored-state-changed");
  expect(e.db.GetUserInfo("Partner")!.Money).toBe(0);
  e.session.db.exec("UPDATE FxUserDynamic SET Money=10 WHERE ID='Partner'");
  e.room.Update();
  response(e, [1, 0, 25, 1]);
  expect(e.db.GetUserInfo("Partner")!.Money).toBe(10);
  expect(MoneyReceiptCount(e.db)).toBe(1);
});
test("trusted live-state tampering during a frozen retry NEVER installs stale After or touches SQL; exact explicit restoration can retry the SAME plan", () => {
  const e = create(),
    draws = onlyMoneyRandom(e),
    user = e.room.m_rgPlayer[1]!,
    ctx = e.room.GetCurrentGameContext();
  fault(e);
  SendMoney(e);
  repair(e);
  const original = e.db.CommitMoneyPickup;
  let calls = 0;
  e.db.CommitMoneyPickup = function (input) {
    calls++;
    return original.call(this, input);
  };
  neverClock(e);
  const mutations: [() => void, () => void][] = [
    [
      () => {
        user.m_userInfo.Money = 7;
      },
      () => {
        user.m_userInfo.Money = 0;
      },
    ],
    [() => user.SetAuthenCode(0), () => user.SetAuthenCode(1)],
    [
      () => {
        ctx.m_aBoxItemState[0] = 1;
      },
      () => {
        ctx.m_aBoxItemState[0] = 0;
      },
    ],
    [
      () => {
        ctx.m_aObstacleState[4] = 1;
      },
      () => {
        ctx.m_aObstacleState[4] = 0;
      },
    ],
    [
      () => {
        ctx.m_nNextBoxItem++;
      },
      () => {
        ctx.m_nNextBoxItem--;
      },
    ],
    [
      () => {
        e.room.m_aPlayerState[2] = GamePlayerState.Inactive;
      },
      () => {
        e.room.m_aPlayerState[2] = GamePlayerState.Active;
      },
    ],
    [
      () => {
        e.room.m_nGhostCount = 1;
      },
      () => {
        e.room.m_nGhostCount = 0;
      },
    ],
    [() => user.SetFakeLevel(30), () => user.SetFakeLevel(0)],
  ];
  for (const [change, restore] of mutations) {
    change();
    const changed = live(e);
    e.room.Update();
    expect(live(e)).toEqual(changed);
    noPackets(e);
    expect(e.room.GetMoneyPickupState().Failure).toBe("state-changed");
    expect(calls).toBe(0);
    restore();
  }
  e.room.Update();
  response(e, [1, 0, 25, 2]);
  expect(calls).toBe(1);
  expect(draws()).toBe(1);
  expect(MoneyReceiptCount(e.db)).toBe(1);
});
test("SQL callback mutating live wallet AFTER durable commit is detected before installation/publication; retry neither overwrites tampering nor repays", () => {
  const e = create(),
    draws = onlyMoneyRandom(e),
    user = e.room.m_rgPlayer[1]!,
    original = e.db.CommitMoneyPickup;
  let calls = 0;
  e.db.CommitMoneyPickup = function (input) {
    calls++;
    const status = original.call(this, input);
    if (calls === 1) user.m_userInfo.Money = 777;
    return status;
  };
  SendMoney(e);
  noPackets(e);
  expect(user.m_userInfo.Money).toBe(777);
  expect(e.db.GetUserInfo("Partner")!.Money).toBe(20);
  expect(e.room.GetMoneyPickupState().Failure).toBe("state-changed");
  expect(e.room.GetCurrentGameContext().m_aBoxItemState[0]).toBe(0);
  neverClock(e);
  e.room.Update();
  expect(calls).toBe(1);
  expect(user.m_userInfo.Money).toBe(777);
  noPackets(e);
  user.m_userInfo.Money = 0;
  e.room.Update();
  response(e, [1, 0, 25, 2]);
  expect(calls).toBe(2);
  expect(draws()).toBe(1);
  expect(user.m_userInfo.Money).toBe(20);
  expect(MoneyReceiptCount(e.db)).toBe(1);
});
test("receipt duplicate does NOT prove current stored wallet/stats: outside ABA or Exp edits after lost ack keep the room frozen, with no repayment/rebase", () => {
  for (const field of ["Money", "Exp"] as const) {
    const e = create(),
      draws = onlyMoneyRandom(e),
      original = e.db.CommitMoneyPickup;
    let calls = 0;
    e.db.CommitMoneyPickup = function (input) {
      calls++;
      const status = original.call(this, input);
      if (calls === 1) throw new Error("fixture lost ack");
      return status;
    };
    SendMoney(e);
    e.session.db
      .query(`UPDATE FxUserDynamic SET ${field}=? WHERE ID='Partner'`)
      .run(field === "Money" ? 0 : 1);
    const before = live(e);
    neverClock(e);
    e.room.Update();
    expect(live(e)).toEqual(before);
    noPackets(e);
    expect(e.room.GetMoneyPickupState().Failure).toBe("stored-state-changed");
    expect(MoneyReceiptCount(e.db)).toBe(1);
    expect(draws()).toBe(1);
    expect(e.db.GetUserInfo("Partner")![field]).toBe(field === "Money" ? 0 : 1);
    e.session.db
      .query(`UPDATE FxUserDynamic SET ${field}=? WHERE ID='Partner'`)
      .run(field === "Money" ? 20 : 0);
    e.room.Update();
    response(e, [1, 0, 25, 2]);
    expect(e.room.m_rgPlayer[1]!.m_userInfo.Money).toBe(20);
    expect(MoneyReceiptCount(e.db)).toBe(1);
  }
});
test("outside trusted SQL settlement cannot make an old duplicate authorize memory/156 in a room whose durable round is already CLOSED", () => {
  const e = create(),
    original = e.db.CommitMoneyPickup;
  let calls = 0;
  e.db.CommitMoneyPickup = function (input) {
    calls++;
    const status = original.call(this, input);
    if (calls === 1) throw new Error("fixture lost ack");
    return status;
  };
  SendMoney(e);
  const key = e.room.GetResultRoundID()!,
    packet = new CSendPacket(163)
      .Encode1(0)
      .Encode1(255)
      .Encode1(0)
      .Encode1(0)
      .Encode1(0);
  for (let i = 0; i < 8; i++) packet.Encode1(0);
  // Deliberate trusted misuse, NOT a native/game verdict or a recovery API.
  expect(
    e.db.CommitGameResult({
      RoundID: key,
      ChannelIndex: 0,
      SessionIndex: e.room.m_nIdx,
      SessionSerialNo: e.room.m_ulSerialNo,
      StartTick: e.clock.GetStartGameTime(),
      ElapsedMilliseconds: 1,
      WinningColor: -1,
      Reason: "timeout",
      InvalidGame: false,
      CountedSlots: [],
      Changes: [],
      Packet: packet.GetBuffer(),
    }),
  ).toBe("committed");
  const before = live(e);
  neverClock(e);
  e.room.Update();
  expect(live(e)).toEqual(before);
  noPackets(e);
  expect(e.room.GetMoneyPickupState().Failure).toBe("stored-state-changed");
  expect(e.room.m_rgPlayer[1]!.m_userInfo.Money).toBe(0);
  expect(e.db.GetUserInfo("Partner")!.Money).toBe(10);
  expect(MoneyReceiptCount(e.db)).toBe(1);
  expect(e.table.GetPendingMoneyPickupCount()).toBe(1);
});
test("terminal actor detach or OTHER peer disconnection preserves the unresolved plan/receipt instead of installing into an orphan or altering the roster", () => {
  for (const actorDetach of [true, false]) {
    const e = create(),
      draws = onlyMoneyRandom(e),
      original = e.db.CommitMoneyPickup;
    let calls = 0;
    e.db.CommitMoneyPickup = function (input) {
      calls++;
      original.call(this, input);
      throw new Error("fixture lost ack");
    };
    SendMoney(e);
    const key = e.room.GetResultRoundID()!;
    if (actorDetach) e.room.m_rgPlayer[1]!.SetFree();
    else e.clients[1]!.Close();
    const before = live(e);
    neverClock(e);
    e.table.UpdateGameSessions();
    expect(live(e)).toEqual(before);
    noPackets(e);
    expect(calls).toBe(1);
    expect(draws()).toBe(1);
    expect(e.room.GetMoneyPickupState().Failure).toBe("state-changed");
    expect(e.table.GetPendingMoneyPickupCount()).toBe(1);
    expect(e.db.GetMoneyPickupReceipt(key, 1)).toBeDefined();
    expect(e.db.GetUserInfo("Partner")!.Money).toBe(20);
    expect(e.room.m_rgPlayer[1]!.m_userInfo.Money).toBe(0);
    expect(e.room.GetCurrentGameContext().m_aBoxItemState[0]).toBe(0);
    expect(() => e.table.DestroyPlayer(e.clients[1]!)).toThrow();
  }
});
test("random and SQL callbacks cannot reenter gameplay/driver/result/removal and cannot consume another money random draw", () => {
  const e = create();
  e.room.m_rgPlayer[1]!.SetAuthenCode(1);
  let draws = 0;
  const check = () => {
    expect(() => SendMoney(e)).toThrow(CProtocolError);
    expect(() => send(e, new CSendPacket(145).Encode1(0).Encode1(0))).toThrow(
      CProtocolError,
    );
    expect(() => e.table.DestroyPlayer(e.clients[1]!)).toThrow(CProtocolError);
    expect(() => e.room.SendGameTypeMod()).toThrow(CProtocolError);
    e.room.Update();
    e.room.UpdateBombTimers(100000);
    expect(e.room.UpdateResultLifecycle()).toBe(false);
    expect(e.room.DeferHandleGameEnd()).toBe(false);
    expect(MoneyReceiptCount(e.db)).toBe(0);
    noPackets(e);
  };
  e.random(() => {
    draws++;
    check();
    return 1;
  });
  const original = e.db.CommitMoneyPickup;
  e.db.CommitMoneyPickup = function (input) {
    check();
    return original.call(this, input);
  };
  SendMoney(e);
  response(e, [1, 0, 25, 2]);
  expect(draws).toBe(1);
  expect(e.db.GetUserInfo("Partner")!.Money).toBe(20);
  expect(MoneyReceiptCount(e.db)).toBe(1);
});
test("publication callbacks see durable wallet + completed claim/ordinal; per-target packet mutation/send failure cannot repay or replay money156", () => {
  const e = create(),
    draws = onlyMoneyRandom(e),
    first = e.clients[0]!,
    original = first.SendPacket;
  let observed = 0;
  first.SendPacket = function (p) {
    if (p.m_nPacketType === 156) {
      observed++;
      expect(e.db.GetUserInfo("Partner")!.Money).toBe(20);
      expect(e.room.m_rgPlayer[1]!.m_userInfo.Money).toBe(20);
      expect(e.room.GetMoneyPickupState()).toEqual({
        Sequence: 1,
        Pending: false,
        Attempts: 1,
        Failure: undefined,
      });
      expect(e.room.GetCurrentGameContext().m_aBoxItemState[0]).toBe(1);
      expect(MoneyReceiptCount(e.db)).toBe(1);
      expect(() => SendMoney(e)).toThrow(CProtocolError);
      expect(() => e.table.DestroyPlayer(e.clients[1]!)).toThrow();
      expect(e.room.UpdateResultLifecycle()).toBe(false);
      e.room.Update();
      e.room.UpdateBombTimers(99999);
      p.m_pBlock.fill(0);
      throw new Error("fixture failed156 transport after committed state");
    }
    original.call(this, p);
  };
  try {
    SendMoney(e);
  } finally {
    first.SendPacket = original;
  }
  expect(observed).toBe(1);
  expect(first.packets).toEqual([]);
  expect(e.room.GetPacketPublicationFailureCount()).toBe(1);
  const p = e.clients[1]!.Take(156);
  expect([p.Decode1(), p.Decode1(), p.Decode1(), p.Decode1()]).toEqual([
    1, 0, 25, 2,
  ]);
  p.AssertEnd();
  e.clear();
  SendMoney(e);
  noPackets(e);
  expect(draws()).toBe(1);
  expect(MoneyReceiptCount(e.db)).toBe(1);
  expect(e.room.GetMoneyPickupState().Attempts).toBe(1);
});
test("aircraft, proven trusted throw and actual event4 drop reset the SAME box without resetting the monetary ordinal; dead-player native money behavior is retained", () => {
  const e = create(),
    draws = onlyMoneyRandom(e),
    key = e.room.GetResultRoundID()!,
    ctx = e.room.GetCurrentGameContext();
  SendMoney(e);
  response(e, [1, 0, 25, 2]);
  expect(e.room.GetMoneyPickupState().Sequence).toBe(1);
  e.time(7000);
  send(
    e,
    new CSendPacket(156)
      .Encode1(1)
      .Encode1(0x81)
      .Encode1(0)
      .Encode1(31)
      .Encode1(0x12),
    1,
  );
  expect(ctx.m_aBoxItemState[0]).toBe(0);
  expect(e.room.GetMoneyPickupState().Sequence).toBe(1);
  e.clear();
  SendMoney(e);
  response(e, [1, 0, 25, 2]);
  const thrown = Received(
    new CSendPacket(0)
      .Encode1(0xf1)
      .Encode1(0)
      .Encode1(255)
      .Encode1(128)
      .Encode1(0)
      .Encode1(1),
  );
  thrown.Decode1();
  e.room.OnItemThrow(thrown, e.clients[0]!);
  expect(ctx.m_aBoxItemState[0]).toBe(0);
  e.clear();
  SendMoney(e);
  response(e, [1, 0, 25, 2]);
  send(
    e,
    new CSendPacket(146)
      .Encode1(0x41)
      .Encode2(0)
      .Encode2(0)
      .Encode1(0xff)
      .Encode1(1)
      .Encode1(0)
      .Encode1(0),
  );
  expect(ctx.m_aBoxItemState[0]).toBe(0);
  expect(e.room.m_aPlayerState[1]).toBe(GamePlayerState.Inactive);
  e.clear();
  SendMoney(e);
  response(e, [1, 0, 25, 2]);
  expect(draws()).toBe(4);
  expect(e.room.m_rgPlayer[1]!.m_userInfo.Money).toBe(80);
  expect(e.db.GetUserInfo("Partner")!.Money).toBe(80);
  expect(e.room.GetMoneyPickupState()).toEqual({
    Sequence: 4,
    Pending: false,
    Attempts: 4,
    Failure: undefined,
  });
  for (let i = 1; i <= 4; i++)
    expect(
      JSON.parse(e.db.GetMoneyPickupReceipt(key, i)!.Payload).BoxIndex,
    ).toBe(0);
  expect(MoneyReceiptCount(e.db)).toBe(4);
});
test("modern ordinal exhaustion rejects BEFORE RNG/SQL/claim rather than wrapping onto an old receipt", () => {
  const e = create(),
    draws = onlyMoneyRandom(e);
  // ONLY a modern private counter bound is arranged. Native generation/150 is real.
  (
    e.room as unknown as { m_resultRound: { MoneySequence: number } }
  ).m_resultRound.MoneySequence = IntegerRange.UInt32Maximum;
  const before = live(e);
  expect(() => SendMoney(e)).toThrow("sequence exhausted");
  expect(live(e)).toEqual(before);
  noPackets(e);
  expect(draws()).toBe(0);
  expect(MoneyReceiptCount(e.db)).toBe(0);
  expect(e.room.IsMoneyPickupPending()).toBe(false);
});
test("durable pickup is the LATER settlement Before wallet;163/164 cannot overwrite it, and a genuine second106 gets a new UUID/ordinal1 with retained money", () => {
  const e = create(),
    key = e.room.GetResultRoundID()!;
  SendMoney(e, 1, 0, 31);
  response(e, [1, 0, 31, 1]);
  expect(e.db.GetUserInfo("Partner")!.Money).toBe(5000);
  e.time(45101);
  SubmitMoneyRoundClaims(e);
  e.clear();
  expect(e.room.UpdateResultLifecycle()).toBe(true);
  expect(e.room.m_nGameState).toBe(GameStage.Result);
  expect(e.db.GetUserInfo("Partner")!.Money).toBe(5000);
  const result = JSON.parse(e.db.GetGameResultReceipt(key)!.Payload),
    partner = result.Changes.find((c: { Slot: number }) => c.Slot === 1);
  expect([partner.Before.Money, partner.After.Money]).toEqual([5000, 5000]);
  expect(e.room.m_rgPlayer[1]!.m_userInfo.Money).toBe(5000);
  expect(MoneyReceiptCount(e.db)).toBe(1);
  expect(() => SendMoney(e, 1, 1, 31)).toThrow(CProtocolError);
  e.time(
    e.clock.GetEndGameTime() + GameResultTiming.ReturnPrepareMilliseconds + 1,
  );
  expect(e.room.DeferReturnPrepareStage()).toBe(true);
  expect(e.room.GetCurrentGameContext().m_aBoxItemState[0]).toBe(1);
  expect(e.room.GetMoneyPickupState().Sequence).toBe(0);
  e.clear();
  send(e, new CSendPacket(96).Encode1(1), 1);
  send(e, new CSendPacket(106));
  expect(e.room.IsLoadingGame()).toBe(true);
  expect(e.room.GetCurrentGameContext().m_aBoxItemState[0]).toBe(0);
  for (const [i, peer] of e.clients.entries()) {
    expect(DiscoverLaunchPeer(e.room, peer, 43000 + i)).toBe(false);
    send(e, LaunchReadyPacket(e.room, peer), i);
  }
  expect(e.room.m_nGameState).toBe(GameStage.Running);
  const second = e.room.GetResultRoundID()!;
  expect(second).not.toBe(key);
  e.clear();
  SendMoney(e, 1, 0, 31);
  response(e, [1, 0, 31, 1]);
  expect(e.room.GetMoneyPickupState()).toEqual({
    Sequence: 1,
    Pending: false,
    Attempts: 1,
    Failure: undefined,
  });
  expect(e.db.GetUserInfo("Partner")!.Money).toBe(10000);
  expect(e.room.m_rgPlayer[1]!.m_userInfo.Money).toBe(10000);
  expect(MoneyReceiptCount(e.db)).toBe(2);
  expect(e.db.GetMoneyPickupReceipt(key, 1)).toBeDefined();
  expect(e.db.GetMoneyPickupReceipt(second, 1)).toBeDefined();
  expect(e.db.GetGameResultReceipt(second)).toBeUndefined();
});
