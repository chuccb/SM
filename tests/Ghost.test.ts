import { afterEach, expect, test } from "bun:test";
import { CSendPacket } from "../Common/CSendPacket.ts";
import {
  CProtocolError,
  CUnsupportedOperation,
} from "../Common/CProtocolError.ts";
import {
  ChannelType,
  GamePlayerState,
  GameStage,
} from "../Common/OfficialValues.ts";
import { CGameMapTmpl } from "../FXGS/CGameMapTmpl.ts";
import { CGameMapTmplList } from "../FXGS/CGameMapTmplList.ts";
import { CPeImage, OFFICIAL_SERVICES } from "../Tools/OfficialSource.ts";
import {
  DiscoverLaunchPeer,
  GameLaunchFixture,
  LaunchReadyPacket,
  LaunchResources,
} from "./helpers/GameLaunch.ts";
import { Received } from "./helpers/Clients.ts";
import vectors from "./fixtures/ghost-vectors.json";

type MapCase = (typeof vectors.Maps)[number];
type Image = {
  BySlot: number[];
  ByGhost: number[];
  Count: number;
  Last: number;
};
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function create(
  counts: readonly number[] = [2, 1],
  start = 0,
  map: MapCase = vectors.Maps[0]!,
) {
  let maps = LaunchResources.maps;
  if (map.Index < 0) {
    maps = new CGameMapTmplList();
    const words = [
      1001,
      8,
      1,
      15,
      13,
      8,
      1,
      0,
      map.StartSeconds,
      map.FrequencySeconds,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ];
    const bytes = Buffer.alloc(words.length * 4);
    words.forEach((word, i) => bytes.writeInt32LE(word, i * 4));
    maps.m_aMapTmpl.push(
      new CGameMapTmpl("Map/SyntheticGhost00", bytes, 0, true, false, false),
    );
  }
  const e = GameLaunchFixture(counts, ChannelType.Normal, () => 1, start, maps);
  cleanup.push(e.close);
  e.room.m_nMapIdx = map.Index < 0 ? 0 : map.Index;
  if (e.room.maps.GetMapLevelLimit(e.room.m_nMapIdx) > 1) {
    // Explicit authentication/SQLite fixture data, not an XP/network API.
    for (const peer of e.clients)
      for (const user of peer.m_aUser) {
        user.m_userInfo.Exp = 1_000_000;
        user.SetLevel();
        e.session.db
          .query("UPDATE FxUserDynamic SET Exp=? WHERE ID=?")
          .run(user.m_userInfo.Exp, user.GetName());
      }
  }
  return e;
}
type Environment = ReturnType<typeof create>;
function dispose(e: Environment) {
  e.close();
  cleanup.splice(cleanup.indexOf(e.close), 1);
}
function start(e: Environment): void {
  e.table.OnPacket(Received(new CSendPacket(106)), e.clients[0]!);
  if (!e.room.IsLoadingGame()) throw new Error("Native launch did not commit");
  for (const [i, peer] of e.clients.entries()) {
    DiscoverLaunchPeer(e.room, peer, 40000 + i);
    e.table.OnPacket(Received(LaunchReadyPacket(e.room, peer)), peer);
  }
  if (e.room.m_nGameState !== GameStage.Running || !e.room.GetResultRoundID())
    throw new Error("Native start did not commit");
  e.clear();
}
function image(e: Environment): Image {
  return {
    BySlot: [...e.room.m_anSlotGhost],
    ByGhost: [...e.room.m_anGhostSlot],
    Count: e.room.m_nGhostCount,
    Last: e.room.GetGameLaunchState().LastGhostTime,
  };
}
function seed(e: Environment, before: Image): void {
  // Trusted state-image tests ONLY. Private native timing/token fields are not
  // assigned; the legitimate native start above supplies them.
  e.room.m_anSlotGhost.set(before.BySlot);
  e.room.m_anGhostSlot.set(before.ByGhost);
  e.room.m_nGhostCount = before.Count;
}
function send(e: Environment, packet: CSendPacket, socketIndex = 0): void {
  e.table.OnPacket(Received(packet), e.clients[socketIndex]!);
}
function generate(e: Environment, slot: number, parameter = 255): void {
  const index = e.clients.findIndex((p) =>
    p.m_aUser.some((u) => u.m_nSlotIdx === slot),
  );
  send(e, new CSendPacket(151).Encode1(parameter).Encode1(slot), index);
}
function packets(e: Environment, expected = ""): void {
  for (const peer of e.clients)
    expect(peer.packets.map((p) => p.m_pBlock.toString("hex"))).toEqual(
      expected && e.room.GetSockets().includes(peer) ? [expected] : [],
    );
  e.clear();
}
function receipts(e: Environment): number {
  return e.session.db
    .query<{ n: number }, []>("SELECT count(*) AS n FROM RuntimeGameResult")
    .get()!.n;
}
function allState(e: Environment) {
  return {
    Ghost: image(e),
    Launch: e.room.GetGameLaunchState(),
    Players: [...e.room.m_aPlayerState],
    Statistics: e.room.m_dynInfoCalculator.GetStateBytes().toString("hex"),
    Context: [...e.room.GetCurrentGameContext().m_aBoxItemState],
    Slots: e.room.m_rgSlotInfo.map((s) => [...s]),
    Round: e.room.GetResultRoundID(),
  };
}

test("independent manual ghost vectors match16 supplied PE instruction anchors, not executable/client proof", () => {
  const pe = new CPeImage(OFFICIAL_SERVICES.FXGS);
  expect(pe.sha256).toBe(vectors.OfficialPE.SHA256);
  expect(vectors.InstructionAnchors).toHaveLength(16);
  for (const a of vectors.InstructionAnchors)
    expect(pe.read(a.VA, a.Bytes.length / 2).toString("hex")).toBe(a.Bytes);
});
test("4088 independent generation images: first free ghost ID, all occupied subsets, existing-owner no-op, stale count8 and opaque166 bytes", () => {
  const e = create([2, 2, 2, 2]);
  start(e);
  const key = e.room.GetResultRoundID();
  expect(vectors.Generate).toHaveLength(4088);
  for (const row of vectors.Generate) {
    seed(e, row.Before);
    generate(e, row.Slot, row.Parameter);
    expect(image(e)).toEqual(row.After);
    packets(e, row.Packet);
  }
  expect(e.room.GetResultRoundID()).toBe(key);
  expect(receipts(e)).toBe(0);
});
test("6128 independent destruction images: ghost ID not room slot, no sender ownership restriction, missing no-op and ONLY successful decrement", () => {
  const e = create([2, 2, 2, 2]);
  start(e);
  expect(vectors.Destroy).toHaveLength(6128);
  for (const row of vectors.Destroy) {
    seed(e, row.Before);
    const owner = row.Before.ByGhost[row.Ghost]!;
    const sender = owner < 0 ? row.Ghost % 4 : (Math.floor(owner / 2) + 1) % 4;
    send(e, new CSendPacket(152).Encode1(row.Ghost), sender);
    expect(image(e)).toEqual(row.After);
    packets(e, row.Packet);
  }
  expect(receipts(e)).toBe(0);
});
test("42 signed DWORD count images preserve native signed capacity comparison and decrement wrap; count is NOT recomputed from mappings", () => {
  const e = create([2, 2, 2, 2]);
  start(e);
  expect(vectors.SignedCounts).toHaveLength(42);
  for (const row of vectors.SignedCounts) {
    seed(e, row.Before);
    if (row.Operation === 151) generate(e, row.Target, row.Parameter);
    else send(e, new CSendPacket(152).Encode1(row.Target), 3);
    expect(image(e)).toEqual(row.After);
    packets(e, row.Packet);
  }
});
test("366 clock images: inclusive start/frequency, absolute last tick vs ElapsedTime, zero sentinel, DWORD rollover/raw negative seconds and ignored stopped time", () => {
  expect(vectors.Timings).toHaveLength(366);
  for (const row of vectors.Timings) {
    const map = vectors.Maps[row.Map]!,
      e = create([2, 1], row.Start, map);
    try {
      start(e);
      e.clock.m_dwTimeStopped = row.Stopped;
      const begin =
        (row.Start + (Math.imul(map.StartSeconds, 1000) >>> 0)) >>> 0;
      if (row.Bootstrap) {
        e.time(begin);
        generate(e, 0, 128);
        packets(e, row.FirstPacket);
      }
      expect(image(e)).toEqual(row.Before);
      e.time(row.Now);
      generate(e, row.Actor, 255);
      expect(image(e)).toEqual(row.After);
      packets(e, row.Packet);
      expect(receipts(e)).toBe(0);
    } finally {
      dispose(e);
    }
  }
});
test("frequency short-circuits elapsed sample, and last timestamp comes from FIRST absolute sample, not the later ElapsedTime read", () => {
  const e = create([2, 1], 100, vectors.Maps[1]!);
  start(e);
  let absolute = 60000,
    elapsed = 40000,
    samples = 0;
  const order: string[] = [];
  e.clock.GetCurrentTime = () => {
    order.push("absolute");
    return absolute;
  };
  e.clock.ElapsedTime = () => {
    order.push("elapsed");
    samples++;
    absolute += 123;
    return elapsed;
  };
  expect(() => send(e, new CSendPacket(151).Encode1(0))).toThrow();
  expect(order).toEqual([]);
  generate(e, 0);
  expect(image(e).Last).toBe(60000);
  expect(samples).toBe(1);
  expect(order).toEqual(["absolute", "elapsed"]);
  e.clear();
  absolute = 79999;
  elapsed = 90000;
  generate(e, 1);
  expect(samples).toBe(1);
  packets(e);
  absolute = 80000;
  elapsed = 39999;
  generate(e, 1);
  expect(samples).toBe(2);
  packets(e);
  absolute = 80000;
  elapsed = 40000;
  generate(e, 1);
  expect(image(e).Last).toBe(80000);
  expect(samples).toBe(3);
  expect(e.room.m_nGhostCount).toBe(2);
  e.clear();
  e.room.m_nGhostCount = 8;
  absolute = 100000;
  generate(e, 0);
  expect(samples).toBe(4);
  packets(e);
});
test("zero ghost start/frequency does NOT disable ghosts; active living secondary can generate on a non-rebirth map, duplicates are inert", () => {
  const e = create();
  start(e);
  const context = e.room.GetCurrentGameContext();
  context.m_aGhostPosition[1] = { x: 123, y: 456 };
  const stats = e.room.m_dynInfoCalculator.GetStateBytes(),
    states = [...e.room.m_aPlayerState],
    key = e.room.GetResultRoundID();
  expect(e.room.GetGameLaunchState().RebirthMap).toBe(false);
  expect(e.room.m_aPlayerState[1]).toBe(GamePlayerState.Active);
  generate(e, 1, 0x81);
  for (const p of e.clients) {
    const r = p.Take(166);
    expect(r.Decode1()).toBe(0);
    expect(r.Decode1()).toBe(0x81);
    expect(r.Decode1()).toBe(0x81);
    r.AssertEnd();
  }
  const before = allState(e);
  generate(e, 1, 0);
  expect(allState(e)).toEqual(before);
  packets(e);
  expect([...e.room.m_aPlayerState]).toEqual(states);
  expect(e.room.m_dynInfoCalculator.GetStateBytes()).toEqual(stats);
  expect(context.m_aGhostPosition[1]).toEqual({ x: 123, y: 456 });
  expect(e.room.GetResultRoundID()).toBe(key);
  expect(receipts(e)).toBe(0);
});
test("truncated/trailing/foreign actor/out-of-range ghost requests and stale SECOND local generation are atomic", () => {
  const e = create();
  start(e);
  generate(e, 1);
  e.clear();
  const before = allState(e);
  const reject = (p: CSendPacket) => {
    expect(() => send(e, p)).toThrow(CProtocolError);
    expect(allState(e)).toEqual(before);
    packets(e);
  };
  for (const bytes of [[], [0], [0, 0, 0], [0, 2], [0, 8], [0, 255]])
    reject(
      new CSendPacket(151).EncodeBuffer(
        Buffer.from(bytes.map((b) => b ^ 0x5a)),
      ),
    );
  for (const bytes of [[], [0, 0], [8], [255]])
    reject(
      new CSendPacket(152).EncodeBuffer(
        Buffer.from(bytes.map((b) => b ^ 0x5a)),
      ),
    );
  const secondary = e.clients[0]!.m_aUser[1]!;
  secondary.m_nSessionSerialNo++;
  reject(new CSendPacket(151).Encode1(1).Encode1(0));
  reject(new CSendPacket(152).Encode1(0));
  secondary.m_nSessionSerialNo--;
  generate(e, 0);
  expect(e.room.m_nGhostCount).toBe(2);
});
test("modern full mapping/count preflight rejects corrupt reciprocal/range/NaN/fractional state before any assignment/count/last/packet mutation", () => {
  const e = create();
  start(e);
  generate(e, 1);
  e.clear();
  for (const count of [NaN, Infinity, 1.5, 0x80000000, -0x80000001]) {
    e.room.m_nGhostCount = count;
    const before = allState(e);
    expect(() => generate(e, 0)).toThrow(CProtocolError);
    expect(() => send(e, new CSendPacket(152).Encode1(0))).toThrow(
      CProtocolError,
    );
    expect(allState(e)).toEqual(before);
    packets(e);
  }
  e.room.m_nGhostCount = 1;
  for (const bad of [-2, 8, 100]) {
    e.room.m_anGhostSlot[0] = bad;
    const before = allState(e);
    expect(() => generate(e, 0)).toThrow("ghost mapping");
    expect(() => send(e, new CSendPacket(152).Encode1(0))).toThrow(
      "ghost mapping",
    );
    expect(allState(e)).toEqual(before);
    packets(e);
  }
  e.room.m_anGhostSlot[0] = 1;
  e.room.m_anSlotGhost[1] = 7;
  const before = allState(e);
  expect(() => generate(e, 0)).toThrow("ghost mapping");
  expect(allState(e)).toEqual(before);
  packets(e);
});
test("waiting/loading/fabricated Running/trusted-only result binding and active Mod cannot bypass native ghost timing initialization", () => {
  const e = create();
  const attempt = () => {
    expect(() => send(e, new CSendPacket(151).Encode1(0).Encode1(0))).toThrow();
    expect(() => send(e, new CSendPacket(152).Encode1(0))).toThrow();
    packets(e);
  };
  attempt();
  e.room.m_bPlaying = true;
  e.room.m_nGameState = GameStage.Running;
  attempt();
  e.room.PrepareRoundStatistics();
  e.clock.StartGame();
  e.room.BeginResultLifecycle();
  expect(() => send(e, new CSendPacket(151).Encode1(0).Encode1(0))).toThrow(
    CUnsupportedOperation,
  );
  packets(e);
  const native = create();
  native.table.OnPacket(Received(new CSendPacket(106)), native.clients[0]!);
  native.clear();
  expect(() => send(native, new CSendPacket(152).Encode1(0))).toThrow(
    "outside a running",
  );
  packets(native);
  const mod = create();
  start(mod);
  mod.room.SendGameTypeMod();
  for (const peer of mod.clients) peer.Take(92).AssertEnd();
  mod.clear();
  expect(() => generate(mod, 0)).toThrow(CUnsupportedOperation);
  packets(mod);
});
test("committed166 publication rejects ghost/removal/statistics/mode/result callback reentry; transport failure neither rolls back nor duplicates", () => {
  const e = create();
  start(e);
  const first = e.clients[0]!,
    original = first.SendPacket,
    key = e.room.GetResultRoundID();
  let seen = 0;
  first.SendPacket = function (p) {
    if (p.m_nPacketType === 166) {
      seen++;
      expect(image(e).BySlot[1]).toBe(0);
      expect(image(e).Count).toBe(1);
      expect(() => generate(e, 0)).toThrow();
      expect(() => send(e, new CSendPacket(152).Encode1(0))).toThrow();
      expect(() =>
        e.room.DealWithGhostOfLeavingPlayer(e.clients[1]!),
      ).toThrow();
      expect(() => e.table.DestroyPlayer(e.clients[1]!)).toThrow();
      expect(() => e.room.PrepareRoundStatistics()).toThrow();
      expect(() => e.room.SendGameTypeMod()).toThrow();
      expect(e.room.DeferHandleGameEnd()).toBe(false);
      expect(() => e.room.BeginResultLifecycle()).toThrow();
      throw new Error("test-only failed ghost transport");
    }
    original.call(this, p);
  };
  try {
    generate(e, 1);
  } finally {
    first.SendPacket = original;
  }
  expect(seen).toBe(1);
  expect(first.packets).toEqual([]);
  expect(e.clients[1]!.packets.map((p) => p.m_nPacketType)).toEqual([166]);
  expect(e.room.GetPacketPublicationFailureCount()).toBe(1);
  e.clear();
  generate(e, 1);
  packets(e);
  expect(e.room.m_nGhostCount).toBe(1);
  expect(e.room.GetResultRoundID()).toBe(key);
  expect(receipts(e)).toBe(0);
});
test("native double-local departure may transfer a ghost back to a now-vacant slot;152 can destroy that consistent mapping and count stays non-cardinality", () => {
  const e = create();
  start(e);
  generate(e, 0, 7);
  generate(e, 1, 8);
  generate(e, 2, 9);
  e.clear();
  e.table.DestroyPlayer(e.clients[0]!);
  const survivor = e.clients[1]!,
    events = survivor.packets.filter(
      (p) => p.m_nPacketType === 166 || p.m_nPacketType === 167,
    );
  expect(events.map((p) => p.m_pBlock.toString("hex"))).toEqual([
    "fd5a",
    "fc5b5a",
  ]); // destroy0 then transfer1->slot0, NOT new-owner80+parameter
  expect(e.room.m_rgPlayer[0]).toBeUndefined();
  expect(e.room.m_anGhostSlot[1]).toBe(0);
  expect(e.room.m_anSlotGhost[0]).toBe(1);
  expect(e.room.m_nGhostCount).toBe(3);
  e.clear();
  send(e, new CSendPacket(152).Encode1(1), 1);
  expect(e.room.m_nGhostCount).toBe(2);
  packets(e, "fd5b");
  send(e, new CSendPacket(152).Encode1(2), 1);
  expect(e.room.m_nGhostCount).toBe(1);
  packets(e, "fd58");
  generate(e, 2);
  expect(e.room.m_nGhostCount).toBe(2);
  expect(e.room.m_anSlotGhost[2]).toBe(0);
  expect(receipts(e)).toBe(0);
});
test("164 preserves ghost assignments/count/last, next genuine106 resets them before another native150; Result/waiting requests stay gated", () => {
  const e = create([1, 1], 100);
  start(e);
  generate(e, 0);
  e.clear();
  const before = image(e),
    key = e.room.GetResultRoundID()!;
  send(e, new CSendPacket(146).Encode1(0x60).Encode2(0).Encode2(0));
  send(
    e,
    new CSendPacket(146)
      .Encode1(0x41)
      .Encode2(0)
      .Encode2(0)
      .Encode1(0)
      .Encode1(0),
    1,
  );
  e.clear();
  e.table.UpdateGameSessions();
  expect(e.room.m_nGameState).toBe(GameStage.Result);
  expect(e.db.GetGameResultReceipt(key)).toBeDefined();
  e.clear();
  expect(() => generate(e, 0)).toThrow(CProtocolError);
  packets(e);
  e.time(8101);
  e.table.UpdateGameSessions();
  expect(e.room.m_bPlaying).toBe(false);
  expect(image(e)).toEqual(before);
  e.clear();
  expect(() => send(e, new CSendPacket(152).Encode1(0))).toThrow(
    "outside a running",
  );
  packets(e);
  send(e, new CSendPacket(96).Encode1(1), 1);
  e.clear();
  start(e);
  expect(image(e)).toEqual({
    BySlot: Array(8).fill(-1),
    ByGhost: Array(8).fill(-1),
    Count: 0,
    Last: 0,
  });
  expect(e.room.GetResultRoundID()).not.toBe(key);
  expect(receipts(e)).toBe(1);
});

test("destroy leaves last-generation cooldown intact; next actor can reuse lowest freed ghost only at inclusive frequency", () => {
  const e = create([2, 1], 100, vectors.Maps[1]!);
  start(e);
  e.time(40100);
  generate(e, 0);
  e.clear();
  send(e, new CSendPacket(152).Encode1(0), 1);
  packets(e, "fd5a");
  expect(e.room.m_nGhostCount).toBe(0);
  expect(image(e).Last).toBe(40100);
  e.time(60099);
  generate(e, 1);
  packets(e);
  expect(e.room.m_nGhostCount).toBe(0);
  e.time(60100);
  generate(e, 1, 0);
  packets(e, "fc5adb5a");
  expect(e.room.m_nGhostCount).toBe(1);
  expect(image(e).Last).toBe(60100);
});
test("committed167 publication sees cleared pair/count and rejects reentry; subsequent151 is a new commit, not a retry", () => {
  const e = create();
  start(e);
  generate(e, 1);
  e.clear();
  const first = e.clients[0]!,
    original = first.SendPacket;
  let calls = 0;
  first.SendPacket = function (p) {
    if (p.m_nPacketType === 167) {
      calls++;
      expect(image(e).BySlot[1]).toBe(-1);
      expect(image(e).ByGhost[0]).toBe(-1);
      expect(e.room.m_nGhostCount).toBe(0);
      expect(() => generate(e, 0)).toThrow();
      expect(() => send(e, new CSendPacket(152).Encode1(0))).toThrow();
      expect(() =>
        e.room.DealWithGhostOfLeavingPlayer(e.clients[1]!),
      ).toThrow();
      expect(() => e.table.DestroyPlayer(e.clients[1]!)).toThrow();
    }
    original.call(this, p);
  };
  try {
    send(e, new CSendPacket(152).Encode1(0), 1);
  } finally {
    first.SendPacket = original;
  }
  expect(calls).toBe(1);
  packets(e, "fd5a");
  generate(e, 2, 0);
  packets(e, "fc5ad85a");
  expect(e.room.m_nGhostCount).toBe(1);
  expect(receipts(e)).toBe(0);
});
test("public trusted departure adapter also guards its OWN deferred publication, while table removal uses the private legitimate path", () => {
  const e = create();
  start(e);
  generate(e, 1);
  e.clear();
  const first = e.clients[0]!,
    original = first.SendPacket;
  let calls = 0;
  first.SendPacket = function (p) {
    if (p.m_nPacketType === 166) {
      calls++;
      expect(image(e).ByGhost[0]).toBe(0);
      expect(e.room.m_nGhostCount).toBe(1);
      expect(() => e.room.DealWithGhostOfLeavingPlayer(first)).toThrow();
      expect(() => generate(e, 2)).toThrow();
      expect(() => e.table.DestroyPlayer(first)).toThrow();
    }
    original.call(this, p);
  };
  try {
    e.room.DealWithGhostOfLeavingPlayer(first);
  } finally {
    first.SendPacket = original;
  }
  expect(calls).toBe(1);
  packets(e, "fc5a5a");
  expect(e.room.GetCurPlayer()).toBe(3);
  expect(e.room.m_nGhostCount).toBe(1);
});
