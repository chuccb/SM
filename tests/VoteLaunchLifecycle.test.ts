import { afterEach, expect, test } from "bun:test";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CGameClock } from "../FXGS/CGameClock.ts";
import {
  GameStage,
  GameType,
  GameResultTiming,
} from "../Common/OfficialValues.ts";
import {
  GameLaunchFixture,
  LaunchReadyPacket,
  DiscoverLaunchPeer,
} from "./helpers/GameLaunch.ts";
import { Received, MemoryClient } from "./helpers/Clients.ts";
import { CUser } from "../Common/CUser.ts";
import { UserInfo } from "./helpers/Accounts.ts";
import { ChiefSQLState } from "./helpers/WaitingChief.ts";
const closes: (() => void)[] = [];
afterEach(() => {
  for (const f of closes.splice(0).reverse()) f();
});
function create(counts: readonly number[] = [1, 1, 1, 1]) {
  const e = GameLaunchFixture(counts);
  closes.push(e.close);
  return e;
}
function vote(e: ReturnType<typeof create>, target = 1) {
  const n = e.clients[target]!.m_aUser[0]!.GetGlobalSerialNo();
  e.table.OnPacket(
    Received(new CSendPacket(104).Encode4(n).Encode1(0)),
    e.clients[0]!,
  );
  e.clear();
  return n;
}
function launch(e: ReturnType<typeof create>) {
  e.table.OnPacket(Received(new CSendPacket(106)), e.clients[0]!);
  expect(e.room.m_bPlaying).toBe(true);
  expect(e.room.m_nGameState).toBe(GameStage.Loading);
  expect(e.room.GetGameLaunchState().NativeLaunch).toBe(true);
}
function ready(e: ReturnType<typeof create>, index: number) {
  const p = e.clients[index]!;
  expect(DiscoverLaunchPeer(e.room, p, 40000 + index)).toBe(true);
  e.room.OnPacket(Received(LaunchReadyPacket(e.room, p)), p);
}
function running(e: ReturnType<typeof create>) {
  for (let i = 0; i < e.clients.length; i++) ready(e, i);
  expect(e.room.m_nGameState).toBe(GameStage.Running);
  expect(e.room.GetResultRoundID()).toBeDefined();
}
function respond(
  e: ReturnType<typeof create>,
  index: number,
  target: number,
  answer = 1,
) {
  e.table.OnPacket(
    Received(new CSendPacket(105).Encode4(target).Encode1(answer)),
    e.clients[index]!,
  );
}
function state(e: ReturnType<typeof create>) {
  return {
    Votes: [...e.room.m_anBanPlayerVote],
    Target: e.room.m_ulBanTargetSerialNo,
    Slots: e.room.m_rgSlotInfo.map((b) => b.toString("hex")),
    Helper: e.room.m_banChief.CaptureSnapshot(),
    Clock: e.clock.GetStateSnapshot(),
    Launch: e.room.GetGameLaunchState(),
    Round: e.room.GetResultRoundID(),
    Count: e.room.GetCurPlayer(),
  };
}
function financial(e: ReturnType<typeof create>) {
  return {
    SQL: ChiefSQLState(e.session),
    Players: e.clients
      .flatMap((s) => s.m_aUser)
      .map((u) => ({
        Dynamic: u.GetDynamicInfoSnapshot(),
        Pair: u.CaptureUserInventoryInitialization(),
      })),
  };
}
function packetCodes(p: MemoryClient) {
  return p.packets.map((q) => q.m_nPacketType);
}

test("LIVE106 issued waiting vote survives115/116/Loading and real109/peer150/Running with EXACT same target/ballots,private roster and no113/114 replay", () => {
  const e = create(),
    target = vote(e),
    votes = [...e.room.m_anBanPlayerVote],
    before = financial(e);
  launch(e);
  expect([...e.room.m_anBanPlayerVote]).toEqual(votes);
  expect(e.room.m_ulBanTargetSerialNo).toBe(target);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
  expect(
    e.clients.every((p) => !packetCodes(p).some((n) => n === 113 || n === 114)),
  ).toBe(true);
  e.clear();
  running(e);
  expect([...e.room.m_anBanPlayerVote]).toEqual(votes);
  expect(e.room.m_ulBanTargetSerialNo).toBe(target);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
  expect(financial(e)).toEqual(before);
});

test("LIVE failed106 keeps issued vote and native playing-map selection side effect:115 failure only, no cancellation/reinitialization or fake116", () => {
  const e = create(),
    target = vote(e),
    votes = [...e.room.m_anBanPlayerVote];
  e.room.OnPacket(Received(new CSendPacket(96).Encode1(0)), e.clients[3]!);
  e.clear();
  e.table.OnPacket(Received(new CSendPacket(106)), e.clients[0]!);
  expect(packetCodes(e.clients[0]!)).toEqual([115]);
  expect(e.clients[0]!.Take(115).Decode1()).toBe(2);
  expect(e.room.m_bPlaying).toBe(false);
  expect(e.room.m_nMapIdxPlaying).toBe(200);
  expect([...e.room.m_anBanPlayerVote]).toEqual(votes);
  expect(e.room.m_ulBanTargetSerialNo).toBe(target);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
});

test("LIVE launch shuffle callback cannot rewrite ballots/ownership/ready flags while a prepared native vote is carried into Loading", () => {
  for (const kind of ["votes", "ready", "round", "playing-map"] as const) {
    const e = create();
    vote(e);
    const helper = e.room.m_banChief.CaptureSnapshot(),
      clock = e.clock.GetStateSnapshot();
    let armed = true;
    e.random(() => {
      if (armed) {
        armed = false;
        if (kind === "votes") e.room.m_anBanPlayerVote[7] = 3;
        else if (kind === "ready") e.room.m_rgSlotInfo[3]![0] = 0;
        else if (kind === "round") Reflect.set(e.room, "m_resultRound", {});
        else e.room.m_nMapIdxPlaying = 201;
      }
      return 1;
    });
    expect(() => launch(e)).toThrow();
    expect(e.room.GetGameLaunchState().NativeLaunch).toBe(false);
    expect(e.room.m_bPlaying).toBe(false);
    expect(e.room.m_banChief.CaptureSnapshot()).toEqual(helper);
    expect(e.clock.GetStateSnapshot()).toEqual(clock);
    expect(e.clients.every((p) => !p.packets.length)).toBe(true);
  }
});

test("LIVE116/tail clock fault is BEFORE115,playing/statistics publication and round token; same ballot survives retry", () => {
  const e = create(),
    target = vote(e),
    before = state(e),
    wallet = financial(e);
  let reads = 0;
  e.clock.GetCurrentTime = () => {
    if (++reads === 2) throw new Error("launch-tail-clock");
    return 123;
  };
  expect(() => launch(e)).toThrow("launch-tail-clock");
  expect(e.room.m_bPlaying).toBe(false);
  expect(e.room.GetGameLaunchState()).toEqual(before.Launch);
  expect(e.room.m_banChief.CaptureSnapshot()).toEqual(before.Helper);
  expect(e.room.m_ulBanTargetSerialNo).toBe(target);
  expect([...e.room.m_anBanPlayerVote]).toEqual(before.Votes);
  expect(e.clients.every((p) => !p.packets.length)).toBe(true);
  expect(financial(e)).toEqual(wallet);
  e.clock.GetCurrentTime = () => 200;
  launch(e);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
});

test("LIVE Loading105 passing target ejection preflights150 clock/helper BEFORE IDs, then106 ->150 ->114; target gets only own last106, no195", () => {
  const e = create(),
    target = vote(e);
  launch(e);
  for (const i of [0, 2, 3]) ready(e, i);
  expect(e.room.m_nGameState).toBe(GameStage.Loading);
  e.clear();
  const ticks: number[] = [];
  e.clock.GetCurrentTime = () => {
    expect(e.room.GetCurPlayer()).toBe(4);
    expect(e.clients[1]!.m_aUser[0]!.GetSessionIdx()).toBe(e.room.m_nIdx);
    const n = 1000 + ticks.length;
    ticks.push(n);
    return n;
  };
  respond(e, 2, target);
  expect(ticks).toEqual([1000, 1001]);
  expect(e.room.m_nGameState).toBe(GameStage.Running);
  expect(e.clock.GetStartGameTime()).toBe(1000);
  expect(e.room.m_banChief.CaptureSnapshot().CanStartTime).toBe(1001);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  expect(e.clients[1]!.m_nPoolType).toBe("SessionRemoved");
  for (const i of [0, 2, 3])
    expect(packetCodes(e.clients[i]!)).toEqual([106, 150, 114]);
  expect(packetCodes(e.clients[1]!)).toEqual([106]);
});

test("LIVE potential Loading150 second clock fault cannot consume target/ballot or send106/114; same105 can retry original private vote", () => {
  const e = create(),
    target = vote(e);
  launch(e);
  for (const i of [0, 2, 3]) ready(e, i);
  e.clear();
  const before = state(e),
    money = financial(e);
  let reads = 0;
  e.clock.GetCurrentTime = () => {
    if (++reads === 2) throw new Error("survivor-start-helper-clock");
    return 1000;
  };
  expect(() => respond(e, 2, target)).toThrow("survivor-start-helper-clock");
  expect(state(e)).toEqual(before);
  expect(financial(e)).toEqual(money);
  expect(e.clients.every((p) => !p.packets.length)).toBe(true);
  e.clock.GetCurrentTime = () => 2000;
  respond(e, 2, target);
  expect(e.room.m_nGameState).toBe(GameStage.Running);
});

test("LIVE Loading UDP deadline -> root departure -> deferred other target -> survivor150 ->114 ->195 preserves issued update owner and nested transition/batch", () => {
  const e = create([1, 1, 1, 1, 1]),
    target = vote(e);
  respond(e, 2, target);
  expect(e.room.m_ulBanTargetSerialNo).toBe(target);
  e.clear();
  launch(e);
  for (const i of [0, 2, 3]) ready(e, i);
  expect(DiscoverLaunchPeer(e.room, e.clients[1]!, 40001)).toBe(true);
  e.clear();
  e.time(25101);
  e.table.UpdateGameSessions();
  expect(e.table.GetUpdateFailures()).toEqual([]);
  expect(e.room.m_nGameState).toBe(GameStage.Running);
  expect(e.room.GetCurPlayer()).toBe(3);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  for (const i of [0, 2, 3])
    expect(packetCodes(e.clients[i]!)).toEqual([106, 106, 150, 114]);
  expect(packetCodes(e.clients[4]!)).toEqual([195]);
  expect(packetCodes(e.clients[1]!)).toEqual([106, 106]);
  expect(e.clients[4]!.m_nPoolType).toBe("SessionRemoved");
  expect(e.clients[1]!.m_nPoolType).toBe("SessionRemoved");
});

test("LIVE actual109 final ready preflights150 start/helper clock separately and never clears carried target; no raw start-clock provider replacement", () => {
  const e = create(),
    target = vote(e);
  launch(e);
  for (const i of [0, 1, 2]) ready(e, i);
  expect(DiscoverLaunchPeer(e.room, e.clients[3]!, 40003)).toBe(true);
  e.clear();
  const ticks: number[] = [];
  e.clock.GetCurrentTime = () => {
    const n = (0xffffffff + ticks.length) >>> 0;
    ticks.push(n);
    return n;
  };
  e.room.OnPacket(
    Received(LaunchReadyPacket(e.room, e.clients[3]!)),
    e.clients[3]!,
  );
  expect(ticks).toEqual([0xffffffff, 0]);
  expect(e.clock.GetStartGameTime()).toBe(0xffffffff);
  expect(e.room.m_banChief.CaptureSnapshot().CanStartTime).toBe(0);
  expect(e.room.m_nGameState).toBe(GameStage.Running);
  expect(e.room.m_ulBanTargetSerialNo).toBe(target);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
});

test("LIVE Running105 preserves native statistics cohort/UUID/clock, removes actual current target then114 without currency/inventory/SQL effects", () => {
  const e = create(),
    target = vote(e);
  launch(e);
  running(e);
  e.clear();
  const cohort = e.room.m_dynInfoCalculator.GetStateBytes(),
    round = e.room.GetResultRoundID(),
    clock = e.clock.GetStateSnapshot(),
    before = financial(e);
  respond(e, 2, target);
  expect(e.room.GetCurPlayer()).toBe(3);
  expect(e.room.m_nGameState).toBe(GameStage.Running);
  expect(e.room.m_dynInfoCalculator.GetStateBytes()).toEqual(cohort);
  expect(e.room.GetResultRoundID()).toBe(round);
  expect(e.clock.GetStateSnapshot()).toEqual(clock);
  expect(financial(e)).toEqual(before);
  for (const i of [0, 2, 3])
    expect(packetCodes(e.clients[i]!)).toEqual([106, 114]);
});

test("LIVE104 can originate in a genuine native Running round, not only carry a waiting vote; target/ballots remain per-player", () => {
  const e = create();
  launch(e);
  running(e);
  e.clear();
  const round = e.room.GetResultRoundID(),
    target = vote(e);
  expect(e.room.m_ulBanTargetSerialNo).toBe(target);
  expect([...e.room.m_anBanPlayerVote]).toEqual([2, 0, 1, 1, 0, 0, 0, 0]);
  expect(e.room.GetResultRoundID()).toBe(round);
  respond(e, 2, target, 0);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
  respond(e, 3, target, 0);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  expect(e.room.GetCurPlayer()).toBe(4);
});

test("LIVE Running UDP regulation keeps owned vote on unrelated departure and may resolve same target, without nested-update refusal or financial rebase", () => {
  const e = create([1, 1, 1, 1, 1]),
    target = vote(e);
  respond(e, 2, target);
  launch(e);
  running(e);
  e.clear();
  e.room.OnPacket(Received(new CSendPacket(187).Encode1(4)), e.clients[0]!);
  e.time(8201);
  e.table.UpdateGameSessions();
  expect(e.table.GetUpdateFailures()).toEqual([]);
  expect(e.room.m_nGameState).toBe(GameStage.Running);
  expect(e.room.GetCurPlayer()).toBe(3);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  expect(e.clients[1]!.m_nPoolType).toBe("SessionRemoved");
  expect(e.clients[4]!.m_nPoolType).toBe("SessionRemoved");
});

test("LIVE REAL native result conflict freezes carried vote BEFORE response/roster mutation or another SQL attempt; native receipt recovery retains same target", () => {
  const e = create(),
    target = vote(e);
  launch(e);
  running(e);
  e.clear();
  const commit = e.db.CommitGameResult.bind(e.db);
  let attempts = 0;
  e.db.CommitGameResult = () => {
    attempts++;
    return "conflict";
  };
  e.time(180101);
  e.room.Update();
  expect(e.room.IsResultCommitPending()).toBe(true);
  expect(attempts).toBe(1);
  const before = state(e),
    sql = ChiefSQLState(e.session);
  expect(() => respond(e, 2, target)).toThrow("frozen");
  expect(() => e.table.DestroyPlayer(e.clients[3]!)).toThrow("frozen");
  expect(state(e)).toEqual(before);
  expect(attempts).toBe(1);
  expect(ChiefSQLState(e.session)).toEqual(sql);
  e.db.CommitGameResult = commit;
  e.time(180102);
  e.room.Update();
  expect(e.room.m_nGameState).toBe(GameStage.Result);
  expect(e.room.IsResultCommitPending()).toBe(false);
  expect(e.room.m_ulBanTargetSerialNo).toBe(target);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
});

test("LIVE native durable Result permits105/nonfinancial departure without rewriting committed receipt;164 later cancels only target and revokes private vote", () => {
  const e = create(),
    target = vote(e);
  launch(e);
  running(e);
  e.time(180101);
  e.room.Update();
  expect(e.room.m_nGameState).toBe(GameStage.Result);
  const sql = ChiefSQLState(e.session),
    round = e.room.GetResultRoundID(),
    receipt = e.db.GetGameResultReceipt(round!)!;
  e.clear();
  respond(e, 2, target);
  expect(e.room.GetCurPlayer()).toBe(3);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  expect(e.db.GetGameResultReceipt(round!)).toEqual(receipt);
  expect(ChiefSQLState(e.session)).toEqual(sql);
  e.time(188102);
  e.room.Update();
  expect(e.room.m_bPlaying).toBe(false);
  expect(e.room.HasActiveBanPlayerVote()).toBe(false);
  expect(e.room.GetResultRoundID()).toBeUndefined();
});

test("LIVE164 clears carried target/private issuance but DOES NOT reset ballots; late105 is ignored and next104 gets a fresh legitimate electorate", () => {
  const e = create(),
    target = vote(e),
    votes = [...e.room.m_anBanPlayerVote];
  launch(e);
  running(e);
  e.time(180101);
  e.room.Update();
  expect(e.room.m_nGameState).toBe(GameStage.Result);
  e.clear();
  e.time(188102);
  e.room.Update();
  expect(e.room.m_bPlaying).toBe(false);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  expect([...e.room.m_anBanPlayerVote]).toEqual(votes);
  expect(e.room.HasActiveBanPlayerVote()).toBe(false);
  e.clear();
  e.table.OnPacket(Received(new CSendPacket(105)), e.clients[2]!);
  expect(e.clients.every((p) => !p.packets.length)).toBe(true);
  vote(e);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
  expect(e.room.m_ulBanTargetSerialNo).toBe(target);
});

test("LIVE fake Playing/stage/round flags,restored vote DTO or Mod cannot grant native vote/launch authority", () => {
  for (const kind of ["playing", "mod", "dto"] as const) {
    const e = create();
    if (kind === "playing") {
      e.room.m_bPlaying = true;
      e.room.m_nGameState = GameStage.Running;
    } else if (kind === "mod") Reflect.set(e.room, "m_nGameType", GameType.Mod);
    else {
      const p = e.room.PrepareHostAskBanPlayer(e.clients[0]!, {
        TargetSerialNo: e.clients[1]!.m_aUser[0]!.GetGlobalSerialNo(),
        Immediate: 0,
      });
      e.room.m_ulBanTargetSerialNo = p.After.TargetSerialNo;
      e.room.m_anBanPlayerVote.set(p.After.Votes);
    }
    expect(() => vote(e)).toThrow();
    expect(e.room.GetResultRoundID()).toBeUndefined();
    expect(e.clients.every((p) => !p.packets.length)).toBe(true);
  }
});

test("native StartGameAt changes exactly Start/Stopped/End, preserves Suspended and rejects invalid DWORD before any marker changes", () => {
  const clock = new CGameClock(() => 777);
  clock.SuspendGame();
  clock.EndGameAt(33);
  clock.m_dwTimeStopped = 9;
  clock.StartGameAt(0xffffffff);
  expect(clock.GetStateSnapshot()).toEqual({
    Start: 0xffffffff,
    End: 0,
    Stopped: 0,
    Suspended: 777,
  });
  const before = clock.GetStateSnapshot();
  for (const n of [-1, 1.5, 0x100000000, NaN]) {
    expect(() => clock.StartGameAt(n)).toThrow();
    expect(clock.GetStateSnapshot()).toEqual(before);
  }
  expect(GameResultTiming.ReturnPrepareMilliseconds).toBe(8000);
});

test("LIVE later zero-ballot pair joins WAITING vote then enters native116/150 roster without acquiring a current ballot or financial rebase", () => {
  const e = create(),
    target = vote(e),
    peer = new MemoryClient();
  e.clients.push(peer);
  for (let i = 0; i < 2; i++) {
    const u = new CUser(UserInfo(`VoteCarry${i}`), 0xfedcba90 + i);
    u.m_pClientSocket = peer;
    peer.m_aUser.push(u);
  }
  e.table.DoJoinSession(peer, e.room.m_nIdx, e.room.m_ulSerialNo, "", [0, 0]);
  e.room.OnPacket(Received(new CSendPacket(96).Encode1(1)), peer);
  const votes = [...e.room.m_anBanPlayerVote];
  expect(votes.slice(4, 6)).toEqual([0, 0]);
  e.clear();
  launch(e);
  running(e);
  e.clear();
  e.room.OnPacket(
    Received(new CSendPacket(105).Encode4(target).Encode1(255)),
    peer,
  );
  expect([...e.room.m_anBanPlayerVote]).toEqual(votes);
  expect(e.room.m_ulBanTargetSerialNo).toBe(target);
  expect(e.clients.every((p) => !p.packets.length)).toBe(true);
  respond(e, 2, target);
  expect(e.room.GetCurPlayer()).toBe(5);
  expect(peer.packets.map((p) => p.m_nPacketType)).toEqual([106, 114]);
});

test("LIVE104 may originate during genuine native Loading; it does not create a fresh launch token or reset prepared resources", () => {
  const e = create();
  launch(e);
  e.clear();
  const before = e.room.GetGameLaunchState(),
    target = vote(e);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
  expect(e.room.GetGameLaunchState()).toEqual(before);
  expect(e.room.m_nGameState).toBe(GameStage.Loading);
  respond(e, 2, target, 0);
  respond(e, 3, target, 0);
  expect(e.room.GetCurPlayer()).toBe(4);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  running(e);
});

test("LIVE final109 helper-clock failure retains native Loading and parsed-ready bits but publishes no150/UUID/start markers; explicit deferred retry succeeds", () => {
  const e = create(),
    target = vote(e);
  launch(e);
  for (const i of [0, 1, 2]) ready(e, i);
  expect(DiscoverLaunchPeer(e.room, e.clients[3]!, 40003)).toBe(true);
  e.clear();
  const clock = e.clock.GetStateSnapshot(),
    helper = e.room.m_banChief.CaptureSnapshot(),
    sequence = e.room.GetGameLaunchState().GameSequence;
  let reads = 0;
  e.clock.GetCurrentTime = () => {
    if (++reads === 2) throw new Error("final109-chief-clock");
    return 1000;
  };
  expect(() =>
    e.room.OnPacket(
      Received(LaunchReadyPacket(e.room, e.clients[3]!)),
      e.clients[3]!,
    ),
  ).toThrow("final109-chief-clock");
  expect(e.room.m_nGameState).toBe(GameStage.Loading);
  expect(e.clock.GetStateSnapshot()).toEqual(clock);
  expect(e.room.m_banChief.CaptureSnapshot()).toEqual(helper);
  expect(e.room.GetGameLaunchState().GameSequence).toBe(sequence);
  expect(e.room.GetResultRoundID()).toBeUndefined();
  expect(e.room.IsAllPlayerReadyForStart()).toBe(true);
  expect(e.room.m_ulBanTargetSerialNo).toBe(target);
  expect(e.clients.every((p) => !p.packets.length)).toBe(true);
  e.clock.GetCurrentTime = () => 2000;
  e.room.DeferStartGame();
  expect(e.room.m_nGameState).toBe(GameStage.Running);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
});

test("LIVE return164 callback cannot respond/remove/reenter Result before target/private revocation; receipt and old votes are not rolled back", () => {
  const e = create(),
    target = vote(e);
  launch(e);
  running(e);
  e.time(180101);
  e.room.Update();
  e.clear();
  const sql = ChiefSQLState(e.session),
    votes = [...e.room.m_anBanPlayerVote],
    send = e.clients[0]!.SendPacket.bind(e.clients[0]!);
  let seen = 0;
  e.clients[0]!.SendPacket = (p) => {
    if (p.m_nPacketType === 164) {
      seen++;
      expect(e.room.m_ulBanTargetSerialNo).toBe(target);
      expect(() => respond(e, 2, target)).toThrow("frozen");
      expect(() => e.table.DestroyPlayer(e.clients[3]!)).toThrow("frozen");
    }
    send(p);
  };
  e.time(188102);
  e.room.Update();
  expect(seen).toBe(1);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  expect(e.room.HasActiveBanPlayerVote()).toBe(false);
  expect([...e.room.m_anBanPlayerVote]).toEqual(votes);
  expect(ChiefSQLState(e.session)).toEqual(sql);
});

test("LIVE ordinary native money/house/special freeze predicates all refuse playing vote BEFORE item lookup,clock or SQL; flags alone never authorize replay", () => {
  for (const field of [
    "IsMoneyPickupPending",
    "IsHouseClaimPending",
    "IsSpecialItemUsePending",
  ] as const) {
    const e = create();
    launch(e);
    running(e);
    e.clear();
    const before = financial(e);
    let reads = 0;
    e.clients[1]!.m_aUser[0]!.HasFunctionalItem = () => {
      reads++;
      return false;
    };
    e.clock.GetCurrentTime = () => {
      throw new Error("frozen clock must not read");
    };
    e.room[field] = () => true;
    expect(() => vote(e)).toThrow("frozen");
    expect(reads).toBe(0);
    expect(e.room.GetCurPlayer()).toBe(4);
    expect(financial(e)).toEqual(before);
    expect(e.clients.every((p) => !p.packets.length)).toBe(true);
  }
});

test("LIVE public scalar start/launch snapshots cannot forge an internal prepared150 brand or issue a round, even on a genuinely launched room", () => {
  const e = create();
  vote(e);
  launch(e);
  e.clear();
  const before = state(e),
    fake = {
      Socket: undefined,
      Token: Reflect.get(e.room, "m_nativeLaunchToken"),
      StartTick: 123,
      Chief: e.room.m_banChief.CaptureSnapshot(),
      Sequence: e.room.GetGameLaunchState().GameSequence,
      InitialObjects: 0,
      Rebirth: false,
      Packet: new CSendPacket(150),
    };
  const start = Reflect.get(e.room, "DoStartGame") as (p: unknown) => void;
  expect(() => start.call(e.room, fake)).toThrow("Expired/unissued");
  expect(state(e)).toEqual(before);
  expect(e.clients.every((p) => !p.packets.length)).toBe(true);
});

test("LIVE native Running target disconnect cancels114/4 before global detach without recalculating statistics or paying, original bound UUID survives", () => {
  const e = create(),
    target = vote(e);
  launch(e);
  running(e);
  e.clear();
  const before = financial(e),
    round = e.room.GetResultRoundID(),
    cohort = e.room.m_dynInfoCalculator.GetStateBytes();
  e.clients[1]!.Close();
  expect(e.table.DestroyPlayer(e.clients[1]!)).toBe(true);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  expect(e.room.GetResultRoundID()).toBe(round);
  expect(e.room.m_dynInfoCalculator.GetStateBytes()).toEqual(cohort);
  expect(financial(e)).toEqual(before);
  for (const i of [0, 2, 3]) {
    expect(packetCodes(e.clients[i]!)).toEqual([106, 114]);
    const p = e.clients[i]!.packets.at(-1)!;
    p.Decode1();
    expect(p.Decode1()).toBe(4);
    p.AssertEnd();
  }
  expect(target).toBeGreaterThan(0);
});

test("LIVE native durable Result accepts a NEW104 without changing committed receipt, whereas reflected Result lacking durable receipt is not an authority", () => {
  const e = create();
  launch(e);
  running(e);
  e.time(180101);
  e.room.Update();
  e.clear();
  const sql = ChiefSQLState(e.session);
  vote(e);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
  expect(ChiefSQLState(e.session)).toEqual(sql);
  const f = create();
  launch(f);
  running(f);
  f.clear();
  f.room.m_nGameState = GameStage.Result;
  expect(() => vote(f)).toThrow("durable native result");
  expect(f.clients.every((p) => !p.packets.length)).toBe(true);
});

test("LIVE potential survivor150 rejects invalid helper DWORD clock, not silently coerced to0 after roster consumption", () => {
  for (const invalid of [NaN, -1, 0x100000000, 1.5]) {
    const e = create(),
      target = vote(e);
    launch(e);
    for (const i of [0, 2, 3]) ready(e, i);
    e.clear();
    const before = state(e);
    let reads = 0;
    e.clock.GetCurrentTime = () => (++reads === 2 ? invalid : 1000);
    expect(() => respond(e, 2, target)).toThrow("DWORD clock");
    expect(state(e)).toEqual(before);
    expect(e.clients.every((p) => !p.packets.length)).toBe(true);
  }
});
