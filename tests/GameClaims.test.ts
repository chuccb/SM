import { afterEach, expect, test } from "bun:test";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CReceivedPacketBase } from "../Common/CReceivedPacketBase.ts";
import {
  CProtocolError,
  CUnsupportedOperation,
} from "../Common/CProtocolError.ts";
import {
  CipherDegree,
  GameStage,
  GamePlayerState,
} from "../Common/OfficialValues.ts";
import { CPeImage, OFFICIAL_SERVICES } from "../Tools/OfficialSource.ts";
import {
  GameLaunchFixture,
  DiscoverLaunchPeer,
  LaunchReadyPacket,
} from "./helpers/GameLaunch.ts";
import { Received } from "./helpers/Clients.ts";
import type { MemoryClient } from "./helpers/Clients.ts";
import {
  SendMoney,
  MoneyReceiptCount,
  SubmitMoneyRoundClaims,
} from "./helpers/MoneyPickup.ts";
import vectors from "./fixtures/game-claims-vectors.json";

type Environment = ReturnType<typeof GameLaunchFixture>;
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function start(e: Environment) {
  e.table.OnPacket(Received(new CSendPacket(106)), e.clients[0]!);
  if (!e.room.IsLoadingGame()) throw new Error("Native106 did not commit");
  for (const [i, peer] of e.clients.entries()) {
    // A second genuine launch retains discovery; no private clock/UUID writes.
    DiscoverLaunchPeer(e.room, peer, 44000 + i);
    e.table.OnPacket(Received(LaunchReadyPacket(e.room, peer)), peer);
  }
  if (e.room.m_nGameState !== GameStage.Running || !e.room.GetResultRoundID())
    throw new Error("Native109/discovery/150 did not commit");
  e.clear();
}
function create(counts: readonly number[] = [2, 1], launch = true) {
  const e = GameLaunchFixture(counts);
  cleanup.push(e.close);
  if (launch) start(e);
  return e;
}
function dispose(e: Environment) {
  cleanup.splice(cleanup.indexOf(e.close), 1);
  e.close();
}
function send(e: Environment, packet: CSendPacket, peer = e.clients[0]!) {
  e.table.OnPacket(Received(packet), peer);
}
function raw(e: Environment, hex: string, peer = e.clients[0]!) {
  e.table.OnPacket(
    new CReceivedPacketBase(Buffer.from(hex, "hex"), CipherDegree.CRC8),
    peer,
  );
}
function bodies(e: Environment, hex: string, except?: MemoryClient) {
  for (const peer of e.clients) {
    const target = e.room.GetSockets().includes(peer) && peer !== except;
    expect(peer.packets.map((p) => p.m_pBlock.toString("hex"))).toEqual(
      target ? [hex] : [],
    );
  }
  e.clear();
}
function noPackets(e: Environment) {
  for (const peer of e.clients) expect(peer.packets).toEqual([]);
}
function snapshot(e: Environment) {
  const c = e.room.GetCurrentGameContext();
  return {
    Playing: e.room.m_bPlaying,
    Stage: e.room.m_nGameState,
    Launch: e.room.GetGameLaunchState(),
    Round: e.room.GetResultRoundID(),
    Update: e.room.GetLastUpdateTime(),
    States: [...e.room.m_aPlayerState],
    Clock: [
      e.clock.GetStartGameTime(),
      e.clock.GetEndGameTime(),
      e.clock.m_dwTimeStopped,
    ],
    Users: e.room.m_rgPlayer.map(
      (u) =>
        u && {
          Snapshot: u.GetDynamicInfoSnapshot(),
          Inventory: structuredClone(u.m_aInventory),
          Stored: e.db.GetUserInfo(u.GetName()),
        },
    ),
    Context: {
      Bula: [...c.m_aBulaState],
      House: [...c.m_aHouseState],
      Counts: [...c.m_aHouseCount],
      Box: [...c.m_aBoxItemState],
      Obstacle: [...c.m_aObstacleState],
      NextBox: c.m_nNextBoxItem,
      Bombs: structuredClone(c.m_aBomb),
      NextBomb: c.m_nNextBombSerialNo,
      Times: [...c.m_aPlayerStateTime],
      Points: structuredClone(c.m_aGhostPosition),
    },
    Statistics: e.room.m_dynInfoCalculator.GetStateBytes().toString("hex"),
    Ghosts: [
      [...e.room.m_anSlotGhost],
      [...e.room.m_anGhostSlot],
      e.room.m_nGhostCount,
    ],
    Sync: e.room.m_syncGameObjMan.GetObjectCount(),
    Money: e.room.GetMoneyPickupState(),
    ReceiptCounts: e.session.db
      .query(
        "SELECT (SELECT count(*) FROM RuntimeMoneyPickup) AS money, (SELECT count(*) FROM RuntimeGameResult) AS result",
      )
      .get(),
  };
}
function noClockOrRandom(e: Environment) {
  e.random(() => {
    throw new Error("This native handler does not draw RNG");
  });
  e.clock.GetCurrentTime = () => {
    throw new Error("This native handler does not sample current time");
  };
  e.clock.ElapsedTime = () => {
    throw new Error("This native handler does not sample elapsed time");
  };
}
function event8(slot = 1, first = 255, second = 128) {
  return new CSendPacket(146)
    .Encode1(0x80 | slot)
    .Encode2(0xffff)
    .Encode2(0x8000)
    .Encode1(first)
    .Encode1(second);
}
function bula(state = 255, row = 0, column = 45) {
  return new CSendPacket(160)
    .Encode1(state)
    .Encode1(1)
    .Encode1(row)
    .Encode1(column);
}
function lap(slot = 1, first = 255, second = 128) {
  return new CSendPacket(155).Encode1(slot).Encode1(first).Encode1(second);
}

test("PE anchors independently pin Bula177/lap170/opaque8 and genuine C3 resurrection; model is explicitly NOT an official execution oracle", () => {
  const image = new CPeImage(OFFICIAL_SERVICES.FXGS);
  expect(image.sha256).toBe(vectors.OfficialPE.SHA256);
  expect(vectors.Evidence).toContain("NOT native execution");
  for (const anchor of vectors.InstructionAnchors)
    expect(image.read(anchor.VA, anchor.Bytes.length / 2).toString("hex")).toBe(
      anchor.Bytes,
    );
  expect(image.read(0x0041b5c8, 1).toString("hex")).toBe("c3");
  expect(vectors.BulaCells.length + vectors.BulaOverruns.length).toBe(65536);
  expect(vectors.BulaCells).toHaveLength(6051);
  expect(vectors.BulaOverruns).toHaveLength(59485);
});

test("all6051 safe Bula byte pairs match C++ scalar-coded177 and state writes, including4881 in-plane column aliases; first BYTE is NOT actor", () => {
  const e = create(),
    c = e.room.GetCurrentGameContext(),
    before = snapshot(e);
  noClockOrRandom(e);
  const expected = Array(1170).fill(-1);
  for (const row of vectors.BulaCells) {
    raw(e, row.Request, e.clients[1]!); // nonchief, a different slot from most stored values
    bodies(e, row.Response);
    for (const [index, value] of row.Writes) {
      expected[index!] = value;
      expect(c.m_aBulaState[index!]).toBe(value!);
    }
  }
  const after = snapshot(e);
  expect(after.Context.Bula).toEqual(expected);
  after.Context.Bula = before.Context.Bula;
  expect(after).toEqual(before);
});

test("all59485 out-of-Bula-plane byte pairs reject without native memory corruption, partial changes, clock/RNG/SQL awards or broadcasts", () => {
  const e = create(),
    before = snapshot(e);
  noClockOrRandom(e);
  for (const packed of vectors.BulaOverruns)
    expect(() => send(e, bula(7, packed >>> 8, packed & 255))).toThrow(
      CProtocolError,
    );
  noPackets(e);
  expect(snapshot(e)).toEqual(before);
}, 15000);

test("Bula count0..255 batches match C++ full body and final plane, preserve input aliases/duplicates/order and overwrite nonzero states", () => {
  const e = create(),
    c = e.room.GetCurrentGameContext();
  noClockOrRandom(e);
  for (const row of vectors.BulaBatches) {
    c.m_aBulaState.fill(37); // explicit native-state image setup, not a network reset
    const expected = Array(1170).fill(37);
    raw(e, row.Request);
    bodies(e, row.Response);
    for (const [index, state] of row.Writes) expected[index!] = state;
    expect([...c.m_aBulaState]).toEqual(expected);
  }
  expect(MoneyReceiptCount(e.db)).toBe(0);
});

test("Bula framing and late invalid cells are preflighted as a whole; no valid prefix is written or forwarded on malformed data", () => {
  const e = create(),
    before = snapshot(e);
  noClockOrRandom(e);
  const valid = new CSendPacket(160)
    .Encode1(255)
    .Encode1(2)
    .Encode1(0)
    .Encode1(45)
    .Encode1(25)
    .Encode1(44)
    .GetBuffer();
  for (let length = 1; length < valid.length; length++)
    expect(() => raw(e, valid.subarray(0, length).toString("hex"))).toThrow(
      CProtocolError,
    );
  expect(() =>
    raw(e, Buffer.concat([valid, Buffer.from([0])]).toString("hex")),
  ).toThrow(CProtocolError);
  expect(() =>
    send(
      e,
      new CSendPacket(160)
        .Encode1(0)
        .Encode1(2)
        .Encode1(0)
        .Encode1(45)
        .Encode1(25)
        .Encode1(45),
    ),
  ).toThrow("Bula flat index");
  noPackets(e);
  expect(snapshot(e)).toEqual(before);
});

function runLapCase(row: (typeof vectors.LapTopologies)[number]) {
  const e = create(Array(8).fill(1));
  try {
    // REAL table departure, not a fake occupied mask or edited private round.
    for (let i = 0; i < 8; i++)
      if (!(row.Mask & (1 << i)))
        expect(e.table.DestroyPlayer(e.clients[i]!)).toBe(true);
    e.clear();
    const source = e.clients.find((peer) =>
      e.room.GetSockets().includes(peer),
    )!;
    for (const step of row.Steps) {
      e.time(step.Tick);
      raw(e, step.Request, source); // native intentionally permits foreign/vacant target slots
      bodies(e, step.Response);
      const state = e.room.GetGameLaunchState();
      expect(state.LapSort).toEqual(step.Sort);
      expect(state.LapPrefix).toEqual(step.Prefix);
    }
    expect(MoneyReceiptCount(e.db)).toBe(0);
  } finally {
    dispose(e);
  }
}
test("all247 native sparse2..8 player topologies after REAL departures match C++ unsigned64 rankings, vacant writes, unknown reports and slot tie breaks", () => {
  for (const row of vectors.LapTopologies) runLapCase(row);
}, 15000);
test("72 lap sequences match C++ across absolute0/1/7FFFFFFF/80000000/FFFFFFFE/FFFFFFFF ticks; progress priority, equal-time ties and wrap do not use signed ordering", () => {
  for (const row of vectors.LapBoundaries) runLapCase(row);
}, 15000);

test("lap reported count excludes unknown occupied records but their ranks still participate; nonchief may report another player or a vacant slot", () => {
  const e = create();
  e.time(0xffffffff);
  send(e, lap(2, 127, 128), e.clients[0]!);
  const expected = new CSendPacket(170)
    .Encode1(1)
    .Encode1(2)
    .Encode1(0)
    .Encode1(3)
    .Encode1(0)
    .Encode1(1)
    .Encode1(127);
  for (let i = 3; i < 8; i++) expected.Encode1(255).Encode1(255);
  bodies(e, expected.GetBuffer().toString("hex"));
  const prefix = e.room.GetGameLaunchState().LapPrefix;
  send(e, lap(7, 255, 255), e.clients[1]!);
  for (const peer of e.clients) {
    const packet = peer.Take(170);
    expect(packet.Decode1()).toBe(1);
    for (let i = 0; i < 8; i++) {
      const rank = packet.Decode1(),
        first = packet.Decode1();
      if (i >= 3) expect([rank, first]).toEqual([255, 255]);
    }
    packet.AssertEnd();
  }
  expect(e.room.GetGameLaunchState().LapPrefix.slice(0, 7)).toEqual(
    prefix.slice(0, 7),
  );
  expect(e.room.GetGameLaunchState().LapSort.slice(14)).toEqual([
    0xffffffff, 0,
  ]);
  expect(e.room.GetGameLaunchState().LapPrefix[7]).toBe(255);
});

test("lap samples absolute time ONCE after full validation, not elapsed/paused duration; does not claim victory, modify stats/wallet, end clocks or advance Update delta", () => {
  const e = create(),
    before = snapshot(e);
  let reads = 0;
  e.clock.m_dwTimeStopped = 0xfedcba98;
  e.clock.GetCurrentTime = () => {
    reads++;
    return 0x80000001;
  };
  e.clock.ElapsedTime = () => {
    throw new Error("not native elapsed time");
  };
  e.random(() => {
    throw new Error("not a native random draw");
  });
  send(e, lap(0, 128, 255));
  expect(reads).toBe(1);
  expect(e.room.GetGameLaunchState().LapSort.slice(0, 2)).toEqual([
    0x80000001, 0x7f00,
  ]);
  const after = snapshot(e);
  after.Launch.LapSort = before.Launch.LapSort;
  after.Launch.LapPrefix = before.Launch.LapPrefix;
  after.Clock[2] = before.Clock[2]!;
  expect(after).toEqual(before);
  expect(e.room.m_aPlayerState[0]).toBe(GamePlayerState.Active);
  expect(e.room.IsResultCommitPending()).toBe(false);
});

test("all invalid lap slot BYTEs and truncated/trailing bodies reject BEFORE a clock sample or state/publication change", () => {
  const e = create(),
    before = snapshot(e);
  noClockOrRandom(e);
  for (let slot = 8; slot < 256; slot++)
    expect(() => send(e, lap(slot))).toThrow(CProtocolError);
  for (const packet of [
    new CSendPacket(155),
    new CSendPacket(155).Encode1(0),
    new CSendPacket(155).Encode1(0).Encode1(1),
    lap().Encode1(0),
  ])
    expect(() => send(e, packet)).toThrow(CProtocolError);
  noPackets(e);
  expect(snapshot(e)).toEqual(before);
});

test("10240 event8 C++ images prove BOTH opaque bytes and WORDs are echoed unchanged, actor0..7 valid, excluding the WHOLE sender TCP, without resurrection side effects", () => {
  const e = create([2, 2, 2, 2]);
  noClockOrRandom(e);
  e.room.m_aPlayerState.set([0, 1, 2, 3, 4, 5, 6, 7]); // explicit state image, not an eligible rebirth rule
  const before = snapshot(e);
  for (const row of vectors.OpaqueEvents) {
    const peer = e.clients[Math.floor(row.Slot / 2)]!;
    raw(e, row.Request, peer);
    for (const target of e.clients) {
      if (target === peer) continue;
      const p = target.packets[0]!;
      // Check numeric WORDs independently too: a wrong-endian request+echo
      // model can otherwise self-cancel and falsely pass raw round trips.
      expect([
        p.Decode1(),
        p.Decode1(),
        p.Decode2(),
        p.Decode2(),
        p.Decode1(),
        p.Decode1(),
      ]).toEqual([159, 0x80 | row.Slot, row.X, row.Y, row.First, row.Second]);
      p.AssertEnd();
    }
    bodies(e, row.Response, peer);
  }
  expect(snapshot(e)).toEqual(before);
});

test("event8 malformed bodies, foreign/unowned actor and invalid low-nibble slots reject atomically; truncated event0 and client5 remain fail-closed", () => {
  const e = create(),
    before = snapshot(e),
    valid = event8().GetBuffer();
  noClockOrRandom(e);
  for (let length = 1; length < valid.length; length++)
    expect(() => raw(e, valid.subarray(0, length).toString("hex"))).toThrow(
      CProtocolError,
    );
  expect(() =>
    raw(e, Buffer.concat([valid, Buffer.from([0])]).toString("hex")),
  ).toThrow(CProtocolError);
  expect(() => send(e, event8(2))).toThrow(CProtocolError);
  for (let slot = 3; slot < 16; slot++)
    expect(() => send(e, event8(slot))).toThrow(CProtocolError);
  expect(() =>
    send(e, new CSendPacket(146).Encode1(0).Encode2(0).Encode2(0)),
  ).toThrow(CProtocolError);
  expect(() =>
    send(e, new CSendPacket(146).Encode1(0x50).Encode2(0).Encode2(0)),
  ).toThrow("server-only");
  noPackets(e);
  expect(snapshot(e)).toEqual(before);
});

test("DeferResurrection is the native NO-OP even with state3/4/ghosts/positions/timestamps; it does not invent revive eligibility, notifications or clock/RNG reads", () => {
  const e = create();
  e.room.m_aPlayerState.set([3, 4, 1, 2, 5, 6, 7, 255]);
  e.room.GetCurrentGameContext().m_aGhostPosition[0] = { x: 12345, y: 54321 };
  e.room.GetCurrentGameContext().m_aPlayerStateTime[0] = 0xffffffff;
  const before = snapshot(e);
  noClockOrRandom(e);
  e.room.DeferResurrection();
  noPackets(e);
  expect(snapshot(e)).toEqual(before);
});

test("new native paths reject waiting/Loading/Result and trusted synthetic Running; public flags or BeginResultLifecycle do not authorize them", () => {
  const e = create([2, 1], false);
  for (const packet of [bula(), lap(), event8()])
    expect(() => send(e, packet)).toThrow();
  e.room.PrepareRoundStatistics();
  e.room.m_bPlaying = true;
  e.room.m_nGameState = GameStage.Running;
  e.room.BeginResultLifecycle(); // trusted legacy kernel adapter, NOT native106/150
  const before = snapshot(e);
  for (const packet of [bula(), lap(), event8()])
    expect(() => send(e, packet)).toThrow(CUnsupportedOperation);
  noPackets(e);
  expect(snapshot(e)).toEqual(before);
  dispose(e);
  const actual = create();
  for (const stage of [GameStage.Loading, GameStage.Result]) {
    actual.room.m_nGameState = stage; // explicit phase rejection image
    const baseline = snapshot(actual);
    for (const packet of [bula(), lap(), event8()])
      expect(() => send(actual, packet)).toThrow(CProtocolError);
    noPackets(actual);
    expect(snapshot(actual)).toEqual(baseline);
  }
});

test("full local-player group and generation preflight rejects stale SECONDARY even for no-actor Bula/lap, before body processing or a clock sample", () => {
  const e = create(),
    user = e.clients[0]!.m_aUser[1]!;
  noClockOrRandom(e);
  for (const corrupt of [
    () => {
      const original = user.m_nSlotIdx;
      user.m_nSlotIdx = 7;
      return () => {
        user.m_nSlotIdx = original;
      };
    },
    () => {
      const original = user.m_nSessionSerialNo;
      user.m_nSessionSerialNo++;
      return () => {
        user.m_nSessionSerialNo = original;
      };
    },
    () => {
      const original = user.m_pClientSocket;
      user.m_pClientSocket = e.clients[1]!;
      return () => {
        user.m_pClientSocket = original;
      };
    },
  ]) {
    const restore = corrupt(),
      before = snapshot(e);
    try {
      for (const packet of [bula(), lap(), event8(0)])
        expect(() => send(e, packet)).toThrow(CProtocolError);
      noPackets(e);
      expect(snapshot(e)).toEqual(before);
    } finally {
      restore();
    }
  }
});

test("detached publication sees completed Bula/lap/event8 transitions; reentry cannot mutate rounds, removal or gameplay and first-target send failure cannot corrupt later peers", () => {
  for (const opcode of [160, 155, 146]) {
    const e = create([2, 1, 1]),
      first = e.clients[0]!,
      original = first.SendPacket;
    e.time(12345);
    let callbacks = 0,
      callbackFailure: unknown;
    const request =
      opcode === 160 ? bula() : opcode === 155 ? lap(2, 255, 255) : event8(2);
    const peer = opcode === 146 ? e.clients[1]! : first;
    let expectedBody = "";
    first.SendPacket = function (p) {
      callbacks++;
      expectedBody = p.GetBuffer().toString("hex");
      try {
        if (opcode === 160)
          expect(e.room.GetCurrentGameContext().m_aBulaState[45]).toBe(255);
        if (opcode === 155)
          expect(e.room.GetGameLaunchState().LapSort.slice(4, 6)).toEqual([
            12345, 0,
          ]);
        for (const packet of [bula(), lap(), event8()])
          expect(() => send(e, packet)).toThrow(CProtocolError);
        const beforeUpdate = snapshot(e);
        expect(() => e.room.Update()).not.toThrow(); // transition lock: native driver no-op, not an exception
        expect(snapshot(e)).toEqual(beforeUpdate);
        expect(() => e.table.DestroyPlayer(e.clients[1]!)).toThrow(
          CProtocolError,
        );
        expect(() => e.room.PrepareRoundStatistics()).toThrow(CProtocolError);
        expect(e.room.DeferHandleGameEnd()).toBe(false);
      } catch (error) {
        callbackFailure = error;
      }
      p.GetBuffer().fill(0);
      throw new Error("fixture first-target detached publication failure");
    };
    try {
      send(e, request, peer);
    } finally {
      first.SendPacket = original;
    }
    expect(callbacks).toBe(1);
    // Transport deliberately isolates callback errors. An assertion must be
    // re-thrown/checked OUTSIDE that boundary rather than accidentally swallowed.
    expect(callbackFailure).toBeUndefined();
    expect(first.packets).toEqual([]);
    for (const later of e.clients.slice(1))
      expect(later.packets.map((p) => p.m_pBlock.toString("hex"))).toEqual(
        opcode === 146 && later === peer ? [] : [expectedBody],
      );
    expect(e.room.GetPacketPublicationFailureCount()).toBe(1);
    expect(MoneyReceiptCount(e.db)).toBe(0);
    dispose(e);
  }
});

test("pending frozen money blocks all three new wire/direct gameplay paths BEFORE clocks, board changes, rank progress or event publication; no-op resurrection stays inert", () => {
  const e = create(),
    commit = e.db.CommitMoneyPickup;
  e.db.CommitMoneyPickup = () => "conflict";
  SendMoney(e);
  expect(e.room.IsMoneyPickupPending()).toBe(true);
  const before = snapshot(e);
  noClockOrRandom(e);
  for (const packet of [bula(), lap(), event8()])
    expect(() => send(e, packet)).toThrow(CProtocolError);
  expect(() => e.room.OnReqEatBula(Received(bula()), e.clients[0]!)).toThrow(
    CProtocolError,
  );
  expect(() => e.room.OnLapInfo(Received(lap()), e.clients[0]!)).toThrow(
    CProtocolError,
  );
  expect(() =>
    e.room.OnSetBomberEvent(Received(event8()), e.clients[0]!),
  ).toThrow(CProtocolError);
  e.room.DeferResurrection();
  noPackets(e);
  expect(snapshot(e)).toEqual(before);
  e.db.CommitMoneyPickup = commit;
  e.room.Update(); // same plan, before current-time sampling; no reroll/rebase
  expect(e.room.IsMoneyPickupPending()).toBe(false);
  expect(e.room.GetMoneyPickupState().Sequence).toBe(1);
  expect(MoneyReceiptCount(e.db)).toBe(1);
  expect(e.room.m_rgPlayer[1]!.m_userInfo.Money).toBe(10);
  expect([...e.room.GetCurrentGameContext().m_aBulaState]).toEqual(
    before.Context.Bula,
  );
  expect(e.room.GetGameLaunchState().LapSort).toEqual(before.Launch.LapSort);
});

test("pending frozen result also blocks Bula/lap/event8 with the same captured result baseline, without releasing or modifying its receipt", () => {
  const e = create();
  SubmitMoneyRoundClaims(e);
  e.clear();
  e.db.CommitGameResult = () => "conflict";
  e.time(101);
  e.room.Update();
  expect(e.room.IsResultCommitPending()).toBe(true);
  const before = snapshot(e);
  noClockOrRandom(e);
  for (const packet of [bula(), lap(), event8()])
    expect(() => send(e, packet)).toThrow(CProtocolError);
  e.room.DeferResurrection();
  noPackets(e);
  expect(snapshot(e)).toEqual(before);
});

test("house161 now binds its native5-per-new-cell award to independent SQLite receipt before178", () => {
  const e = create(),
    before = snapshot(e);
  noClockOrRandom(e);
  const request = new CSendPacket(161)
    .Encode1(1)
    .Encode1(2)
    .Encode1(0)
    .Encode1(0)
    .Encode1(0)
    .Encode1(1)
    .Encode1(0);
  send(e, request);
  expect(e.db.GetUserInfo(e.room.m_rgPlayer[1]!.GetName())!.Money).toBe(10);
  expect(e.room.GetCurrentGameContext().m_aHouseState[0]).toBe(1);
  expect(e.room.GetHouseClaimState().Sequence).toBe(1);
  expect(
    e.db.GetHouseClaimReceipt(e.room.GetResultRoundID()!, 1),
  ).toBeDefined();
  for (const peer of e.clients) {
    const p = peer.Take(178);
    expect(Array.from({ length: 8 }, () => p.Decode1())).toEqual([
      1, 2, 0, 0, 0, 1, 5, 0,
    ]);
    p.AssertEnd();
  }
  expect(snapshot(e).Launch).toEqual(before.Launch);
});

test("164 preserves Bula and lap state; the next GENUINE106 resets both already in Loading, retains peers, and only109/150 obtains a new UUID", () => {
  const e = create(),
    ctx = e.room.GetCurrentGameContext(),
    key = e.room.GetResultRoundID();
  send(e, bula());
  e.clear();
  e.time(101);
  send(e, lap(2, 77, 128));
  e.clear();
  const sort = e.room.GetGameLaunchState().LapSort,
    prefix = e.room.GetGameLaunchState().LapPrefix;
  SubmitMoneyRoundClaims(e);
  e.clear();
  e.time(102);
  e.room.Update();
  e.clear();
  expect(e.room.m_nGameState).toBe(GameStage.Result);
  expect(e.db.GetGameResultReceipt(key!)).toBeDefined();
  e.time(8103);
  e.room.Update();
  e.clear();
  expect(e.room.m_bPlaying).toBe(false);
  expect(ctx.m_aBulaState[45]).toBe(255);
  expect(e.room.GetGameLaunchState().LapSort).toEqual(sort);
  expect(e.room.GetGameLaunchState().LapPrefix).toEqual(prefix);
  send(e, new CSendPacket(96).Encode1(1), e.clients[1]!);
  e.clear();
  send(e, new CSendPacket(106));
  expect(e.room.IsLoadingGame()).toBe(true);
  expect([...ctx.m_aBulaState]).toEqual(Array(1170).fill(-1));
  expect(e.room.GetGameLaunchState().LapSort).toEqual(
    Array(16).fill(0xffffffff),
  );
  expect(e.room.GetGameLaunchState().LapPrefix).toEqual(Array(8).fill(0));
  expect(e.room.GetResultRoundID()).toBeUndefined();
  expect(e.room.HasUDPPeerInfo(0)).toBe(true);
  expect(e.room.HasUDPPeerInfo(2)).toBe(true);
  for (const peer of e.clients)
    e.table.OnPacket(Received(LaunchReadyPacket(e.room, peer)), peer);
  expect(e.room.m_nGameState).toBe(GameStage.Running);
  expect(e.room.GetResultRoundID()).not.toBe(key);
  expect(MoneyReceiptCount(e.db)).toBe(0);
});

test("the lap absolute-clock callback cannot reenter any new gameplay/removal/driver path before ranking; throwing time provider leaves NO partial sort/prefix/body", () => {
  const e = create(),
    before = snapshot(e);
  let reads = 0;
  e.clock.GetCurrentTime = () => {
    reads++;
    for (const packet of [bula(), lap(), event8()])
      expect(() => send(e, packet)).toThrow(CProtocolError);
    expect(() => e.table.DestroyPlayer(e.clients[1]!)).toThrow(CProtocolError);
    expect(() => e.room.Update()).not.toThrow();
    throw new Error("fixture failed time source before any lap write");
  };
  expect(() => send(e, lap(0))).toThrow("fixture failed time source");
  expect(reads).toBe(1);
  noPackets(e);
  expect(snapshot(e)).toEqual(before);
  e.clock.GetCurrentTime = () => 12345;
  send(e, lap(0, 255, 255));
  expect(e.room.GetGameLaunchState().LapSort.slice(0, 2)).toEqual([12345, 0]);
  for (const peer of e.clients)
    expect(peer.packets.map((p) => p.m_nPacketType)).toEqual([170]);
});

test("closed or marked-free native local-group members cannot use Bula/lap/event8, including direct calls; terminal close does not turn first state BYTE into actor authorization", () => {
  for (const terminal of ["free", "close"] as const) {
    const e = create();
    if (terminal === "free") e.clients[0]!.m_aUser[1]!.SetFree();
    else e.clients[0]!.Close();
    const before = snapshot(e);
    noClockOrRandom(e);
    for (const packet of [bula(), lap(), event8(0)])
      expect(() => send(e, packet)).toThrow(CProtocolError);
    expect(() => e.room.OnReqEatBula(Received(bula()), e.clients[0]!)).toThrow(
      CProtocolError,
    );
    expect(() => e.room.OnLapInfo(Received(lap()), e.clients[0]!)).toThrow(
      CProtocolError,
    );
    noPackets(e);
    expect(snapshot(e)).toEqual(before);
    dispose(e);
  }
});
