import { afterEach, describe, expect, test } from "bun:test";
import { CDBSession } from "../Common/DB/CDBSession.ts";
import { CDBMan, type GameResultSubmission } from "../FXGS/CDBMan.ts";
import { CGameContext } from "../FXGS/CGameContext.ts";
import { CGameSession } from "../FXGS/CGameSession.ts";
import { CGameSessionTable } from "../FXGS/CGameSessionTable.ts";
import { CGameClock } from "../FXGS/CGameClock.ts";
import { CTimerThreadNormal } from "../FXGS/CTimerThreadNormal.ts";
import { CServerApp } from "../CServerApp.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CTextCodec } from "../Common/CTextCodec.ts";
import {
  CProtocolError,
  CUnsupportedOperation,
} from "../Common/CProtocolError.ts";
import {
  GameStage,
  GamePlayerState,
  ChannelType,
  GameUpdateTiming,
} from "../Common/OfficialValues.ts";
import { ServerResponse } from "../Common/Protocol/PacketTypes.ts";
import { CPeImage, OFFICIAL_SERVICES } from "../Tools/OfficialSource.ts";
import {
  ResultEnvironment,
  ResultSubmission,
  SeedResultUsers,
  NormalResultCase,
  ResultResources,
} from "./helpers/GameResult.ts";
import { Received } from "./helpers/Clients.ts";
import { TestConfig } from "./helpers/Accounts.ts";
import vectors from "./fixtures/game-update-vectors.json";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
/** TRUSTED running setup, never a network launch or a client-playability test. */
function game(start = 100) {
  const session = new CDBSession(":memory:"),
    db = new CDBMan(session);
  const env = ResultEnvironment(NormalResultCase, {
    DB: db,
    ChannelIndex: 0,
    UpdateRankList: () => {},
  });
  SeedResultUsers(db, ResultSubmission());
  env.time(start);
  env.clock.StartGame();
  env.room.m_aPlayerState.fill(GamePlayerState.Inactive);
  env.room.m_aPlayerState[0] = GamePlayerState.PendingDie;
  env.room.SetPlaying(true);
  env.room.m_nGameState = GameStage.Running;
  const key = env.room.BeginResultLifecycle();
  for (const client of env.clients) client.Clear();
  cleanup.push(() => {
    for (const c of env.clients) c.Close();
    session.Close();
  });
  return { ...env, db, key };
}
type Environment = ReturnType<typeof game>;
function table(db: CDBMan) {
  return new CGameSessionTable(
    new CTextCodec(),
    ResultResources.bombers,
    ResultResources.maps,
    ChannelType.Normal,
    () => {},
    { DB: db, ChannelIndex: 0, UpdateRankList: () => {} },
  );
}
function timerState(e: Environment) {
  const ctx = e.room.GetCurrentGameContext();
  return {
    states: [...e.room.m_aPlayerState],
    times: [...ctx.m_aPlayerStateTime],
    bombs: structuredClone(ctx.m_aBomb),
    last: e.room.GetLastUpdateTime(),
    stage: e.room.m_nGameState,
    playing: e.room.m_bPlaying,
    users: e.room.m_rgPlayer.map((u) => u?.GetDynamicInfoSnapshot()),
    calculator: e.room.m_dynInfoCalculator.GetStateBytes(),
    end: e.clock.GetEndGameTime(),
    packets: e.clients.map((c) =>
      c.packets.map((p) => p.m_pBlock.toString("hex")),
    ),
  };
}
function loss(e: Environment) {
  e.room.OnPacket(
    Received(
      new CSendPacket(187).Encode1(e.clients[1]!.m_aUser[0]!.m_nSlotIdx),
    ),
    e.clients[0]!,
  );
}
function payload(db: CDBMan, key: string): GameResultSubmission {
  return JSON.parse(
    db.GetGameResultReceipt(key)!.Payload,
  ) as GameResultSubmission;
}
function receipts(db: CDBMan): number {
  return db.session.db
    .query<{ n: number }, []>("SELECT count(*) AS n FROM RuntimeGameResult")
    .get()!.n;
}
async function deadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Game timer test deadline")),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("native Update blocks and guarded ordinary timed driver (NETWORK start still gated)", () => {
  test("16 source/PE instruction anchors bind timer400, unsigned >=, batch159, native no-op and last tick", () => {
    const pe = new CPeImage(OFFICIAL_SERVICES.FXGS);
    expect(pe.sha256).toBe(vectors.OfficialPE.SHA256);
    expect(vectors.InstructionAnchors).toHaveLength(16);
    for (const anchor of vectors.InstructionAnchors)
      expect(pe.read(anchor.VA, anchor.Bytes.length / 2).toString("hex")).toBe(
        anchor.Bytes,
      );
    expect(GameUpdateTiming.NormalTimerIntervalMilliseconds).toBe(400);
  });
  test("216 independent C++ state/age/underflow/rollover cases and all256 pending masks", () => {
    const ctx = new CGameContext();
    ctx.Init();
    expect(vectors.StateTimers).toHaveLength(216);
    expect(vectors.PendingMasks).toHaveLength(256);
    for (const row of [...vectors.StateTimers, ...vectors.PendingMasks]) {
      const states = Uint8Array.from(row.States);
      ctx.m_aPlayerStateTime.set(row.Times);
      const expired = ctx.AdvancePlayerStateTimers(states, () => row.Elapsed);
      expect(expired).toEqual(row.Expired);
      expect([...states]).toEqual(row.AfterStates);
      expect([...ctx.m_aPlayerStateTime]).toEqual(row.AfterTimes);
      // The helper never assigns killers, saves, house scores or ghost points.
      expect([...ctx.m_aHouseCount]).toEqual(Array(8).fill(0));
    }
  });
  test("native samples ElapsedTime separately per check and again for each expired player's timestamp", () => {
    const ctx = new CGameContext();
    const states = Uint8Array.from([3, 1, 1, 3, 1, 1, 1, 1]);
    ctx.m_aPlayerStateTime.fill(10);
    const samples = [6009, 6010, 6011];
    let reads = 0;
    expect(
      ctx.AdvancePlayerStateTimers(states, () => samples[reads++]!),
    ).toEqual([3]);
    expect(reads).toBe(3);
    expect([...states]).toEqual([3, 1, 1, 1, 1, 1, 1, 1]);
    expect(ctx.m_aPlayerStateTime[0]).toBe(10);
    expect(ctx.m_aPlayerStateTime[3]).toBe(6011);
    expect(() =>
      ctx.AdvancePlayerStateTimers(new Uint8Array(7), () => ++reads),
    ).toThrow("eight");
    expect(reads).toBe(3);
    expect(
      ctx.AdvancePlayerStateTimers(new Uint8Array(8).fill(1), () => ++reads),
    ).toEqual([]);
    expect(reads).toBe(3);
  });
  test("128 production grouped159 bodies match C++ including vacant-slot timers and slot ordering", () => {
    const e = game(),
      ctx = e.room.GetCurrentGameContext();
    // Slot0 always remains pending (age0), so end claims do not preempt the timer
    // block. Slots6/7 are vacant but still belong to native's eight-state scan.
    const rows = vectors.PendingMasks.filter((r) => r.States[0] === 3);
    expect(rows).toHaveLength(128);
    for (const row of rows) {
      e.room.m_aPlayerState.set(row.States);
      ctx.m_aPlayerStateTime.set(row.Times);
      e.time(10100);
      e.room.Update();
      expect([...e.room.m_aPlayerState]).toEqual(row.AfterStates);
      expect([...ctx.m_aPlayerStateTime]).toEqual(row.AfterTimes);
      for (const peer of e.clients) {
        expect(peer.packets.map((p) => p.m_pBlock.toString("hex"))).toEqual(
          row.Body ? [row.Body] : [],
        );
        peer.Clear();
      }
      expect(e.room.m_nGameState).toBe(GameStage.Running);
    }
    expect(receipts(e.db)).toBe(0);
    expect(e.room.GetUpdatePublicationFailures()).toEqual({
      BombTimer: 0,
      ServerDie: 0,
    });
  });
  test("6 independent full frames: bombs -> pending death -> NEXT-tick result -> strict8s return", () => {
    const e = game(),
      ctx = e.room.GetCurrentGameContext();
    ctx.m_aBomb.push(...vectors.InitialBombs.map((b) => ({ ...b })));
    const before = e.room.m_rgPlayer.map((u) => u?.GetDynamicInfoSnapshot());
    let syncEnds = 0;
    const onEnd = e.room.m_syncGameObjMan.OnGameEnd.bind(
      e.room.m_syncGameObjMan,
    );
    e.room.m_syncGameObjMan.OnGameEnd = () => {
      syncEnds++;
      onEnd();
    };
    for (const frame of vectors.Frames) {
      e.time(frame.Now);
      e.room.Update();
      expect(e.room.m_nGameState).toBe(frame.Stage);
      expect(e.room.m_bPlaying).toBe(frame.Playing);
      expect(e.room.GetLastUpdateTime()).toBe(frame.LastUpdate);
      expect(e.clock.GetEndGameTime()).toBe(frame.End);
      expect([...e.room.m_aPlayerState]).toEqual(frame.States);
      expect([...ctx.m_aPlayerStateTime]).toEqual(frame.Times);
      expect(ctx.m_aBomb).toEqual(frame.Bombs);
      for (const peer of e.clients) {
        expect(peer.packets.map((p) => p.m_nPacketType)).toEqual(frame.Opcodes);
        expect(
          peer.packets
            .filter((p) => p.m_nPacketType !== 163)
            .map((p) => p.m_pBlock.toString("hex")),
        ).toEqual(frame.NonResultBodies);
        peer.Clear();
      }
      if (frame.Now === 6100) {
        expect(receipts(e.db)).toBe(0);
        expect(syncEnds).toBe(0);
        expect(
          e.room.m_rgPlayer.map((u) => u?.GetDynamicInfoSnapshot()),
        ).toEqual(before);
      }
    }
    expect(syncEnds).toBe(1);
    expect(receipts(e.db)).toBe(1);
    const receipt = payload(e.db, e.key);
    expect(receipt.ElapsedMilliseconds).toBe(6001);
    expect(receipt.WinningColor).toBe(-1);
    expect(receipt.Reason).toBe("claims");
    for (const [slot, user] of e.room.m_rgPlayer.entries())
      if (user) {
        expect(user.GetDynamicInfoSnapshot().Dynamic.Exp).toBe(
          before[slot]!.Dynamic.Exp,
        );
        expect(user.GetDynamicInfoSnapshot().Dynamic.Draw).toBe(
          before[slot]!.Dynamic.Draw + 1,
        );
        expect(user.GetDynamicInfoSnapshot().GamesSinceFlush).toBe(
          before[slot]!.GamesSinceFlush + 1,
        );
      }
  });
  test("same-tick152/159 batch is fully mutated BEFORE publication; direct end and nested Update cannot interleave", () => {
    const e = game(),
      ctx = e.room.GetCurrentGameContext();
    ctx.AddBomb(0x12, 3);
    const peer = e.clients[0]!,
      send = peer.SendPacket.bind(peer);
    let callbacks = 0;
    const rejected: boolean[] = [];
    peer.SendPacket = (packet) => {
      callbacks++;
      expect(ctx.m_aBomb).toHaveLength(0);
      expect(e.room.m_aPlayerState[0]).toBe(GamePlayerState.Inactive);
      expect(ctx.m_aPlayerStateTime[0]).toBe(6000);
      expect(receipts(e.db)).toBe(0);
      e.room.Update();
      rejected.push(
        e.room.UpdateResultLifecycle(),
        e.room.DeferHandleGameEnd(),
        e.room.DeferReturnPrepareStage(),
        e.room.DoReturnPrepareStage(),
      );
      expect(() =>
        e.room.OnPacket(
          Received(new CSendPacket(140).Encode1(0).Encode1(0x12).Encode1(3)),
          peer,
        ),
      ).toThrow("during a round update");
      e.room.UpdateBombTimers(100000); // cannot advance a second live clock
      send(packet);
    };
    e.time(6100);
    e.room.Update();
    expect(callbacks).toBe(2);
    expect(rejected).toEqual(Array(8).fill(false));
    expect(e.room.GetLastUpdateTime()).toBe(6100);
    for (const peer of e.clients)
      expect(peer.packets.map((p) => p.m_nPacketType)).toEqual([152, 159]);
    expect(e.room.GetUpdatePublicationFailures()).toEqual({
      BombTimer: 0,
      ServerDie: 0,
    });
    // Assertions inside a production-caught send callback are also checked here.
    peer.SendPacket = send;
    e.time(6101);
    e.room.Update();
    expect(e.room.m_nGameState).toBe(GameStage.Result);
    expect(receipts(e.db)).toBe(1);
  });
  test("all eight state bytes choose the deadline; a vacant Active slot extends it to10000, no stopped-time subtraction", () => {
    const e = game(),
      ctx = e.room.GetCurrentGameContext();
    e.room.m_aPlayerState[7] = GamePlayerState.Active; // EMPTY, still counted
    e.clock.m_dwTimeStopped = 5000;
    e.time(6100);
    e.room.Update();
    expect(e.room.m_aPlayerState[0]).toBe(GamePlayerState.PendingDie);
    expect(e.clients.every((p) => p.packets.length === 0)).toBe(true);
    e.time(10099);
    e.room.Update();
    expect(e.room.m_aPlayerState[0]).toBe(GamePlayerState.PendingDie);
    e.time(10100);
    e.room.Update();
    expect(e.room.m_aPlayerState[0]).toBe(GamePlayerState.Inactive);
    expect(ctx.m_aPlayerStateTime[0]).toBe(10000); // NOT5000 active elapsed
    for (const peer of e.clients)
      expect(peer.packets.map((p) => p.m_nPacketType)).toEqual([159]);
  });
  test("entry-tick anchor is not overwritten by a later transport/SQL clock sample", () => {
    const e = game(),
      ctx = e.room.GetCurrentGameContext();
    e.room.m_aPlayerState[1] = GamePlayerState.Active;
    const b = ctx.AddBomb(0x12, 3);
    ctx.KickBomb(b.SerialNo, 0x12, 0x23, 100);
    const peer = e.clients[0]!,
      send = peer.SendPacket.bind(peer);
    let changed = false;
    peer.SendPacket = (p) => {
      if (!changed) {
        changed = true;
        e.time(12100);
      }
      send(p);
    };
    e.time(10100);
    e.room.Update();
    expect(e.room.GetLastUpdateTime()).toBe(10100);
    expect(ctx.m_aPlayerStateTime[0]).toBe(10000);
    expect(ctx.m_aBomb[0]!.RemainingMilliseconds).toBe(2000);
    for (const p of e.clients) p.Clear();
    e.time(12200);
    e.room.Update();
    expect(ctx.m_aBomb).toHaveLength(0); //2100, NOT100 since the later send sample
    expect(e.room.GetLastUpdateTime()).toBe(12200);
    for (const p of e.clients)
      expect(p.packets.map((p) => p.m_nPacketType)).toEqual([152]);
  });
  test("bomb frame delta uses DWORD wrap, not Date.now or elapsed-since-start on every tick", () => {
    const e = game(0xfffffff0),
      ctx = e.room.GetCurrentGameContext();
    e.room.m_aPlayerState[0] = GamePlayerState.Active;
    const b = ctx.AddBomb(0x12, 3);
    ctx.SetBombTimer(b.SerialNo, 0x12, 100);
    e.time(0x20);
    e.room.Update();
    expect(b.RemainingMilliseconds).toBe(52);
    e.time(0x30);
    e.room.Update();
    expect(b.RemainingMilliseconds).toBe(36);
    expect(e.room.GetLastUpdateTime()).toBe(0x30);
    expect(e.clients.every((p) => p.packets.length === 0)).toBe(true);
  });
  test("forced native claims preempt elapsed timeout, due UDP and both timer blocks; sync cleanup only on claims", () => {
    const e = game(),
      ctx = e.room.GetCurrentGameContext();
    e.room.m_aPlayerState[0] = GamePlayerState.WinClaim;
    e.room.m_aPlayerState[2] = GamePlayerState.PendingDie;
    e.room.m_aPlayerState[7] = GamePlayerState.HouseWinner; // native vacant6 quirk
    ctx.AddBomb(0x12, 3);
    loss(e);
    const bombs = structuredClone(ctx.m_aBomb),
      times = ctx.m_aPlayerStateTime.slice();
    let syncEnds = 0;
    e.room.m_syncGameObjMan.OnGameEnd = () => {
      syncEnds++;
    };
    e.time(180101);
    e.room.Update();
    expect(payload(e.db, e.key).Reason).toBe("claims");
    expect(e.room.m_nGameState).toBe(GameStage.Result);
    expect(syncEnds).toBe(1);
    expect(ctx.m_aBomb).toEqual(bombs);
    expect(ctx.m_aPlayerStateTime).toEqual(times);
    expect(e.room.m_aPlayerState[2]).toBe(GamePlayerState.PendingDie);
    expect(e.room.m_udpLossRegulator.m_bPending).toBe(true);
    for (const p of e.clients)
      expect(p.packets.map((p) => p.m_nPacketType)).toEqual([163]);
  });
  test("exact180000 remains a timer tick; strictly beyond is timeout without IncGame or same-tick sync cleanup", () => {
    const e = game(),
      ctx = e.room.GetCurrentGameContext();
    e.room.m_aPlayerState[0] = GamePlayerState.Active;
    ctx.AddBomb(0x12, 3);
    e.time(180100);
    e.room.Update();
    expect(e.room.m_nGameState).toBe(GameStage.Running);
    expect(receipts(e.db)).toBe(0);
    for (const p of e.clients) {
      expect(p.packets.map((p) => p.m_nPacketType)).toEqual([152]);
      p.Clear();
    }
    const counts = e.room.m_rgPlayer.map(
      (u) => u?.GetDynamicInfoSnapshot().GamesSinceFlush,
    );
    const b = ctx.AddBomb(0x23, 3),
      before = { ...b };
    let syncEnds = 0;
    e.room.m_syncGameObjMan.OnGameEnd = () => {
      syncEnds++;
    };
    e.time(180101);
    e.room.Update();
    expect(e.room.m_nGameState).toBe(GameStage.Result);
    expect(syncEnds).toBe(0);
    expect(payload(e.db, e.key).Reason).toBe("timeout");
    expect(
      e.room.m_rgPlayer.map((u) => u?.GetDynamicInfoSnapshot().GamesSinceFlush),
    ).toEqual(counts);
    expect(b).toEqual(before);
    for (const p of e.clients)
      expect(p.packets.map((p) => p.m_nPacketType)).toEqual([163]);
  });
  test("a frozen CAS conflict consumes no state/bomb timers and retries the ORIGINAL plan", () => {
    const e = game(),
      ctx = e.room.GetCurrentGameContext();
    e.room.m_aPlayerState[0] = GamePlayerState.HouseWinner;
    ctx.AddBomb(0x12, 3);
    const commit = e.db.CommitGameResult.bind(e.db),
      plans: GameResultSubmission[] = [];
    e.db.CommitGameResult = (plan) => {
      plans.push(plan);
      return "conflict";
    };
    const states = [...e.room.m_aPlayerState],
      bombs = structuredClone(ctx.m_aBomb);
    const sessions = table(e.db);
    sessions.m_rgGameSession.set(e.room.m_nIdx, e.room);
    expect(sessions.GetPendingResultCount()).toBe(0);
    e.time(15100);
    sessions.UpdateGameSessions();
    expect(sessions.GetPendingResultCount()).toBe(1);
    expect(sessions.GetUpdateFailures()).toEqual([]); // normal CAS conflict, separately visible
    e.time(70100);
    e.room.Update();
    expect(plans).toHaveLength(2);
    expect(plans[1]).toBe(plans[0]);
    expect(plans[0]!.ElapsedMilliseconds).toBe(15000);
    expect(e.room.GetLastUpdateTime()).toBe(70100);
    expect(ctx.m_aBomb).toEqual(bombs);
    expect([...e.room.m_aPlayerState]).toEqual(states);
    e.room.UpdateBombTimers(100000);
    expect(ctx.m_aBomb).toEqual(bombs);
    expect(e.clients.every((p) => p.packets.length === 0)).toBe(true);
    expect(receipts(e.db)).toBe(0);
    e.db.CommitGameResult = commit;
    e.time(140100);
    e.room.Update();
    expect(payload(e.db, e.key).ElapsedMilliseconds).toBe(15000);
    expect(e.clock.GetEndGameTime()).toBe(15100);
    expect(sessions.GetPendingResultCount()).toBe(0);
    expect(ctx.m_aBomb).toEqual(bombs);
  });
  test("due UDP ejection fails closed BEFORE graph/timers/frame-delta consumption, not a fake pool recovery", () => {
    const e = game(),
      ctx = e.room.GetCurrentGameContext();
    e.room.m_aPlayerState[0] = GamePlayerState.Active;
    const b = ctx.AddBomb(0x12, 3);
    b.RemainingMilliseconds = 10000;
    loss(e);
    e.time(8100);
    e.room.Update();
    expect(b.RemainingMilliseconds).toBe(2000);
    expect(e.room.GetLastUpdateTime()).toBe(8100);
    expect(e.room.m_udpLossRegulator.IsRegulationDue()).toBe(false);
    const before = timerState(e),
      matrix = e.room.m_udpLossRegulator.GetLossMatrix();
    e.time(8101);
    expect(() => e.room.Update()).toThrow("ejection/recovery");
    expect(timerState(e)).toEqual(before);
    expect(e.room.m_udpLossRegulator.GetLossMatrix()).toEqual(matrix);
    expect(e.room.m_udpLossRegulator.m_bPending).toBe(true);
    expect(e.clients.every((p) => p.IsConnected())).toBe(true);
    expect(receipts(e.db)).toBe(0);
  });
  test("per-target detached152/159 bytes and failed transport do not corrupt peers, repeat death or auto-replay", () => {
    const e = game(),
      ctx = e.room.GetCurrentGameContext();
    ctx.AddBomb(0x12, 3);
    const peer = e.clients[0]!,
      send = peer.SendPacket.bind(peer);
    peer.SendPacket = (packet) => {
      packet.m_pBlock.fill(0xff);
      throw new Error("not a delivery ack");
    };
    e.time(6100);
    e.room.Update();
    expect(e.room.GetUpdatePublicationFailures()).toEqual({
      BombTimer: 1,
      ServerDie: 1,
    });
    const bodies = e.clients[1]!.packets.map((p) => p.m_pBlock.toString("hex"));
    expect(bodies).toHaveLength(2);
    for (const other of e.clients.slice(1))
      expect(other.packets.map((p) => p.m_pBlock.toString("hex"))).toEqual(
        bodies,
      );
    const returned = e.room.GetUpdatePublicationFailures();
    Object.assign(returned, { BombTimer: 999 });
    expect(e.room.GetUpdatePublicationFailures().BombTimer).toBe(1);
    peer.SendPacket = send;
    for (const p of e.clients) p.Clear();
    e.time(6101);
    e.room.Update();
    for (const p of e.clients)
      expect(p.packets.map((p) => p.m_nPacketType)).toEqual([163]);
    expect(e.room.GetUpdatePublicationFailures()).toEqual({
      BombTimer: 1,
      ServerDie: 1,
    });
    expect(ctx.m_aBomb).toHaveLength(0);
    expect(receipts(e.db)).toBe(1);
  });
  test("unbound running, loading, Guild/BangPok/Mod remain unavailable BEFORE timer mutation", () => {
    const e = game(),
      ctx = e.room.GetCurrentGameContext();
    ctx.AddBomb(0x12, 3);
    e.time(10100);
    e.room.m_nGameState = GameStage.Loading;
    const before = timerState(e);
    expect(() => e.room.Update()).toThrow("loading/waiting");
    expect(timerState(e)).toEqual(before);
    e.room.m_nGameState = GameStage.Running;
    e.room.m_bBangPok = true;
    expect(() => e.room.Update()).toThrow("special result lifecycle");
    e.room.m_bBangPok = false;
    e.room.SendGameTypeMod();
    for (const p of e.clients) p.Clear();
    const modBefore = timerState(e);
    expect(() => e.room.Update()).toThrow("special result lifecycle");
    expect(timerState(e)).toEqual(modBefore);
    expect(receipts(e.db)).toBe(0);
    const raw = ResultEnvironment();
    cleanup.push(() => {
      for (const c of raw.clients) c.Close();
    });
    raw.clock.StartGame();
    raw.room.SetPlaying(true);
    raw.room.m_nGameState = GameStage.Running;
    expect(() => raw.room.Update()).toThrow("no durable result services");
    const guild = ResultEnvironment(
      NormalResultCase,
      { DB: e.db, ChannelIndex: 0, UpdateRankList: () => {} },
      ChannelType.Guild,
    );
    cleanup.push(() => {
      for (const c of guild.clients) c.Close();
    });
    guild.room.SetPlaying(true);
    guild.room.m_nGameState = GameStage.Running;
    expect(() => guild.room.Update()).toThrow("special result lifecycle");
  });
});

describe("partial native table/timer wiring, not full launch/waiting/loading scheduling", () => {
  test("UpdateGameEtc is a verified native no-op; table hook preserves normal stripes without a round gate", () => {
    const e = game(),
      sessions = table(e.db),
      calls: number[] = [];
    const before = timerState(e);
    e.room.UpdateGameEtc();
    expect(timerState(e)).toEqual(before);
    expect(receipts(e.db)).toBe(0);
    for (const index of [254, 9, 0, 255, 8, 1]) {
      const room = new CGameSession(
        index,
        index + 1,
        "Native Etc",
        "",
        0,
        sessions.text,
        ResultResources.bombers,
        ResultResources.maps,
        ChannelType.Normal,
      );
      room.UpdateGameEtc = () => {
        calls.push(index);
      };
      room.Update = () => {
        throw new Error("Etc must NOT schedule waiting/running");
      };
      sessions.m_rgGameSession.set(index, room);
    }
    sessions.UpdateGameEtc();
    expect(calls).toEqual([0, 8, 1, 9, 254]);
    expect(sessions.GetScheduledRoundCount()).toBe(0);
    expect(sessions.GetUpdateFailures()).toEqual([]);
  });
  test("eight-stripe native traversal, trusted-round gate, sanitized failures, isolation and reentrancy", () => {
    const e = game(),
      sessions = table(e.db),
      calls: number[] = [];
    function room(index: number, serial = index + 1, bound = true) {
      const r = new CGameSession(
        index,
        serial,
        "Update traversal",
        "",
        0,
        sessions.text,
        ResultResources.bombers,
        ResultResources.maps,
        0,
        new CGameClock(() => 100),
        { DB: e.db, ChannelIndex: 0, UpdateRankList: () => {} },
      );
      r.PrepareRoundStatistics();
      r.GetGameClock().StartGame();
      r.SetPlaying(true);
      r.m_nGameState = GameStage.Running;
      if (bound) r.BeginResultLifecycle();
      sessions.m_rgGameSession.set(index, r);
      r.m_nModified = 0;
      r.Update = () => {
        calls.push(index);
      };
      return r;
    }
    for (const index of [254, 9, 8, 7, 1, 0]) room(index);
    room(2, 3, false); // arbitrary public Running flags cannot opt into the timer
    const a = sessions.m_rgGameSession.get(0)!;
    a.Update = () => {
      calls.push(0);
      sessions.UpdateGameSessions();
    };
    const bad = sessions.m_rgGameSession.get(8)!;
    bad.Update = () => {
      calls.push(8);
      throw new CProtocolError("secret account/SQL", "also-secret");
    };
    sessions.m_rgGameSession.get(9)!.Update = () => {
      calls.push(9);
      throw new CUnsupportedOperation("secret", "secret");
    };
    sessions.UpdateGameSessions();
    expect(calls).toEqual([0, 8, 1, 9, 254, 7]);
    expect(sessions.GetScheduledRoundCount()).toBe(6);
    expect(sessions.GetUpdateFailures()).toEqual([
      {
        SessionIndex: 8,
        SessionSerialNo: 9,
        Code: "protocol-error",
        ConsecutiveFailures: 1,
      },
      {
        SessionIndex: 9,
        SessionSerialNo: 10,
        Code: "unported-feature",
        ConsecutiveFailures: 1,
      },
    ]);
    expect(JSON.stringify(sessions.GetUpdateFailures())).not.toContain(
      "secret",
    );
    Object.assign(sessions.GetUpdateFailures()[0]!, { Code: "changed" });
    expect(sessions.GetUpdateFailures()[0]!.Code).toBe("protocol-error");
    sessions.UpdateGameSessions();
    expect(sessions.GetUpdateFailures()[0]!.ConsecutiveFailures).toBe(2);
    room(8, 999).Update = () => {
      throw new Error("another-secret");
    };
    sessions.UpdateGameSessions();
    expect(sessions.GetUpdateFailures()[0]).toEqual({
      SessionIndex: 8,
      SessionSerialNo: 999,
      Code: "update-error",
      ConsecutiveFailures: 1,
    });
    sessions.m_rgGameSession.delete(8);
    sessions.m_rgGameSession.get(9)!.Update = () => {};
    sessions.UpdateGameSessions();
    expect(sessions.GetUpdateFailures()).toEqual([]);
  });
  test("real receipt plus lost COMMIT ack retries on next table tick, without double live award or timer advance", () => {
    const e = game(),
      sessions = table(e.db),
      ctx = e.room.GetCurrentGameContext();
    sessions.m_rgGameSession.set(e.room.m_nIdx, e.room);
    e.room.m_aPlayerState[0] = GamePlayerState.HouseWinner;
    ctx.AddBomb(0x12, 3);
    const before = timerState(e),
      commit = e.db.CommitGameResult.bind(e.db);
    let calls = 0;
    e.db.CommitGameResult = (plan) => {
      const result = commit(plan);
      if (++calls === 1) throw new Error("lost SQL COMMIT ack secret");
      return result;
    };
    e.time(45101);
    sessions.UpdateGameSessions();
    expect(timerState(e)).toEqual(before);
    expect(receipts(e.db)).toBe(1);
    expect(sessions.GetPendingResultCount()).toBe(1);
    expect(sessions.GetUpdateFailures()).toEqual([
      {
        SessionIndex: 17,
        SessionSerialNo: 91,
        Code: "update-error",
        ConsecutiveFailures: 1,
      },
    ]);
    e.time(90101);
    sessions.UpdateGameSessions();
    expect(calls).toBe(2);
    expect(receipts(e.db)).toBe(1);
    expect(sessions.GetUpdateFailures()).toEqual([]);
    expect(sessions.GetPendingResultCount()).toBe(0);
    expect(e.room.m_nGameState).toBe(GameStage.Result);
    expect(e.clock.GetEndGameTime()).toBe(45101);
    expect(e.room.GetLastUpdateTime()).toBe(90101);
    expect(payload(e.db, e.key).ElapsedMilliseconds).toBe(45001);
    expect(ctx.m_aBomb).toEqual(before.bombs);
    for (const p of e.clients)
      expect(p.packets.map((p) => p.m_nPacketType)).toEqual([163]);
  });
  test("CTimerThreadNormal sleeps before work, single-use start, and Stop inside a callback prevents rescheduling", async () => {
    const e = game(),
      timer = new CTimerThreadNormal(table(e.db));
    let calls = 0;
    cleanup.push(() => timer.Stop());
    const done = new Promise<void>((resolve) => {
      timer.UpdateGameSessions = () => {
        calls++;
        timer.Stop();
        resolve();
      };
    });
    timer.Start();
    expect(timer.IsRunning()).toBe(true);
    expect(calls).toBe(0);
    expect(() => timer.Start()).toThrow("twice");
    await deadline(done);
    expect(calls).toBe(1);
    expect(timer.IsRunning()).toBe(false);
    await Bun.sleep(425);
    expect(calls).toBe(1);
    timer.Stop();
    expect(() => timer.Start()).toThrow("cleanup");
    expect(timer.GetFailedTickCount()).toBe(0);
  });
  test("unexpected OUTER timer failure is counted/redacted and cleanup before start never schedules work", async () => {
    const e = game(),
      sessions = table(e.db),
      stopped = new CTimerThreadNormal(sessions);
    stopped.Stop();
    expect(() => stopped.Start()).toThrow("cleanup");
    expect(stopped.IsRunning()).toBe(false);
    const timer = new CTimerThreadNormal(sessions);
    cleanup.push(() => timer.Stop());
    const done = new Promise<void>((resolve) => {
      timer.UpdateGameSessions = () => {
        timer.Stop();
        resolve();
        throw new Error("secret account/SQL");
      };
    });
    timer.Start();
    await deadline(done);
    expect(timer.GetFailedTickCount()).toBe(1);
    expect(timer.IsRunning()).toBe(false);
  });
  test("actual app timer drives trusted SQLite163 and delayed164; cleanup stops game work BEFORE DB closes", async () => {
    const app = new CServerApp(TestConfig());
    const db = new CDBMan(app.m_dbSession);
    const env = ResultEnvironment(NormalResultCase, {
      DB: db,
      ChannelIndex: 0,
      UpdateRankList: () => {},
    });
    try {
      SeedResultUsers(db, ResultSubmission());
      await app.SetUp();
      const gameServer = app.m_gameServers[0]!,
        peer = env.clients[0]!,
        send = peer.SendPacket.bind(peer);
      const done = Promise.withResolvers<void>(),
        returned = Promise.withResolvers<void>();
      peer.SendPacket = (p) => {
        send(p);
        if (p.m_nPacketType === 163) done.resolve();
        if (p.m_nPacketType === 164) returned.resolve();
      };
      env.room.m_aPlayerState.fill(GamePlayerState.Inactive);
      env.room.m_aPlayerState[0] = GamePlayerState.WinClaim;
      env.clock.StartGame();
      env.room.SetPlaying(true);
      env.room.m_nGameState = GameStage.Running;
      const key = env.room.BeginResultLifecycle();
      env.time(45101);
      gameServer.m_gameSessionTable.m_rgGameSession.set(
        env.room.m_nIdx,
        env.room,
      );
      expect(app.GetStatus().gameUpdate[0]!.running).toBe(true);
      expect(app.GetStatus().gameUpdate[0]!.scope).toBe(
        "ordinary-loading-running-result",
      );
      await deadline(done.promise);
      expect(env.room.m_nGameState).toBe(GameStage.Result);
      expect(receipts(db)).toBe(1);
      expect(payload(db, key).ElapsedMilliseconds).toBe(45001);
      expect(app.GetStatus().gameUpdate[0]!.failedRooms).toBe(0);
      expect(app.GetStatus().gameUpdate[0]!.pendingResults).toBe(0);
      env.time((env.clock.GetEndGameTime() + 8001) >>> 0);
      await deadline(returned.promise);
      expect(env.room.m_bPlaying).toBe(false);
      expect(env.room.m_nGameState).toBe(GameStage.Loading);
      expect(app.GetStatus().gameUpdate[0]!.scheduledRounds).toBe(0);
      expect(app.GetStatus().completeOfficialRewrite).toBe(false);
      for (const p of env.clients)
        expect(p.packets.map((p) => p.m_nPacketType)).toEqual([
          ServerResponse.GameResult,
          ServerResponse.ReturnPrepareStage,
        ]);
    } finally {
      await app.CleanUp();
      for (const p of env.clients) p.Close();
    }
    expect(app.GetStatus().gameUpdate.every((s) => !s.running)).toBe(true);
    expect(() => app.m_dbSession.db.query("SELECT 1").get()).toThrow();
  });
});
