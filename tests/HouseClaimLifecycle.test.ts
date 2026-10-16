import { afterEach, expect, test } from "bun:test";
import { CSendPacket } from "../Common/CSendPacket.ts";
import {
  CProtocolError,
  CUnsupportedOperation,
} from "../Common/CProtocolError.ts";
import {
  GameStage,
  GamePlayerState,
  SessionModified,
} from "../Common/OfficialValues.ts";
import type { HouseClaimSubmission } from "../FXGS/CDBMan.ts";
import {
  PlanTakeHouse,
  MakeTakeHousePacket,
  MakeTakeHouseRequest,
  type HouseCell,
  type HouseDropRequest,
} from "../FXGS/HouseClaim.ts";
import {
  HouseRequest,
  SendHouse,
  HouseReceiptCount,
  HouseLive,
  NativeHouseEnvironment,
  type NativeHouseFixture,
} from "./helpers/HouseClaim.ts";
import { SendMoney, SubmitMoneyRoundClaims } from "./helpers/MoneyPickup.ts";
import {
  GameLaunchFixture,
  DiscoverLaunchPeer,
  LaunchReadyPacket,
} from "./helpers/GameLaunch.ts";
import { Received } from "./helpers/Clients.ts";
import vectors from "./fixtures/house-claim-vectors.json";
import { CPeImage, OFFICIAL_SERVICES } from "../Tools/OfficialSource.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function create() {
  const e = NativeHouseEnvironment();
  cleanup.push(e.close);
  return e;
}
function noPackets(e: NativeHouseFixture) {
  for (const peer of e.clients) expect(peer.packets).toEqual([]);
}
function noClockOrRandom(e: NativeHouseFixture) {
  const current = e.clock.GetCurrentTime,
    elapsed = e.clock.ElapsedTime;
  e.clock.GetCurrentTime = () => {
    throw new Error("House MUST NOT sample absolute clock");
  };
  e.clock.ElapsedTime = () => {
    throw new Error("House MUST NOT sample duration");
  };
  e.random(() => {
    throw new Error("House MUST NOT draw even for auth1");
  });
  return () => {
    e.clock.GetCurrentTime = current;
    e.clock.ElapsedTime = elapsed;
  };
}
function fault(e: NativeHouseFixture) {
  e.session.db.exec(
    "CREATE TRIGGER TestHouseFailure BEFORE INSERT ON RuntimeHouseClaim BEGIN SELECT RAISE(FAIL,'fixture-house-write'); END",
  );
}
function repair(e: NativeHouseFixture) {
  e.session.db.exec("DROP TRIGGER TestHouseFailure");
}
function response(e: NativeHouseFixture, fields: readonly number[]) {
  for (const peer of e.clients) {
    const p = peer.Take(178);
    expect(Array.from({ length: fields.length }, () => p.Decode1())).toEqual([
      ...fields,
    ]);
    p.AssertEnd();
  }
  e.clear();
}
function freezeInput(p: HouseClaimSubmission): string {
  return JSON.stringify({
    ...p,
    Packet: Buffer.from(p.Packet).toString("hex"),
  });
}

test("31 read-only PE anchors and manual fixture exhaustively classify coordinate BYTE pairs, every allocator offset and the two DISTINCT literal5 meanings", () => {
  const image = new CPeImage(OFFICIAL_SERVICES.FXGS);
  expect(vectors.OfficialPE.SHA256).toBe(image.sha256);
  expect(vectors.InstructionAnchors).toHaveLength(31);
  for (const a of vectors.InstructionAnchors)
    expect(image.read(a.VA, a.Bytes.length / 2).toString("hex")).toBe(a.Bytes);
  expect(vectors.Cases).toHaveLength(1633);
  expect(vectors.Cases.filter((r) => r.Safe)).toHaveLength(1383);
  expect(vectors.Cases.filter((r) => !r.Safe)).toHaveLength(250);
  const pairs = new Set(
    vectors.Cases.slice(0, 258).flatMap((r) =>
      r.Cells.map((c) => c[0]! * 256 + c[1]!),
    ),
  );
  expect(pairs.size).toBe(65536);
  for (const row of vectors.Cases.filter((r) => !r.Safe))
    expect(row.Allocated).toBeLessThan(row.Drops.length);
  for (let index = 0; index < 3; index++)
    expect(
      new Set(
        vectors.Cases.filter((r) => r.Safe).flatMap((r) =>
          r.Drops.map((d) => d[index]),
        ),
      ).size,
    ).toBe(256);
});

test("ALL independent C++ house images: full byte coordinate domain, ordered duplicate filtering, counts/wallet wrap, opaque drops and explicit malformed-native capacity classification", () => {
  for (const row of vectors.Cases) {
    const before = {
        States: row.StatesBefore,
        Counts: row.CountsBefore,
        NextBoxItem: row.Next,
      },
      cells = row.Cells as unknown as HouseCell[],
      drops = row.Drops as unknown as HouseDropRequest[];
    if (!row.Safe) {
      expect(() =>
        PlanTakeHouse(before, row.Slot, row.Color, cells, drops),
      ).toThrow("exhausted");
      continue;
    }
    const plan = PlanTakeHouse(before, row.Slot, row.Color, cells, drops);
    expect(plan.After.States).toEqual(row.StatesAfter);
    expect(plan.After.Counts).toEqual(row.CountsAfter);
    expect(plan.After.NextBoxItem).toBe(row.Next + row.Allocated);
    expect(plan.AcceptedCells).toEqual(row.Accepted as unknown as HouseCell[]);
    expect(plan.Delta).toBe(row.Delta);
    expect(MakeTakeHouseRequest(plan).GetBuffer().toString("hex")).toBe(
      row.Request,
    );
    expect(MakeTakeHousePacket(plan).GetBuffer().toString("hex")).toBe(
      row.NativeResponse,
    );
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.Before.States)).toBe(true);
    expect(Object.isFrozen(plan.After.Counts)).toBe(true);
    expect(Object.isFrozen(plan.Cells)).toBe(true);
  }
});
test("EVERY safe color0..7 C++ image traverses GENUINE106/discovery/109/150 ->161 ->SQLite ->live board/count/allocator/wallet ->exact178 to four sockets/eight actors", () => {
  for (const row of vectors.Cases.filter((r) => r.Safe && r.Color < 8)) {
    const e = NativeHouseEnvironment(undefined, [2, 2, 2, 2]);
    try {
      const ctx = e.room.GetCurrentGameContext(),
        u = e.room.m_rgPlayer[row.Slot]!;
      // Explicit trusted fixture arrangement for boundaries, NOT packet-proven
      // spawn/position/colors/wallet or official-client authorization.
      ctx.m_aHouseState.set(row.StatesBefore);
      ctx.m_aHouseCount.set(row.CountsBefore);
      ctx.m_nNextBoxItem = row.Next;
      e.room.m_rgSlotInfo[row.Slot]![2] = row.Color;
      u.m_userInfo.Money = row.Money;
      u.SetAuthenCode(1);
      e.session.db
        .query("UPDATE FxUserDynamic SET Money=? WHERE ID=?")
        .run(row.Money, u.GetName());
      const before = HouseLive(e);
      noClockOrRandom(e);
      e.table.OnPacket(
        Received(
          new CSendPacket(161).EncodeBuffer(
            Buffer.from(row.Request, "hex").subarray(1),
          ),
        ),
        u.m_pClientSocket!,
      );
      expect(ctx.m_aHouseState).toEqual(Int32Array.from(row.StatesAfter));
      expect(ctx.m_aHouseCount).toEqual(Int32Array.from(row.CountsAfter));
      expect(ctx.m_nNextBoxItem).toBe(row.Next + row.Allocated);
      expect(u.m_userInfo.Money).toBe(row.MoneyAfter);
      expect(e.db.GetUserInfo(u.GetName())!.Money).toBe(row.MoneyAfter);
      expect(u.GetDynamicInfoSnapshot().DynamicModified).toBe(1);
      expect(e.room.GetHouseClaimState()).toEqual({
        Sequence: 1,
        Pending: false,
        Attempts: 1,
        Failure: undefined,
      });
      expect(
        e.db
          .GetHouseClaimReceipt(e.room.GetResultRoundID()!, 1)!
          .Packet.toString("hex"),
      ).toBe(row.NativeResponse);
      for (const peer of e.clients)
        expect(peer.packets.map((p) => p.m_pBlock.toString("hex"))).toEqual([
          row.NativeResponse,
        ]);
      e.clear();
      const after = HouseLive(e);
      expect({
        ...after,
        Users: before.Users,
        Context: before.Context,
      }).toEqual(before);
      expect(e.room.GetMoneyPickupState().Sequence).toBe(0);
      expect(
        e.db.GetGameResultReceipt(e.room.GetResultRoundID()!),
      ).toBeUndefined();
    } finally {
      e.close();
    }
  }
}, 60_000);
test("ALL exhausted native allocator images reject WHOLE requests before wallet/board/ordinal/box/publication, even after valid new cells", () => {
  const e = NativeHouseEnvironment(undefined, [2, 2, 2, 2]);
  cleanup.push(e.close);
  noClockOrRandom(e);
  for (const row of vectors.Cases.filter((r) => !r.Safe)) {
    const ctx = e.room.GetCurrentGameContext();
    ctx.m_aHouseState.set(row.StatesBefore);
    ctx.m_aHouseCount.set(row.CountsBefore);
    ctx.m_nNextBoxItem = row.Next;
    const before = HouseLive(e);
    expect(() =>
      e.table.OnPacket(
        Received(
          new CSendPacket(161).EncodeBuffer(
            Buffer.from(row.Request, "hex").subarray(1),
          ),
        ),
        e.room.m_rgPlayer[row.Slot]!.m_pClientSocket!,
      ),
    ).toThrow(CProtocolError);
    expect(HouseLive(e)).toEqual(before);
    noPackets(e);
    expect(HouseReceiptCount(e.db)).toBe(0);
    expect(e.room.IsHouseClaimPending()).toBe(false);
  }
});
test("house first BYTE is room actor, not socket-local self; same/other color counts, original order, opaque0..255, ignored invalid axes and zero-delta dirty intent remain native", () => {
  const e = create();
  noClockOrRandom(e);
  const ctx = e.room.GetCurrentGameContext();
  e.room.m_rgSlotInfo[1]![2] = 7;
  e.room.m_rgPlayer[1]!.SetAuthenCode(1);
  SendHouse(
    e,
    1,
    [
      [12, 14],
      [0, 15],
      [0, 0],
      [13, 0],
      [0, 0],
      [255, 255],
    ],
    [[255, 128, 90]],
  );
  response(e, [1, 2, 12, 14, 0, 0, 5, 1, 255, 126, 128, 90]);
  expect(ctx.m_aHouseCount[7]).toBe(2);
  expect(ctx.m_aHouseCount[1]).toBe(0);
  expect(ctx.m_nNextBoxItem).toBe(127);
  expect(ctx.m_aBoxItemState[126]).toBe(0);
  expect(e.db.GetUserInfo("Partner")!.Money).toBe(10);
  SendHouse(
    e,
    2,
    [
      [0, 0],
      [0, 1],
    ],
    [],
  );
  response(e, [2, 1, 0, 1, 5, 0]);
  expect(ctx.m_aHouseState[0]).toBe(1);
  expect(ctx.m_aHouseState[1]).toBe(2);
  SendHouse(
    e,
    1,
    [
      [0, 0],
      [12, 14],
    ],
    [],
  );
  response(e, [1, 0, 5, 0]);
  expect(e.room.m_rgPlayer[1]!.GetDynamicInfoSnapshot().DynamicModified).toBe(
    1,
  );
  expect(e.db.GetUserInfo("Partner")!.Money).toBe(10);
  expect(e.room.GetHouseClaimState().Sequence).toBe(3);
  expect(HouseReceiptCount(e.db)).toBe(3);
});
test("fully decoded body precedes plan: every truncation/trailing byte and foreign actor reject with no valid-prefix mutation", () => {
  const e = create();
  noClockOrRandom(e);
  const full = HouseRequest(
      1,
      [
        [0, 0],
        [0, 1],
      ],
      [[255, 1, 128]],
    ).GetBuffer(),
    before = HouseLive(e);
  for (let n = 1; n < full.length; n++) {
    const p = new CSendPacket(161).EncodeBuffer(full.subarray(1, n));
    expect(() => e.table.OnPacket(Received(p), e.clients[0]!)).toThrow(
      CProtocolError,
    );
    expect(HouseLive(e)).toEqual(before);
  }
  for (const p of [
    HouseRequest().Encode1(0),
    HouseRequest(2),
    HouseRequest(8),
    HouseRequest(255),
  ])
    expect(() => e.table.OnPacket(Received(p), e.clients[0]!)).toThrow(
      CProtocolError,
    );
  noPackets(e);
  expect(HouseReceiptCount(e.db)).toBe(0);
  expect(e.room.GetHouseClaimState().Attempts).toBe(0);
});
test("phase/provenance: Loading, handmade Running and trusted BeginResultLifecycle cannot grant161 native eligibility", () => {
  const e = GameLaunchFixture();
  cleanup.push(e.close);
  expect(() =>
    e.table.OnPacket(Received(HouseRequest()), e.clients[0]!),
  ).toThrow(CProtocolError);
  e.table.OnPacket(Received(new CSendPacket(106)), e.clients[0]!);
  e.clear();
  expect(() =>
    e.table.OnPacket(Received(HouseRequest()), e.clients[0]!),
  ).toThrow(CProtocolError);
  e.room.m_nGameState = GameStage.Running;
  expect(() =>
    e.table.OnPacket(Received(HouseRequest()), e.clients[0]!),
  ).toThrow(CUnsupportedOperation);
  noPackets(e);
  expect(HouseReceiptCount(e.db)).toBe(0);
});
test("SQL failures freeze all world/timer/room-list/result/removal changes; exact/driver retry is pre-clock and preserves the frozen plan and full frame delta", () => {
  const e = create(),
    ctx = e.room.GetCurrentGameContext();
  ctx.AddBomb(0x23, 0x11);
  e.room.m_aPlayerState[2] = GamePlayerState.PendingDie;
  ctx.m_aPlayerStateTime[2] = 0;
  e.room.m_nModified |= SessionModified.Title;
  const before = HouseLive(e);
  fault(e);
  SendHouse(e);
  expect(HouseLive(e)).toEqual(before);
  noPackets(e);
  expect(e.room.IsGameplayCommitPending()).toBe(true);
  const restore = noClockOrRandom(e);
  e.time(12000);
  for (let i = 0; i < 3; i++) {
    e.table.UpdateGameSessions();
    expect(HouseLive(e)).toEqual(before);
    expect(e.notices).toEqual([]);
    noPackets(e);
    expect(e.table.GetUpdateFailures()).toEqual([]);
    expect(e.table.GetPendingHouseClaimCount()).toBe(1);
    expect(e.room.DeferHandleGameEnd()).toBe(false);
    expect(e.room.UpdateResultLifecycle()).toBe(false);
  }
  for (const opcode of [
    106, 96, 100, 146, 144, 145, 147, 148, 149, 150, 151, 152, 154, 155, 156,
    160, 162, 163,
  ])
    expect(() =>
      e.table.OnPacket(Received(new CSendPacket(opcode)), e.clients[0]!),
    ).toThrow(CProtocolError);
  for (const action of [
    () => e.room.DeleteAllUser(e.clients[1]!),
    () => e.room.DestroyPlayer(e.clients[1]!),
    () => e.room.DealWithGhostOfLeavingPlayer(e.clients[1]!),
    () => e.room.PrepareRoundStatistics(),
  ])
    expect(action).toThrow(CProtocolError);
  e.room.UpdateBombTimers(99999);
  expect(HouseLive(e)).toEqual(before);
  expect(() => SendHouse(e, 0)).toThrow("exact frozen");
  expect(() => SendHouse(e, 1, [[0, 0]], [])).toThrow("exact frozen");
  expect(() =>
    SendHouse(
      e,
      1,
      [
        [0, 0],
        [0, 1],
      ],
      [[0, 0, 0]],
    ),
  ).toThrow("exact frozen");
  expect(HouseReceiptCount(e.db)).toBe(0);
  expect(e.room.GetHouseClaimState().Attempts).toBe(4);
  repair(e);
  e.table.UpdateGameSessions();
  response(e, [1, 2, 0, 0, 0, 1, 5, 0]);
  expect(e.room.GetLastUpdateTime()).toBe(before.LastUpdate);
  expect(e.room.m_aPlayerState[2]).toBe(GamePlayerState.PendingDie);
  expect(ctx.m_aBomb).toEqual(JSON.parse(before.Context).m_aBomb);
  expect(e.room.GetHouseClaimState().Sequence).toBe(1);
  restore();
  e.room.Update();
  expect(e.room.GetLastUpdateTime()).toBe(12000);
});
test("lost ACK AFTER actual COMMIT freezes live board/allocator/wallet; exact-request retry uses identical immutable input and installs once without any clock/RNG", () => {
  const e = create(),
    before = HouseLive(e),
    original = e.db.CommitHouseClaim,
    inputs: string[] = [];
  e.db.CommitHouseClaim = function (p) {
    inputs.push(freezeInput(p));
    const status = original.call(this, p);
    if (inputs.length === 1) {
      p.Packet.fill(0);
      throw new Error("lost house ACK AFTER actual COMMIT");
    }
    return status;
  };
  SendHouse(e, 1, undefined, [[255, 128, 90]]);
  expect(HouseLive(e)).toEqual(before);
  noPackets(e);
  expect(e.db.GetUserInfo("Partner")!.Money).toBe(10);
  expect(HouseReceiptCount(e.db)).toBe(1);
  expect(e.room.GetCurrentGameContext().m_nNextBoxItem).toBe(126);
  noClockOrRandom(e);
  SendHouse(e, 1, undefined, [[255, 128, 90]]);
  expect(inputs).toHaveLength(2);
  expect(inputs[0]).toBe(inputs[1]);
  response(e, [1, 2, 0, 0, 0, 1, 5, 1, 255, 126, 128, 90]);
  expect(e.room.GetHouseClaimState()).toEqual({
    Sequence: 1,
    Pending: false,
    Attempts: 2,
    Failure: undefined,
  });
  expect(e.room.m_rgPlayer[1]!.m_userInfo.Money).toBe(10);
  expect(e.room.GetCurrentGameContext().m_nNextBoxItem).toBe(127);
  // Completed wire requests carry NO nonce: a fresh identical request is NOT
  // exactly-once. Claimed houses award0, but native allocates NEW drop boxes.
  SendHouse(e, 1, undefined, [[255, 128, 90]]);
  response(e, [1, 0, 5, 1, 255, 127, 128, 90]);
  expect(e.db.GetUserInfo("Partner")!.Money).toBe(10);
  expect(HouseReceiptCount(e.db)).toBe(2);
});
test("false committed/duplicate ACK without matching receipt cannot install even a zero-money plan", () => {
  for (const status of ["committed", "duplicate"] as const) {
    const e = create(),
      before = HouseLive(e);
    e.db.CommitHouseClaim = () => status;
    SendHouse(e, 1, [], [[255, 1, 128]]);
    expect(HouseLive(e)).toEqual(before);
    noPackets(e);
    expect(e.room.GetHouseClaimState().Failure).toBe("storage");
    expect(HouseReceiptCount(e.db)).toBe(0);
  }
});
test("ALL-five stored After recheck detects external edits after lost ACK; no live rebase, repay or stale board install", () => {
  for (const field of ["Money", "Exp", "Win", "Draw", "Lose"] as const) {
    const e = create(),
      original = e.db.CommitHouseClaim;
    e.db.CommitHouseClaim = function (p) {
      original.call(this, p);
      throw new Error("lost ACK");
    };
    SendHouse(e);
    e.db.CommitHouseClaim = original;
    e.session.db
      .query(`UPDATE FxUserDynamic SET ${field}=${field}+1 WHERE ID='Partner'`)
      .run();
    const before = HouseLive(e);
    noClockOrRandom(e);
    e.room.Update();
    expect(e.room.GetHouseClaimState().Failure).toBe("stored-state-changed");
    expect(HouseLive(e)).toEqual(before);
    noPackets(e);
    expect(HouseReceiptCount(e.db)).toBe(1);
  }
});
test("live board/count/allocator/users/identity/clock/slot drift freezes before SQL; no fingerprint can silently rebase a house plan", () => {
  for (const mutate of [
    (e: NativeHouseFixture) => {
      e.room.GetCurrentGameContext().m_aHouseState[4] = 2;
    },
    (e: NativeHouseFixture) => {
      e.room.GetCurrentGameContext().m_aHouseCount[0]!++;
    },
    (e: NativeHouseFixture) => {
      e.room.GetCurrentGameContext().m_nNextBoxItem++;
    },
    (e: NativeHouseFixture) => {
      e.room.m_rgPlayer[1]!.m_userInfo.Exp++;
    },
    (e: NativeHouseFixture) => {
      e.room.m_rgSlotInfo[1]![2] = 7;
    },
    (e: NativeHouseFixture) => {
      e.clock.m_dwTimeStopped++;
    },
    (e: NativeHouseFixture) => {
      e.room.m_rgPlayer[1]!.m_nSessionSerialNo++;
    },
  ]) {
    const e = create();
    fault(e);
    SendHouse(e);
    repair(e);
    mutate(e);
    const before = HouseLive(e);
    noClockOrRandom(e);
    e.room.Update();
    expect(e.room.GetHouseClaimState().Failure).toBe("state-changed");
    expect(HouseLive(e)).toEqual(before);
    noPackets(e);
    expect(HouseReceiptCount(e.db)).toBe(0);
  }
});
test("terminal/closed/stale secondary group is never an offline award recipient, both at intake and frozen retry", () => {
  for (const mutation of [
    (e: NativeHouseFixture) => e.clients[0]!.Close(),
    (e: NativeHouseFixture) => e.room.m_rgPlayer[1]!.SetFree(),
    (e: NativeHouseFixture) => {
      e.room.m_rgPlayer[1]!.m_nSessionSerialNo++;
    },
  ]) {
    const e = create();
    mutation(e);
    const before = HouseLive(e);
    expect(() => SendHouse(e)).toThrow(CProtocolError);
    expect(HouseLive(e)).toEqual(before);
    noPackets(e);
    expect(HouseReceiptCount(e.db)).toBe(0);
    const f = create();
    fault(f);
    SendHouse(f);
    repair(f);
    mutation(f);
    const frozen = HouseLive(f);
    noClockOrRandom(f);
    f.room.Update();
    expect(f.room.GetHouseClaimState().Failure).toBe("state-changed");
    expect(HouseLive(f)).toEqual(frozen);
    noPackets(f);
    expect(HouseReceiptCount(f.db)).toBe(0);
  }
});
test("publication observes COMPLETE durable+live transition, blocks reentry, isolates packet mutations/failure, and never automatically replays178", () => {
  const e = create(),
    errors: unknown[] = [];
  noClockOrRandom(e);
  e.clients[0]!.SendPacket = (p) => {
    try {
      expect(e.db.GetUserInfo("Partner")!.Money).toBe(10);
      expect(e.room.m_rgPlayer[1]!.m_userInfo.Money).toBe(10);
      expect(e.room.GetCurrentGameContext().m_aHouseState[0]).toBe(1);
      expect(e.room.GetCurrentGameContext().m_nNextBoxItem).toBe(127);
      expect(e.room.GetHouseClaimState()).toEqual({
        Sequence: 1,
        Pending: false,
        Attempts: 1,
        Failure: undefined,
      });
      expect(() => SendHouse(e)).toThrow(CProtocolError);
      expect(() => SendMoney(e)).toThrow(CProtocolError);
      expect(() => e.room.DestroyPlayer(e.clients[1]!)).toThrow(CProtocolError);
      expect(e.room.DeferHandleGameEnd()).toBe(false);
      expect(() => e.room.Update()).not.toThrow();
      p.GetBuffer().fill(0);
    } catch (error) {
      errors.push(error);
    }
    throw new Error("fixture publication failure");
  };
  SendHouse(e, 1, undefined, [[255, 128, 90]]);
  expect(errors).toEqual([]);
  const p = e.clients[1]!.Take(178);
  expect(p.Decode1()).toBe(1);
  expect(p.Decode1()).toBe(2);
  expect(e.room.GetPacketPublicationFailureCount()).toBeGreaterThan(0);
  expect(HouseReceiptCount(e.db)).toBe(1);
  e.clients[1]!.Clear();
  e.db.CommitHouseClaim = () => {
    throw new Error("completed requests are not pending retries");
  };
  expect(e.room.IsGameplayCommitPending()).toBe(false);
  e.room.DeferResurrection();
  noPackets(e);
});
test("pending money and pending result prohibit161; house receipt cannot bypass the existing result gate", () => {
  const e = create();
  e.session.db.exec(
    "CREATE TRIGGER TestMoneyFailure BEFORE INSERT ON RuntimeMoneyPickup BEGIN SELECT RAISE(FAIL,'fixture-money'); END",
  );
  SendMoney(e);
  expect(() => SendHouse(e)).toThrow(CProtocolError);
  expect(HouseReceiptCount(e.db)).toBe(0);
  const f = create();
  f.session.db.exec(
    "CREATE TRIGGER TestResultFailure BEFORE INSERT ON RuntimeGameResult BEGIN SELECT RAISE(FAIL,'fixture-result'); END",
  );
  SubmitMoneyRoundClaims(f);
  f.clear();
  expect(() => f.room.Update()).toThrow("fixture-result");
  expect(f.room.IsResultCommitPending()).toBe(true);
  expect(() => SendHouse(f)).toThrow(CProtocolError);
  expect(HouseReceiptCount(f.db)).toBe(0);
  noPackets(f);
});
test("house and item money interleave before genuine settlement; 163 snapshots include all awards,164 retains board,106 resets it and allocator before new UUID/ordinal1", () => {
  const e = create(),
    ctx = e.room.GetCurrentGameContext();
  const key = e.room.GetResultRoundID()!;
  SendHouse(e, 1, undefined, [[255, 128, 90]]);
  e.clear();
  SendMoney(e, 1, 0, 25);
  e.clear();
  SendHouse(
    e,
    1,
    [
      [0, 1],
      [12, 14],
    ],
    [],
  );
  e.clear();
  expect(e.db.GetUserInfo("Partner")!.Money).toBe(25);
  expect(e.room.GetHouseClaimState().Sequence).toBe(2);
  expect(e.room.GetMoneyPickupState().Sequence).toBe(1);
  SubmitMoneyRoundClaims(e);
  e.clear();
  e.time(101);
  e.room.Update();
  e.clear();
  const receipt = e.db.GetGameResultReceipt(key)!,
    data = JSON.parse(receipt.Payload),
    player = data.Changes.find((c: { Slot: number }) => c.Slot === 1);
  expect([player.Before.Money, player.After.Money]).toEqual([25, 25]);
  expect(e.room.m_nGameState).toBe(GameStage.Result);
  e.time(8103);
  e.room.Update();
  e.clear();
  expect(ctx.m_aHouseState[0]).toBe(1);
  expect(ctx.m_nNextBoxItem).toBe(127);
  e.table.OnPacket(Received(new CSendPacket(96).Encode1(1)), e.clients[1]!);
  e.clear();
  e.table.OnPacket(Received(new CSendPacket(106)), e.clients[0]!);
  e.clear();
  expect(e.room.m_nGameState).toBe(GameStage.Loading);
  expect([...ctx.m_aHouseState]).toEqual(Array(195).fill(-1));
  expect([...ctx.m_aHouseCount]).toEqual(Array(8).fill(0));
  expect(ctx.m_nNextBoxItem).toBe(126);
  for (const [i, peer] of e.clients.entries()) {
    expect(DiscoverLaunchPeer(e.room, peer, 43000 + i)).toBe(false);
    e.table.OnPacket(Received(LaunchReadyPacket(e.room, peer)), peer);
  }
  e.clear();
  expect(e.room.GetResultRoundID()).not.toBe(key);
  expect(e.room.GetHouseClaimState().Sequence).toBe(0);
  SendHouse(e);
  response(e, [1, 2, 0, 0, 0, 1, 5, 0]);
  expect(e.db.GetUserInfo("Partner")!.Money).toBe(35);
  expect(HouseReceiptCount(e.db)).toBe(3);
});

test("zero houses/zero drops still creates178 and a durable zero-delta receipt and sets native user dirty bit from0 to1", () => {
  const e = create(),
    user = e.room.m_rgPlayer[1]!,
    before = HouseLive(e);
  noClockOrRandom(e);
  expect(user.GetDynamicInfoSnapshot().DynamicModified).toBe(0);
  SendHouse(e, 1, [], []);
  response(e, [1, 0, 5, 0]);
  expect(user.GetDynamicInfoSnapshot().DynamicModified).toBe(1);
  const after = HouseLive(e);
  expect({ ...after, Users: before.Users }).toEqual(before);
  expect(HouseReceiptCount(e.db)).toBe(1);
  expect(e.db.GetUserInfo("Partner")!.Money).toBe(0);
});
test("house CAS conflicts freeze without rebasing even if wallet is later restored; trusted restoration retries the identical frozen calculation", () => {
  const e = create();
  e.session.db.exec("UPDATE FxUserDynamic SET Exp=1 WHERE ID='Partner'");
  const before = HouseLive(e);
  SendHouse(e);
  expect(e.room.GetHouseClaimState().Failure).toBe("conflict");
  expect(HouseLive(e)).toEqual(before);
  noPackets(e);
  expect(HouseReceiptCount(e.db)).toBe(0);
  noClockOrRandom(e);
  e.room.Update();
  expect(HouseLive(e)).toEqual(before);
  e.session.db.exec("UPDATE FxUserDynamic SET Exp=0 WHERE ID='Partner'");
  e.room.Update();
  response(e, [1, 2, 0, 0, 0, 1, 5, 0]);
  expect(e.db.GetUserInfo("Partner")!.Money).toBe(10);
  expect(HouseReceiptCount(e.db)).toBe(1);
  expect(e.room.GetHouseClaimState().Sequence).toBe(1);
});
test("SQL callback cannot reenter gameplay or mutate a frozen world unnoticed AFTER durable COMMIT; no stale live install or repayment", () => {
  const e = create(),
    original = e.db.CommitHouseClaim;
  let calls = 0;
  const errors: unknown[] = [];
  e.db.CommitHouseClaim = function (p) {
    calls++;
    try {
      expect(() => SendHouse(e)).toThrow(CProtocolError);
      expect(() => SendMoney(e)).toThrow(CProtocolError);
      expect(() => e.room.DestroyPlayer(e.clients[1]!)).toThrow(CProtocolError);
      expect(() => e.room.Update()).not.toThrow();
    } catch (error) {
      errors.push(error);
    }
    const status = original.call(this, p);
    if (calls === 1) e.room.GetCurrentGameContext().m_nNextBoxItem = 127;
    return status;
  };
  SendHouse(e);
  expect(errors).toEqual([]);
  noPackets(e);
  expect(e.room.GetHouseClaimState().Failure).toBe("state-changed");
  expect(e.room.m_rgPlayer[1]!.m_userInfo.Money).toBe(0);
  expect(e.db.GetUserInfo("Partner")!.Money).toBe(10);
  noClockOrRandom(e);
  e.room.Update();
  expect(calls).toBe(1);
  e.room.GetCurrentGameContext().m_nNextBoxItem = 126;
  e.room.Update();
  response(e, [1, 2, 0, 0, 0, 1, 5, 0]);
  expect(calls).toBe(2);
  expect(HouseReceiptCount(e.db)).toBe(1);
  expect(e.db.GetUserInfo("Partner")!.Money).toBe(10);
});
test("a trusted durable result closing the round during lost-house-ACK freezes rather than installing stale board after settlement", async () => {
  const { EmptyHouseResult } = await import("./helpers/HouseClaim.ts");
  const e = create(),
    original = e.db.CommitHouseClaim;
  e.db.CommitHouseClaim = function (p) {
    const status = original.call(this, p);
    expect(status).toBe("committed");
    this.CommitGameResult(EmptyHouseResult(p));
    throw new Error("trusted closure after COMMIT");
  };
  SendHouse(e);
  e.db.CommitHouseClaim = original;
  const before = HouseLive(e);
  noClockOrRandom(e);
  e.room.Update();
  expect(HouseLive(e)).toEqual(before);
  expect(e.room.GetHouseClaimState().Failure).toBe("stored-state-changed");
  noPackets(e);
  expect(HouseReceiptCount(e.db)).toBe(1);
  expect(e.db.GetGameResultReceipt(e.room.GetResultRoundID()!)).toBeDefined();
});
test("ordinal UINT32 exhaustion cannot wrap/reuse a receipt and detached calculation exceptions cannot publish valid-prefix house state", () => {
  const e = create();
  (
    e.room as unknown as { m_resultRound: { HouseSequence: number } }
  ).m_resultRound.HouseSequence = 0xffffffff;
  const before = HouseLive(e);
  noClockOrRandom(e);
  expect(() => SendHouse(e)).toThrow("sequence exhausted");
  expect(HouseLive(e)).toEqual(before);
  noPackets(e);
  expect(HouseReceiptCount(e.db)).toBe(0);
  expect(e.room.IsHouseClaimPending()).toBe(false);
  const f = create(),
    user = f.room.m_rgPlayer[1]!,
    clone = user.CloneForResultCalculation,
    original = HouseLive(f);
  user.CloneForResultCalculation = () => {
    throw new Error("detached calculation unavailable");
  };
  expect(() => SendHouse(f)).toThrow("detached calculation unavailable");
  expect(HouseLive(f)).toEqual(original);
  noPackets(f);
  expect(HouseReceiptCount(f.db)).toBe(0);
  user.CloneForResultCalculation = clone;
  SendHouse(f);
  response(f, [1, 2, 0, 0, 0, 1, 5, 0]);
});

test("genuine161 board counts feed existing162 arbitration ->claims/163 for winner AND tie without fabricated counters, deaths or player-state claims", () => {
  for (const tied of [false, true]) {
    const e = create(),
      ctx = e.room.GetCurrentGameContext(),
      key = e.room.GetResultRoundID()!;
    expect(e.room.m_rgSlotInfo[0]![2]! & 31).toBe(
      e.room.m_rgSlotInfo[1]![2]! & 31,
    );
    expect(e.room.m_rgSlotInfo[1]![2]! & 31).not.toBe(
      e.room.m_rgSlotInfo[2]![2]! & 31,
    );
    SendHouse(
      e,
      1,
      tied
        ? [[0, 0]]
        : [
            [0, 0],
            [0, 1],
          ],
      [],
    );
    e.clear();
    SendHouse(e, 2, [[12, 14]], []);
    e.clear();
    expect(ctx.m_aHouseCount[e.room.m_rgSlotInfo[1]![2]! & 31]).toBe(
      tied ? 1 : 2,
    );
    e.table.OnPacket(Received(new CSendPacket(162)), e.clients[1]!);
    noPackets(e);
    expect([...e.room.m_aPlayerState].slice(0, 3)).toEqual(
      tied ? [7, 7, 7] : [6, 6, 0],
    );
    const decision = e.room.GetGameEndDecision();
    expect(decision.Forced).toBe(!tied);
    expect(decision.Ready).toBe(true);
    expect(decision.WinningColor).toBe(
      tied ? -1 : e.room.m_rgSlotInfo[1]![2]! & 31,
    );
    e.time(101);
    e.room.Update();
    expect(e.room.m_nGameState).toBe(GameStage.Result);
    expect(
      JSON.parse(e.db.GetGameResultReceipt(key)!.Payload).WinningColor,
    ).toBe(decision.WinningColor);
    expect(e.db.GetUserInfo("Partner")!.Money).toBe(tied ? 5 : 10);
    expect(e.db.GetUserInfo("Bob")!.Money).toBe(5);
    expect(HouseReceiptCount(e.db)).toBe(2);
    for (const peer of e.clients) expect(peer.Take(163)).toBeDefined();
  }
});
