import { afterEach, describe, expect, test } from "bun:test";
import { CDBSession } from "../Common/DB/CDBSession.ts";
import { CDBMan } from "../FXGS/CDBMan.ts";
import { CUser } from "../Common/CUser.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import {
  ChannelType,
  GameStage,
  GamePlayerState,
  DynInfoLayout,
} from "../Common/OfficialValues.ts";
import {
  NormalResultCase,
  ResultEnvironment,
  ResultSubmission,
  SeedResultUsers,
  type ResultVector,
} from "./helpers/GameResult.ts";
import { ChannelFixture } from "./helpers/Channel.ts";
import { MemoryClient, Received } from "./helpers/Clients.ts";
import { UserInfo } from "./helpers/Accounts.ts";
import vectors from "./fixtures/game-result-vectors.json";
import lifeVectors from "./fixtures/result-lifecycle-vectors.json";
import { ServerResponse } from "../Common/Protocol/PacketTypes.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const action of cleanup.splice(0).reverse()) action();
});
function game(row: ResultVector = NormalResultCase) {
  const session = new CDBSession(":memory:"),
    db = new CDBMan(session),
    channel = ChannelFixture();
  const ranks: number[] = [];
  const env = ResultEnvironment(row, {
    DB: db,
    ChannelIndex: 0,
    UpdateRankList: (user) => {
      ranks.push(user.m_nSlotIdx);
      channel.pool.UpdateRankList(user);
    },
  });
  for (const peer of env.clients) {
    channel.pool.AddNewSocket(peer);
    channel.pool.InsertRankList(peer);
  }
  SeedResultUsers(db, ResultSubmission(row));
  cleanup.push(() => {
    for (const c of env.clients) c.Close();
    session.Close();
  });
  function start(duration = row.Duration): string {
    env.clock.StartGame();
    env.room.SetPlaying(true);
    env.room.m_nGameState = GameStage.Running;
    const key = env.room.BeginResultLifecycle();
    env.time((env.clock.GetStartGameTime() + duration) >>> 0);
    return key;
  }
  return { ...env, db, channel, ranks, start };
}
type Environment = ReturnType<typeof game>;
function live(e: Environment) {
  return {
    users: e.room.m_rgPlayer.map((u) => u?.GetDynamicInfoSnapshot()),
    calculator: e.room.m_dynInfoCalculator.GetStateBytes(),
    stage: e.room.m_nGameState,
    playing: e.room.m_bPlaying,
    start: e.clock.GetStartGameTime(),
    end: e.clock.GetEndGameTime(),
    ranks: e.channel.pool.GetRankList().map((u) => u.GetName()),
    packets: e.clients.map((c) => c.packets.length),
  };
}
function receiptCount(e: Environment): number {
  return e.db.session.db
    .query<{ n: number }, []>("SELECT count(*) AS n FROM RuntimeGameResult")
    .get()!.n;
}

describe("ordinary durable end/result/return TAIL (trusted fixture, start remains gated)", () => {
  test("native163 bytes, all-five-field DB mutation, counters, calculator, rank and stage happen once", () => {
    const e = game(),
      key = e.start();
    const calcAfter = e.room.m_dynInfoCalculator.GetStateBytes();
    calcAfter.writeInt32LE(
      NormalResultCase.Expected.CalculatorPremiumAfter,
      DynInfoLayout.HasPremium * Int32Array.BYTES_PER_ELEMENT,
    );
    expect(e.room.GetGameEndDecision().WinningColor).toBe(0);
    expect(e.channel.pool.GetRankList().map((u) => u.m_nSlotIdx)).toEqual([
      1, 5, 3, 2, 4, 0,
    ]);
    let syncEnds = 0;
    const syncEnd = e.room.m_syncGameObjMan.OnGameEnd.bind(
      e.room.m_syncGameObjMan,
    );
    e.room.m_syncGameObjMan.OnGameEnd = () => {
      syncEnds++;
      syncEnd();
    };
    expect(e.room.UpdateResultLifecycle()).toBe(true);
    expect(e.clock.GetEndGameTime()).toBe(45101);
    expect(e.room.m_nGameState).toBe(GameStage.Result);
    expect(e.room.m_bPlaying).toBe(true);
    expect(syncEnds).toBe(1);
    expect(e.ranks).toEqual([0, 2]);
    // Native interleaving, including a cached level-down that is NOT re-ranked.
    // Updating every user first then rank-sorting produces a different order.
    expect(e.channel.pool.GetRankList().map((u) => u.m_nSlotIdx)).toEqual([
      2, 1, 5, 3, 4, 0,
    ]);
    for (const p of NormalResultCase.Expected.Players)
      if (p) {
        const user = e.room.m_rgPlayer[p.Slot]!;
        expect(user.GetDynamicInfoSnapshot()).toEqual({
          ...p.After,
          GamesSinceFlush: (p.Before.GamesSinceFlush + 1) >>> 0,
        });
        const info = e.db.GetUserInfo(user.GetName())!;
        for (const field of ["Money", "Exp", "Win", "Draw", "Lose"] as const)
          expect(info[field]).toBe(p.After.Dynamic[field]);
      }
    expect(e.room.m_dynInfoCalculator.GetStateBytes()).toEqual(calcAfter);
    for (const peer of e.clients) {
      expect(peer.Take().m_pBlock.toString("hex")).toBe(
        NormalResultCase.Expected.Packet,
      );
      expect(peer.packets).toHaveLength(0);
    }
    const receipt = e.db.GetGameResultReceipt(key)!;
    expect(receipt.Packet.toString("hex")).toBe(
      NormalResultCase.Expected.Packet,
    );
    expect(JSON.parse(receipt.Payload).CountedSlots).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    const after = live(e);
    expect(e.room.DeferHandleGameEnd()).toBe(false);
    expect(e.room.UpdateResultLifecycle()).toBe(false);
    expect(live(e)).toEqual(after);
    expect(receiptCount(e)).toBe(1);
  });
  test("invalid and empty rounds still commit once; valid native IncGame prefix is separate from XP/WDL", () => {
    for (const name of ["single-invalid", "same-socket-invalid", "all-empty"]) {
      const row = vectors.Cases.find((r) => r.Name === name)!,
        e = game(row);
      e.room.m_aPlayerState.fill(GamePlayerState.Inactive);
      if (e.room.m_rgPlayer[0])
        e.room.m_aPlayerState[0] = GamePlayerState.WinClaim;
      const key = e.start(),
        before = e.room.m_rgPlayer.map((u) => u?.GetDynamicInfoSnapshot());
      expect(e.room.UpdateResultLifecycle()).toBe(true);
      expect(receiptCount(e)).toBe(1);
      expect(
        JSON.parse(e.db.GetGameResultReceipt(key)!.Payload).InvalidGame,
      ).toBe(true);
      for (const [slot, u] of e.room.m_rgPlayer.entries())
        if (u)
          expect(u.GetDynamicInfoSnapshot()).toEqual({
            ...before[slot]!,
            GamesSinceFlush: (before[slot]!.GamesSinceFlush + 1) >>> 0,
          });
      expect(e.room.UpdateResultLifecycle()).toBe(false);
      expect(receiptCount(e)).toBe(1);
    }
  });
  test("native signed WDL overflow is rejected at storage BEFORE any live user/clock/phase mutation", () => {
    const row = vectors.Cases.find(
        (r) => r.Name === "signed-result-counter-wrap",
      )!,
      e = game(row);
    e.start();
    const before = live(e);
    expect(() => e.room.UpdateResultLifecycle()).toThrow();
    expect(live(e)).toEqual(before);
    expect(receiptCount(e)).toBe(0);
  });
  test("claim conflict preserves original IncGame prefix before the conflicting slot", () => {
    const row = vectors.Cases.find((r) => r.Name === "normal-w-1-t45001")!;
    const e = game(row);
    e.room.m_aPlayerState[3] = GamePlayerState.WinClaim;
    const key = e.start();
    expect(e.room.GetGameEndDecision().CountedSlots).toEqual([0, 1, 2]);
    expect(e.room.UpdateResultLifecycle()).toBe(true);
    expect(e.db.GetGameResultReceipt(key)!.Packet.toString("hex")).toBe(
      row.Expected.Packet,
    );
    for (const [slot, u] of e.room.m_rgPlayer.entries())
      if (u)
        expect(u.GetDynamicInfoSnapshot().GamesSinceFlush).toBe(
          (row.Players[slot]!.State.GamesSinceFlush + (slot < 3 ? 1 : 0)) >>> 0,
        );
    expect(
      JSON.parse(e.db.GetGameResultReceipt(key)!.Payload).WinningColor,
    ).toBe(-1);
  });
  test("claims stop the clock before rank/send; SQL failure has NO clock/counter/stage/send effects", () => {
    const e = game(),
      key = e.start(),
      before = live(e);
    const commit = e.db.CommitGameResult.bind(e.db),
      first = e.room.m_rgPlayer[0]!;
    let attempts = 0;
    e.db.CommitGameResult = (input) => {
      attempts++;
      if (attempts === 1) {
        e.time(90000);
        throw new Error("injected SQL unavailable");
      }
      e.time(99999);
      return commit(input);
    };
    expect(() => e.room.UpdateResultLifecycle()).toThrow("SQL unavailable");
    expect(live(e)).toEqual(before);
    expect(e.db.GetGameResultReceipt(key)).toBeUndefined();
    const send = e.clients[0]!.SendPacket.bind(e.clients[0]!);
    const observations: unknown[] = [];
    e.clients[0]!.SendPacket = (p) => {
      observations.push({
        end: e.clock.GetEndGameTime(),
        count: first.GetDynamicInfoSnapshot().GamesSinceFlush,
        stage: e.room.m_nGameState,
        durable: !!e.db.GetGameResultReceipt(key),
        reentrantUpdate: e.room.UpdateResultLifecycle(),
        reentrantReturn: e.room.DoReturnPrepareStage(),
      });
      send(p);
    };
    expect(e.room.UpdateResultLifecycle()).toBe(true);
    expect(attempts).toBe(2);
    expect(observations).toEqual([
      {
        end: 45101,
        count: 1,
        stage: GameStage.Running,
        durable: true,
        reentrantUpdate: false,
        reentrantReturn: false,
      },
    ]);
    expect(e.room.GetResultPublicationFailures()).toEqual([]);
    expect(e.db.GetGameResultReceipt(key)!.Packet.toString("hex")).toBe(
      NormalResultCase.Expected.Packet,
    );
    expect(
      JSON.parse(e.db.GetGameResultReceipt(key)!.Payload).ElapsedMilliseconds,
    ).toBe(45001);
    expect(e.clock.GetEndGameTime()).toBe(45101);
    expect(receiptCount(e)).toBe(1);
  });
  test("lost COMMIT acknowledgement retries by receipt without a second award", () => {
    const e = game(),
      key = e.start(),
      before = live(e),
      commit = e.db.CommitGameResult.bind(e.db);
    e.db.CommitGameResult = (input) => {
      commit(input);
      throw new Error("injected lost acknowledgement");
    };
    expect(() => e.room.UpdateResultLifecycle()).toThrow(
      "lost acknowledgement",
    );
    expect(live(e)).toEqual(before);
    expect(e.db.GetGameResultReceipt(key)).toBeDefined();
    e.db.CommitGameResult = commit;
    expect(e.room.UpdateResultLifecycle()).toBe(true);
    expect(e.db.GetUserInfo("Result0")!.Win).toBe(
      NormalResultCase.Expected.Players[0]!.After.Dynamic.Win,
    );
    expect(e.room.m_rgPlayer[0]!.GetDynamicInfoSnapshot().GamesSinceFlush).toBe(
      NormalResultCase.Players[0]!.State.GamesSinceFlush + 1,
    );
    expect(receiptCount(e)).toBe(1);
    expect(e.clients.every((p) => p.packets.length === 1)).toBe(true);
  });
  test("CAS conflict freezes the FIRST plan; retry cannot grow XP into a later time bucket", () => {
    const e = game(),
      key = e.start(15000),
      before = live(e);
    const table = e.db.session.db;
    table
      .query("UPDATE FxUserDynamic SET Money=Money+1 WHERE ID='Result5'")
      .run();
    expect(e.room.UpdateResultLifecycle()).toBe(false);
    expect(live(e)).toEqual(before);
    expect(receiptCount(e)).toBe(0);
    expect(() =>
      e.room.OnLapFinished(Received(new CSendPacket(0)), e.clients[0]!),
    ).toThrow("frozen");
    e.time(90000);
    table
      .query("UPDATE FxUserDynamic SET Money=Money-1 WHERE ID='Result5'")
      .run();
    expect(e.room.UpdateResultLifecycle()).toBe(true);
    const receipt = e.db.GetGameResultReceipt(key)!;
    expect(JSON.parse(receipt.Payload).ElapsedMilliseconds).toBe(15000);
    expect(
      JSON.parse(receipt.Payload).Changes.every(
        (c: { ExperienceDelta: number }) => c.ExperienceDelta === 0,
      ),
    ).toBe(true);
    expect(e.db.GetUserInfo("Result0")!.Exp).toBe(
      NormalResultCase.Players[0]!.State.Dynamic.Exp,
    );
    expect(e.db.GetUserInfo("Result0")!.Win).toBe(
      NormalResultCase.Expected.Players[0]!.After.Dynamic.Win,
    );
    expect(e.clock.GetEndGameTime()).toBe(15100);
  });
  test("membership/stat/dynamic changes after a frozen failure require explicit recovery, not a new plan", () => {
    for (const mutate of [
      (e: Environment) => (e.room.m_aPlayerState[0] = GamePlayerState.Inactive),
      (e: Environment) => e.room.m_rgPlayer[0]!.IncDecExp(1),
      (e: Environment) => e.room.m_dynInfoCalculator.SetKillerIndex(0, 1),
      (e: Environment) => e.clock.StartGame(),
      (e: Environment) => e.clock.EndGame(),
      (e: Environment) => (e.room.m_rgSlotInfo[0]![2] = 3),
      (e: Environment) => e.room.m_rgPlayer[0]!.SetAuthenCode(0),
    ]) {
      const e = game();
      e.start();
      e.db.session.db
        .query("UPDATE FxUserDynamic SET Money=Money+1 WHERE ID='Result5'")
        .run();
      expect(e.room.UpdateResultLifecycle()).toBe(false);
      mutate(e);
      e.db.session.db
        .query("UPDATE FxUserDynamic SET Money=Money-1 WHERE ID='Result5'")
        .run();
      expect(() => e.room.UpdateResultLifecycle()).toThrow();
      expect(receiptCount(e)).toBe(0);
      expect(e.clients.every((p) => p.packets.length === 0)).toBe(true);
    }
  });
  test("timeout ordering differs: result BEFORE clock.EndGame; no IncGame or sync.OnGameEnd", () => {
    const e = game();
    for (let i = 0; i < 6; i++)
      e.room.m_aPlayerState[i] = GamePlayerState.Active;
    const key = e.start(180001);
    let syncEnds = 0;
    const syncEnd = e.room.m_syncGameObjMan.OnGameEnd.bind(
      e.room.m_syncGameObjMan,
    );
    e.room.m_syncGameObjMan.OnGameEnd = () => {
      syncEnds++;
      syncEnd();
    };
    const preview = e.room.MakeGameResultPreview(-1, 180001);
    const send = e.clients[0]!.SendPacket.bind(e.clients[0]!);
    const observations: unknown[] = [];
    e.clients[0]!.SendPacket = (p) => {
      observations.push({
        end: e.clock.GetEndGameTime(),
        stage: e.room.m_nGameState,
        durable: !!e.db.GetGameResultReceipt(key),
      });
      e.time(190000);
      send(p);
    };
    expect(e.room.UpdateResultLifecycle()).toBe(true);
    expect(observations).toEqual([
      { end: 0, stage: GameStage.Running, durable: true },
    ]);
    expect(e.room.GetResultPublicationFailures()).toEqual([]);
    expect(e.clock.GetEndGameTime()).toBe(190000);
    expect(syncEnds).toBe(0);
    expect(e.room.m_nGameState).toBe(GameStage.Result);
    expect(JSON.parse(e.db.GetGameResultReceipt(key)!.Payload).Reason).toBe(
      "timeout",
    );
    for (const peer of e.clients)
      expect(peer.Take().m_pBlock).toEqual(preview.Packet.GetBuffer());
    for (const [slot, u] of e.room.m_rgPlayer.entries())
      if (u)
        expect(u.GetDynamicInfoSnapshot()).toEqual(
          preview.Players[slot]!.After,
        );
  });
  test("claim decision has priority over an already-expired timeout", () => {
    const e = game(),
      key = e.start(180001);
    expect(e.room.UpdateResultLifecycle()).toBe(true);
    const p = JSON.parse(e.db.GetGameResultReceipt(key)!.Payload);
    expect(p.Reason).toBe("claims");
    expect(p.WinningColor).toBe(0);
    expect(p.CountedSlots).toEqual([0, 1, 2, 3, 4, 5]);
    expect(e.room.m_rgPlayer[0]!.GetDynamicInfoSnapshot().GamesSinceFlush).toBe(
      NormalResultCase.Players[0]!.State.GamesSinceFlush + 1,
    );
  });
  test("independent C++ unsigned active-time cutoff vectors (including underflow/wrap)", () => {
    for (const row of lifeVectors.ActiveTimeout) {
      const e = game();
      for (let slot = 0; slot < 6; slot++)
        e.room.m_aPlayerState[slot] = GamePlayerState.Active;
      e.start(row.Elapsed);
      e.clock.m_dwTimeStopped = row.Stopped;
      expect(e.room.UpdateResultLifecycle()).toBe(row.Expires);
      expect(e.room.m_nGameState).toBe(
        row.Expires ? GameStage.Result : GameStage.Running,
      );
      expect(receiptCount(e)).toBe(row.Expires ? 1 : 0);
    }
  });
  test("failed rank/send callbacks do NOT undo paid rows or publish twice; other peers continue", () => {
    const e = game(),
      key = e.start(),
      original = e.channel.pool.UpdateRankList.bind(e.channel.pool);
    const reentrant: boolean[] = [];
    e.channel.pool.UpdateRankList = (u) => {
      reentrant.push(
        e.room.UpdateResultLifecycle(),
        e.room.DeferHandleGameEnd(),
      );
      if (u.m_nSlotIdx === 0) throw new Error("injected rank failure");
      original(u);
    };
    e.clients[0]!.SendPacket = () => {
      throw new Error("injected transport failure");
    };
    expect(e.room.UpdateResultLifecycle()).toBe(true);
    expect(e.room.GetResultPublicationFailures()).toEqual(["rank", "packet"]);
    expect(reentrant).toEqual([false, false, false, false]);
    expect(e.db.GetGameResultReceipt(key)).toBeDefined();
    expect(e.db.GetUserInfo("Result0")!.Win).toBe(
      NormalResultCase.Expected.Players[0]!.After.Dynamic.Win,
    );
    expect(e.clients.slice(1).every((c) => c.packets.length === 1)).toBe(true);
    expect(e.room.UpdateResultLifecycle()).toBe(false);
    expect(receiptCount(e)).toBe(1);
    e.time(53102);
    expect(e.room.DeferReturnPrepareStage()).toBe(true);
    expect(e.room.GetResultPublicationFailures()).toEqual([
      "rank",
      "packet",
      "return-packet",
    ]);
    expect(e.db.GetUserInfo("Result0")!.Win).toBe(
      NormalResultCase.Expected.Players[0]!.After.Dynamic.Win,
    );
  });
  test("per-target byte copy prevents a custom SendPacket from corrupting next peer/receipt", () => {
    const e = game(),
      key = e.start();
    e.clients[0]!.SendPacket = (p) => {
      p.Encode1(255);
    };
    expect(e.room.UpdateResultLifecycle()).toBe(true);
    for (const peer of e.clients.slice(1))
      expect(peer.Take().m_pBlock.toString("hex")).toBe(
        NormalResultCase.Expected.Packet,
      );
    expect(e.db.GetGameResultReceipt(key)!.Packet.toString("hex")).toBe(
      NormalResultCase.Expected.Packet,
    );
  });
  test("return164 is sent before reset; only source return fields change; return cannot be reentered", () => {
    const e = game(),
      key = e.start();
    expect(e.room.UpdateResultLifecycle()).toBe(true);
    e.room.m_nMapIdx = 12;
    e.room.m_nMapIdxPlaying = 5;
    e.room.m_ulBanTargetSerialNo = 0xf1234567;
    e.room.m_nModified = 0;
    e.room.m_aBomberIdxPlaying.fill(3);
    const raw = [255, 254, 253, 252, 251, 250, 249, 248];
    for (const [i, b] of raw.entries()) e.room.m_rgSlotInfo[i]![0] = b;
    const before = {
      calc: e.room.m_dynInfoCalculator.GetStateBytes(),
      states: [...e.room.m_aPlayerState],
      shop: [...e.room.m_aShopItemAttempted],
      slots: e.room.m_rgSlotInfo.map((b) => Buffer.from(b)),
      users: e.room.m_rgPlayer.slice(),
      clock: e.clock.GetEndGameTime(),
    };
    for (const peer of e.clients) peer.Clear();
    const send = e.clients[0]!.SendPacket.bind(e.clients[0]!);
    const observations: unknown[] = [];
    e.clients[0]!.SendPacket = (p) => {
      observations.push({
        bytes: p.GetBuffer().toString("hex"),
        stage: e.room.m_nGameState,
        playing: e.room.m_bPlaying,
        map: e.room.m_nMapIdxPlaying,
        banTarget: e.room.m_ulBanTargetSerialNo,
        reentrantUpdate: e.room.UpdateResultLifecycle(),
        reentrantReturn: e.room.DoReturnPrepareStage(),
      });
      send(p);
    };
    e.time(53101);
    expect(e.room.DeferReturnPrepareStage()).toBe(false); // exactly8000
    e.time(53102);
    expect(e.room.DeferReturnPrepareStage()).toBe(true);
    expect(observations).toEqual([
      {
        bytes: lifeVectors.ReturnBody,
        stage: GameStage.Result,
        playing: true,
        map: 5,
        banTarget: 0xf1234567,
        reentrantUpdate: false,
        reentrantReturn: false,
      },
    ]);
    expect(e.room.GetResultPublicationFailures()).toEqual([]);
    expect(e.room.m_nGameState).toBe(GameStage.Loading);
    expect(e.room.m_bPlaying).toBe(false);
    expect(e.room.m_nMapIdx).toBe(12);
    expect(e.room.m_nMapIdxPlaying).toBe(-1);
    expect(e.room.m_ulBanTargetSerialNo).toBe(0);
    expect(e.room.GetStartChatTimeTick()).toBe(53102);
    expect(e.room.m_nModified).toBe(1);
    expect([...e.room.m_aBomberIdxPlaying]).toEqual(Array(8).fill(-1));
    for (const [i, b] of before.slots.entries())
      expect(e.room.m_rgSlotInfo[i]).toEqual(
        Buffer.from([lifeVectors.SlotReturnBytes[raw[i]!]!, b[1]!, b[2]!]),
      );
    expect(e.room.m_dynInfoCalculator.GetStateBytes()).toEqual(before.calc);
    expect([...e.room.m_aPlayerState]).toEqual(before.states);
    expect([...e.room.m_aShopItemAttempted]).toEqual(before.shop);
    expect(e.room.m_rgPlayer).toEqual(before.users);
    expect(e.clock.GetEndGameTime()).toBe(before.clock);
    expect(e.room.GetResultRoundID()).toBeUndefined();
    expect(e.db.GetGameResultReceipt(key)).toBeDefined();
    for (const peer of e.clients) {
      const p = peer.Take(ServerResponse.ReturnPrepareStage);
      expect(p.Decode1()).toBe(0);
      p.AssertEnd();
    }
    expect(e.room.DoReturnPrepareStage()).toBe(false);
    expect(e.room.UpdateResultLifecycle()).toBe(false);
  });
  test("independent C++ 210 return deadline/phase/playing vectors, including tick0 and wrap", () => {
    const row = vectors.Cases.find((r) => r.Name === "all-empty")!;
    for (const v of lifeVectors.Return) {
      const e = game(row);
      e.time((v.End - 45001) >>> 0);
      const key = e.start(45001);
      expect(e.room.UpdateResultLifecycle()).toBe(true);
      expect(e.clock.GetEndGameTime()).toBe(v.End);
      e.room.m_bPlaying = !!v.Playing;
      e.room.m_nGameState = v.Phase;
      e.time(v.Now);
      expect(e.room.DeferReturnPrepareStage()).toBe(v.Returns);
      expect(e.room.m_nGameState).toBe(v.Returns ? GameStage.Loading : v.Phase);
      expect(e.db.GetGameResultReceipt(key)).toBeDefined();
    }
  });
  test("independent C++ all256 ready-mask byte cases", () => {
    const row = vectors.Cases.find((r) => r.Name === "all-empty")!;
    for (let first = 0; first < 256; first += 8) {
      const e = game(row);
      e.start();
      expect(e.room.UpdateResultLifecycle()).toBe(true);
      for (let slot = 0; slot < 8; slot++)
        e.room.m_rgSlotInfo[slot]![0] = first + slot;
      expect(e.room.DoReturnPrepareStage()).toBe(true);
      expect(e.room.m_rgSlotInfo.map((b) => b[0])).toEqual(
        lifeVectors.SlotReturnBytes.slice(first, first + 8),
      );
    }
  });
  test("next round needs new preparation AND new server key; old statistics cannot be reused", () => {
    const e = game(),
      first = e.start();
    expect(() => e.room.BeginResultLifecycle()).toThrow("fresh");
    expect(() => e.room.PrepareRoundStatistics()).toThrow("active");
    expect(e.room.UpdateResultLifecycle()).toBe(true);
    expect(e.room.DoReturnPrepareStage()).toBe(true);
    e.clock.StartGame();
    e.room.SetPlaying(true);
    e.room.m_nGameState = GameStage.Running;
    expect(() => e.room.BeginResultLifecycle()).toThrow("fresh");
    e.room.SetPlaying(false);
    e.room.PrepareRoundStatistics();
    e.clock.StartGame();
    e.room.SetPlaying(true);
    const second = e.room.BeginResultLifecycle();
    expect(second).not.toBe(first);
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
    e.time(90102);
    expect(e.room.UpdateResultLifecycle()).toBe(true);
    expect(receiptCount(e)).toBe(2);
    expect(e.db.GetUserInfo("Result0")!.Win).toBe(
      NormalResultCase.Players[0]!.State.Dynamic.Win + 2,
    );
  });
  test("no storage/round receipt cannot return or award, and unsupported modes reject BEFORE SQL", () => {
    const detached = ResultEnvironment();
    cleanup.push(() => detached.clients.forEach((c) => c.Close()));
    expect(() => detached.room.BeginResultLifecycle()).toThrow("no durable");
    expect(detached.room.DoReturnPrepareStage()).toBe(false);
    for (const type of ["BangPok", "Mod", "no-round"]) {
      const e = game();
      e.clock.StartGame();
      e.room.SetPlaying(true);
      e.room.m_nGameState = GameStage.Running;
      if (type === "BangPok") e.room.m_bBangPok = true;
      if (type === "Mod") {
        e.room.SendGameTypeMod();
        for (const c of e.clients) c.Clear();
      }
      if (type === "no-round")
        expect(() => e.room.UpdateResultLifecycle()).toThrow("not been begun");
      else expect(() => e.room.BeginResultLifecycle()).toThrow("unported");
      expect(receiptCount(e)).toBe(0);
      expect(e.clients.every((c) => c.packets.length === 0)).toBe(true);
    }
    const e = game();
    e.start();
    e.room.m_bBangPok = true;
    expect(() => e.room.UpdateResultLifecycle()).toThrow("unported");
    expect(receiptCount(e)).toBe(0);
    const special = game();
    const guild = ResultEnvironment(
      NormalResultCase,
      { DB: special.db, ChannelIndex: 0, UpdateRankList: () => {} },
      ChannelType.Guild,
    );
    cleanup.push(() => guild.clients.forEach((c) => c.Close()));
    guild.clock.StartGame();
    guild.room.SetPlaying(true);
    guild.room.m_nGameState = GameStage.Running;
    expect(() => guild.room.BeginResultLifecycle()).toThrow("unported");
    expect(receiptCount(special)).toBe(0);
  });
  test("active-round AddAllUser rejects; same-object leave/rejoin via room API invalidates old preparation", () => {
    const e = game(),
      p = e.clients[0]!,
      user = e.room.m_rgPlayer[0]!;
    e.start();
    const peer = new MemoryClient();
    cleanup.push(() => peer.Close());
    const newcomer = new CUser(UserInfo("NewPlayer"), 456);
    newcomer.m_pClientSocket = peer;
    peer.m_aUser.push(newcomer);
    expect(() => e.room.AddAllUser(peer, [0])).toThrow("active");
    // A non-started preview also rejects same-object membership ABA through APIs.
    const raw = ResultEnvironment();
    cleanup.push(() => raw.clients.forEach((c) => c.Close()));
    const old = raw.room.m_rgPlayer[0]!,
      owner = old.m_pClientSocket!;
    raw.room.DestroyPlayer(owner);
    raw.room.AddAllUser(owner, [0, 0]);
    expect(raw.room.m_rgPlayer).toContain(old);
    expect(() => raw.room.MakeGameResultPreview(0, 45001)).toThrow("changed");
    expect(user.m_pClientSocket).toBe(p);
    expect(receiptCount(e)).toBe(0);
  });
});
