import { afterEach, expect, test } from "bun:test";
import { CSendPacket } from "../Common/CSendPacket.ts";
import {
  CProtocolError,
  CUnsupportedOperation,
} from "../Common/CProtocolError.ts";
import { GameStage } from "../Common/OfficialValues.ts";
import { CPeImage, OFFICIAL_SERVICES } from "../Tools/OfficialSource.ts";
import {
  DiscoverLaunchPeer,
  GameLaunchFixture,
  LaunchReadyPacket,
} from "./helpers/GameLaunch.ts";
import { Received } from "./helpers/Clients.ts";
import vectors from "./fixtures/airplane-vectors.json";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function create(start = 0, counts: readonly number[] = [2, 1]) {
  const e = GameLaunchFixture(counts, undefined, () => 1, start);
  cleanup.push(e.close);
  return e;
}
type Environment = ReturnType<typeof create>;
function dispose(e: Environment) {
  e.close();
  cleanup.splice(cleanup.indexOf(e.close), 1);
}
function loading(e: Environment) {
  e.table.OnPacket(Received(new CSendPacket(106)), e.clients[0]!);
  if (!e.room.IsLoadingGame()) throw new Error("Actual native launch required");
  e.clear();
}
function running(e: Environment) {
  for (const [i, peer] of e.clients.entries()) {
    DiscoverLaunchPeer(e.room, peer, 41000 + i);
    e.table.OnPacket(Received(LaunchReadyPacket(e.room, peer)), peer);
  }
  if (e.room.m_nGameState !== GameStage.Running || !e.room.GetResultRoundID())
    throw new Error("Actual native150/round required");
  e.clear();
}
function start(e: Environment) {
  loading(e);
  running(e);
}
function request(rows: readonly (readonly number[])[]) {
  const p = new CSendPacket(156).Encode1(rows.length);
  for (const row of rows) for (const value of row) p.Encode1(value);
  return p;
}
function send(e: Environment, p: CSendPacket, sender = 1) {
  e.table.OnPacket(Received(p), e.clients[sender]!);
}
function last(e: Environment) {
  return e.room.GetGameLaunchState().LastAirplaneRequestTime;
}
function packets(e: Environment, expected = "") {
  for (const peer of e.clients)
    expect(peer.packets.map((p) => p.m_pBlock.toString("hex"))).toEqual(
      expected ? [expected] : [],
    );
  e.clear();
}
function words(seed: number) {
  return Array.from(
    { length: 250 },
    (_, i) => Math.imul(i + 1, 0x01020304) ^ seed,
  );
}
function seed(e: Environment, value: number) {
  e.room.GetCurrentGameContext().m_aBoxItemState.set(words(value));
}
function fingerprint(values: Iterable<number>) {
  let hash = 2166136261;
  for (const word of values)
    for (let shift = 0; shift < 32; shift += 8)
      hash = Math.imul(hash ^ ((word >>> shift) & 255), 16777619) >>> 0;
  return hash; // Test-only fingerprint, NOT protocol/cryptographic identity.
}
function world(
  e: Environment,
  expected: { Last: number; StateHash: number; Cleared: number[] },
  initialSeed: number,
) {
  const values = e.room.GetCurrentGameContext().m_aBoxItemState;
  const exact = words(initialSeed);
  for (const index of expected.Cleared) exact[index] = 0;
  expect([...values]).toEqual(exact);
  expect(fingerprint(values)).toBe(expected.StateHash);
  expect(last(e)).toBe(expected.Last);
}
function snapshot(e: Environment) {
  const ctx = e.room.GetCurrentGameContext();
  return {
    Launch: e.room.GetGameLaunchState(),
    Boxes: [...ctx.m_aBoxItemState],
    NextBox: ctx.m_nNextBoxItem,
    Bombs: ctx.m_aBomb.map((b) => ({ ...b })),
    States: [...e.room.m_aPlayerState],
    Statistics: e.room.m_dynInfoCalculator.GetStateBytes().toString("hex"),
    GhostCount: e.room.m_nGhostCount,
    BySlot: [...e.room.m_anSlotGhost],
    ByGhost: [...e.room.m_anGhostSlot],
    Sync: e.room.m_syncGameObjMan.GetObjectCount(),
    UUID: e.room.GetResultRoundID(),
    LastUpdate: e.room.GetLastUpdateTime(),
  };
}
function receipts(e: Environment) {
  return e.session.db
    .query<{ n: number }, []>("SELECT count(*) AS n FROM RuntimeGameResult")
    .get()!.n;
}
function noExtraServices(e: Environment) {
  e.random(() => {
    throw new Error("Airplane must not draw random");
  });
  e.clock.ElapsedTime = () => {
    throw new Error("Airplane must not sample game elapsed");
  };
}

test("independent airplane reference matches18 supplied PE anchors; manual model is NOT original execution/client proof", () => {
  const pe = new CPeImage(OFFICIAL_SERVICES.FXGS);
  expect(pe.sha256).toBe(vectors.OfficialPE.SHA256);
  expect(vectors.InstructionAnchors).toHaveLength(18);
  for (const a of vectors.InstructionAnchors)
    expect(pe.read(a.VA, a.Bytes.length / 2).toString("hex")).toBe(a.Bytes);
});
test("2268 body vectors: all250 indices/count1..3/duplicates and ALL256 values of each opaque byte; exact171 and full world state, nonchief accepted", () => {
  const e = create();
  start(e);
  noExtraServices(e);
  const before = snapshot(e),
    key = e.room.GetResultRoundID();
  expect(vectors.Bodies).toHaveLength(2268);
  expect(e.room.IsChief(e.clients[1]!)).toBe(false);
  for (const row of vectors.Bodies) {
    e.time(row.Tick);
    seed(e, row.Seed);
    send(e, request(row.Entries));
    world(e, row.After, row.Seed);
    packets(e, row.After.Packet);
  }
  const after = snapshot(e);
  expect({
    ...after,
    Boxes: before.Boxes,
    Launch: {
      ...after.Launch,
      LastAirplaneRequestTime: before.Launch.LastAirplaneRequestTime,
    },
  }).toEqual(before);
  expect(e.room.GetResultRoundID()).toBe(key);
  expect(receipts(e)).toBe(0);
});
test("474 independent two-step sequences: absolute ADD/unsigned compare, inclusive9000ms, future-marker/zero/wrap, NOT duration/elapsed/stopped", () => {
  expect(vectors.Sequences).toHaveLength(474);
  for (const row of vectors.Sequences) {
    const e = create(row.Start);
    try {
      start(e);
      seed(e, row.Seed);
      e.clock.m_dwTimeStopped = row.Stopped;
      noExtraServices(e);
      for (const step of row.Steps) {
        e.time(step.Tick);
        send(e, request(step.Entries));
        world(e, step.After, row.Seed);
        packets(e, step.After.Packet);
      }
      expect(receipts(e)).toBe(0);
    } finally {
      dispose(e);
    }
  }
  // 474 independent fresh schema6 databases, not a 5s performance SLO.
  // This CPU/SQLite batch budget changes NO injected native tick or 9000ms rule.
}, 30_000);
test("36 independent bad-box images reject EVERY bad record position/250..255 before any partial clear, marker, packet or score", () => {
  const e = create();
  start(e);
  noExtraServices(e);
  expect(vectors.InvalidBoxes).toHaveLength(36);
  for (const row of vectors.InvalidBoxes) {
    seed(e, row.Seed);
    e.time(row.Tick);
    const before = snapshot(e);
    expect(() => send(e, request(row.Entries))).toThrow(CProtocolError);
    expect(snapshot(e)).toEqual(before);
    world(e, row.After, row.Seed);
    packets(e);
  }
  expect(receipts(e)).toBe(0);
});
test("native count0 still publishes171/advances marker; >3 diagnostics fall through in manual native model but modern production deliberately rejects", () => {
  expect(vectors.NativeDiagnosticCounts).toHaveLength(8);
  for (const row of vectors.NativeDiagnosticCounts) {
    const e = create();
    try {
      start(e);
      seed(e, row.Seed);
      e.time(row.Tick);
      const before = snapshot(e);
      expect(row.After.Decision).toBe("accepted");
      expect(row.After.Packet).not.toBe("");
      if (row.Entries.length === 0) {
        send(e, request(row.Entries));
        world(e, row.After, row.Seed);
        packets(e, row.After.Packet);
      } else {
        expect(() => send(e, request(row.Entries))).toThrow(
          "native reported maximum",
        );
        expect(snapshot(e)).toEqual(before);
        packets(e);
      }
    } finally {
      dispose(e);
    }
  }
});
test("all count3 body truncations, trailing bytes, oversized counts and last bad index fail atomically; a retry can commit the same generation", () => {
  const e = create();
  start(e);
  seed(e, 123);
  e.time(7000);
  const before = snapshot(e);
  const complete = request([
    [255, 1, 128, 0],
    [0, 125, 255, 128],
    [127, 249, 1, 255],
  ]);
  const body = complete.GetBuffer().subarray(1);
  for (let length = 0; length < body.length; length++) {
    expect(() =>
      send(e, new CSendPacket(156).EncodeBuffer(body.subarray(0, length))),
    ).toThrow(CProtocolError);
    expect(snapshot(e)).toEqual(before);
    packets(e);
  }
  for (const p of [
    request([]).Encode1(0),
    request([[0, 0, 0, 0]]).Encode1(0),
    new CSendPacket(156).Encode1(11),
    new CSendPacket(156).Encode1(255),
  ]) {
    expect(() => send(e, p)).toThrow(CProtocolError);
    expect(snapshot(e)).toEqual(before);
    packets(e);
  }
  send(e, complete);
  expect(last(e)).toBe(9000);
  expect(e.room.GetCurrentGameContext().m_aBoxItemState[249]).toBe(0);
});
test("native early throttle does NOT decode malformed/trailing/oversized bodies; zero marker still requires absolute>=7000", () => {
  const e = create();
  start(e);
  seed(e, 123);
  e.time(6999);
  const before = snapshot(e);
  for (const p of [
    new CSendPacket(156),
    new CSendPacket(156).Encode1(255),
    request([]).Encode1(88),
    new CSendPacket(156).Encode1(3),
  ]) {
    const received = Received(p);
    received.Decode1();
    const remaining = received.remaining;
    e.room.OnRequestAirplane(received, e.clients[1]!);
    expect(received.remaining).toBe(remaining);
    expect(snapshot(e)).toEqual(before);
    packets(e);
  }
  e.time(7000);
  expect(() => send(e, new CSendPacket(156))).toThrow(CProtocolError);
  packets(e);
  send(e, request([]));
  expect(last(e)).toBe(9000);
  e.clear();
  e.time(15999);
  send(e, new CSendPacket(156));
  expect(last(e)).toBe(9000);
  packets(e);
  e.time(16000);
  send(e, request([]));
  expect(last(e)).toBe(18000);
});
test("one absolute sample supplies171 schedule AND stored future marker; no ElapsedTime, stopped-time, map probability or random reads", () => {
  const e = create(80000);
  start(e);
  noExtraServices(e);
  e.clock.m_dwTimeStopped = 0xffffffff;
  let reads = 0;
  e.clock.GetCurrentTime = () => {
    reads++;
    return reads === 1 ? 80000 : 0;
  };
  expect(e.room.GetGameLaunchState().AirplaneInitialTime).toBe(60000);
  expect(e.room.GetGameLaunchState().AirplaneFrequency).toBe(22000);
  send(e, request([[255, 249, 255, 255]]));
  expect(reads).toBe(1);
  expect(last(e)).toBe(82000);
  for (const peer of e.clients) {
    const p = peer.Take(171);
    expect(p.Decode4()).toBe(82000);
    expect(p.Decode1()).toBe(1);
    expect([p.Decode1(), p.Decode1(), p.Decode1(), p.Decode1()]).toEqual([
      255, 249, 255, 255,
    ]);
    p.AssertEnd();
  }
});
test("zero map airplane frequency does NOT disable171; exhausted box allocator, stopped sync manager and corrupt ghost state are NOT unrelated predicates", () => {
  const e = create(80000);
  e.room.m_nMapIdx = 0;
  e.clients[0]!.m_aUser[0]!.m_nAuthencode = 1;
  start(e);
  noExtraServices(e);
  expect(e.room.GetGameLaunchState().AirplaneFrequency).toBe(0);
  expect(e.room.m_syncGameObjMan.GetObjectCount()).toBe(4);
  const ctx = e.room.GetCurrentGameContext();
  ctx.m_nNextBoxItem = 250;
  ctx.m_aBoxItemState[249] = -123;
  e.room.m_syncGameObjMan.OnGameEnd();
  e.room.m_nGhostCount = NaN;
  e.room.m_anSlotGhost.fill(8);
  send(e, request([[0, 249, 0, 0]]));
  expect(ctx.m_aBoxItemState[249]).toBe(0);
  expect(ctx.m_nNextBoxItem).toBe(250);
  expect(e.room.m_syncGameObjMan.GetObjectCount()).toBe(4);
  expect(e.room.m_nGhostCount).toBeNaN();
  expect([...e.room.m_anSlotGhost]).toEqual(Array(8).fill(8));
  expect(last(e)).toBe(82000);
});
test("whole-group validation precedes even the native throttle: stale SECOND local room tuple cannot publish/clear for its otherwise-valid primary", () => {
  const e = create();
  start(e);
  seed(e, 123);
  const secondary = e.clients[0]!.m_aUser[1]!;
  for (const tick of [6999, 7000]) {
    e.time(tick);
    secondary.m_nSessionSerialNo++;
    const before = snapshot(e);
    expect(() => send(e, request([[0, 1, 0, 0]]), 0)).toThrow(CProtocolError);
    expect(snapshot(e)).toEqual(before);
    packets(e);
    secondary.m_nSessionSerialNo--;
  }
  send(e, request([[0, 1, 0, 0]]), 0);
  expect(last(e)).toBe(9000);
});
test("waiting/Loading/fabricated Running/trusted-result-only binding/Mod cannot bypass native launch/start timer ownership", () => {
  const e = create();
  e.time(80000);
  const attempt = () => {
    expect(() => send(e, request([]))).toThrow();
    packets(e);
  };
  attempt();
  e.room.m_bPlaying = true;
  e.room.m_nGameState = GameStage.Running;
  attempt();
  e.room.PrepareRoundStatistics();
  e.clock.StartGame();
  e.room.BeginResultLifecycle();
  expect(() => send(e, request([]))).toThrow(CUnsupportedOperation);
  packets(e);
  const load = create(80000);
  loading(load);
  expect(() => send(load, request([]))).toThrow(CProtocolError);
  packets(load);
  const mod = create(80000);
  start(mod);
  mod.room.SendGameTypeMod();
  mod.clear();
  expect(() => send(mod, request([]))).toThrow(CUnsupportedOperation);
  packets(mod);
});
test("171 callback sees ALL clears/future marker committed, rejects packet/removal/mode/statistics/result reentry; transport failure cannot replay it", () => {
  const e = create();
  start(e);
  seed(e, 123);
  e.time(7000);
  const first = e.clients[0]!,
    original = first.SendPacket;
  let seen = 0;
  first.SendPacket = function (p) {
    if (p.m_nPacketType === 171) {
      seen++;
      const values = e.room.GetCurrentGameContext().m_aBoxItemState;
      expect([values[0], values[125], values[249]]).toEqual([0, 0, 0]);
      expect(last(e)).toBe(9000);
      expect(() => send(e, request([]))).toThrow();
      expect(() =>
        send(e, new CSendPacket(151).Encode1(0).Encode1(2)),
      ).toThrow();
      expect(() => send(e, new CSendPacket(152).Encode1(0))).toThrow();
      expect(() => e.table.DestroyPlayer(e.clients[1]!)).toThrow();
      expect(() =>
        e.room.DealWithGhostOfLeavingPlayer(e.clients[1]!),
      ).toThrow();
      expect(() => e.room.PrepareRoundStatistics()).toThrow();
      expect(() => e.room.SendGameTypeMod()).toThrow();
      expect(() => e.room.BeginResultLifecycle()).toThrow();
      expect(e.room.DeferHandleGameEnd()).toBe(false);
      throw new Error("test-only failed171 transport");
    }
    original.call(this, p);
  };
  const p = request([
    [255, 0, 0, 255],
    [128, 125, 128, 0],
    [0, 249, 255, 128],
  ]);
  try {
    send(e, p);
  } finally {
    first.SendPacket = original;
  }
  expect(seen).toBe(1);
  expect(first.packets).toEqual([]);
  expect(e.clients[1]!.packets.map((p) => p.m_nPacketType)).toEqual([171]);
  expect(e.room.GetPacketPublicationFailureCount()).toBe(1);
  e.clear();
  send(e, p);
  packets(e);
  expect(seen).toBe(1);
  expect(last(e)).toBe(9000);
  e.time(16000);
  send(e, request([]));
  expect(last(e)).toBe(18000);
  expect(receipts(e)).toBe(0);
});
test("164 and subsequent Loading retain aircraft marker; only next genuine DoStartGame resets it, and immediate new-round156 may pass absolute gate", () => {
  const e = create(80000, [1, 1]);
  start(e);
  send(e, request([[0, 5, 255, 128]]));
  e.clear();
  const prior = last(e),
    key = e.room.GetResultRoundID()!;
  send(e, new CSendPacket(146).Encode1(0x60).Encode2(0).Encode2(0), 0);
  send(
    e,
    new CSendPacket(146)
      .Encode1(0x41)
      .Encode2(0)
      .Encode2(0)
      .Encode1(0)
      .Encode1(0),
  );
  e.clear();
  e.table.UpdateGameSessions();
  expect(e.room.m_nGameState).toBe(GameStage.Result);
  expect(e.db.GetGameResultReceipt(key)).toBeDefined();
  e.clear();
  expect(() => send(e, request([]))).toThrow(CProtocolError);
  packets(e);
  expect(last(e)).toBe(prior);
  e.time(88001);
  e.table.UpdateGameSessions();
  expect(e.room.m_bPlaying).toBe(false);
  expect(last(e)).toBe(prior);
  e.clear();
  expect(() => send(e, request([]))).toThrow(CProtocolError);
  packets(e);
  send(e, new CSendPacket(96).Encode1(1));
  e.clear();
  loading(e);
  expect(last(e)).toBe(prior);
  running(e);
  expect(last(e)).toBe(0);
  expect(e.room.GetResultRoundID()).not.toBe(key);
  send(e, request([]));
  expect(last(e)).toBe(90001);
  expect(receipts(e)).toBe(1);
});
