import { afterEach, expect, test } from "bun:test";
import vectors from "./fixtures/scoring-vectors.json";
import { CFastFile } from "../Common/CFastFile.ts";
import { CTextCodec } from "../Common/CTextCodec.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CUser } from "../Common/CUser.ts";
import { CGameClock } from "../FXGS/CGameClock.ts";
import { CGameSession } from "../FXGS/CGameSession.ts";
import { CBomberAttr } from "../FXGS/CBomberAttr.ts";
import { CGameMapTmplList } from "../FXGS/CGameMapTmplList.ts";
import {
  GameStage,
  GamePlayerState,
  ChannelType,
  SlotStateMask,
} from "../Common/OfficialValues.ts";
import { CPeImage, OFFICIAL_SERVICES } from "../Tools/OfficialSource.ts";
import { MemoryClient, Received } from "./helpers/Clients.ts";
import { ScoringPlayers, type ScoringPlayer } from "./helpers/Scoring.ts";
import { UserInfo } from "./helpers/Accounts.ts";

const files = new CFastFile();
files.FastFileInit("FXGS/FxServer");
const bombers = new CBomberAttr();
bombers.Load(files);
const maps = new CGameMapTmplList();
maps.CreateTmplList(files);
const sockets: MemoryClient[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.Close();
});

/** Trusted state injection ONLY. Real network start remains unavailable. */
function game(
  input: readonly (ScoringPlayer | null)[] = vectors.Rooms[5]!.Players,
  premium = false,
) {
  let now = 100;
  const clock = new CGameClock(() => now);
  const room = new CGameSession(
    17,
    91,
    "Scoring kernel",
    "",
    0,
    new CTextCodec(),
    bombers,
    maps,
    premium ? ChannelType.Premium : ChannelType.Normal,
    clock,
  );
  const peers = ScoringPlayers(input);
  sockets.push(...peers.Clients);
  for (let slot = 0; slot < 8; slot++) {
    const user = peers.Players[slot];
    room.m_rgPlayer[slot] = user;
    room.m_rgSlotInfo[slot]!.set(peers.Slots[slot]!);
    room.m_aPlayerState[slot] = user
      ? GamePlayerState.Active
      : GamePlayerState.Inactive;
    if (user) {
      user.m_nSessionIdx = room.m_nIdx;
      user.m_nSessionSerialNo = room.m_ulSerialNo;
    }
  }
  return {
    room,
    clock,
    ...peers,
    time: (value: number) => {
      now = value;
    },
  };
}
function running() {
  const env = game();
  env.room.PrepareRoundStatistics();
  env.room.m_bPlaying = true;
  env.room.m_nGameState = GameStage.Running;
  env.clock.StartGame();
  return env;
}
const send = (room: CGameSession, peer: MemoryClient, packet: CSendPacket) =>
  room.OnPacket(Received(packet), peer);
const event = (header: number, x = 0, y = 0) =>
  new CSendPacket(146).Encode1(header).Encode2(x).Encode2(y);
function snapshot(room: CGameSession): string {
  const ctx = room.GetCurrentGameContext();
  return JSON.stringify({
    stats: room.m_dynInfoCalculator.GetStateBytes().toString("hex"),
    state: [...room.m_aPlayerState],
    time: [...ctx.m_aPlayerStateTime],
    positions: ctx.m_aGhostPosition,
    boxes: [...ctx.m_aBoxItemState],
    obstacles: [...ctx.m_aObstacleState],
    playing: room.m_bPlaying,
    stage: room.m_nGameState,
  });
}
const noPackets = (clients: readonly MemoryClient[]) => {
  for (const client of clients) expect(client.packets).toHaveLength(0);
};

// Actual session preparation/classification, not a second test implementation
// of its team traversal. C++ fixtures include levels, holes and local pairs.
test("session team statistics and winner/detail helpers match all frozen C++ snapshots", () => {
  for (const row of vectors.Rooms) {
    const { room, clock, Clients } = game(row.Players, row.PremiumChannel);
    const calc = room.m_dynInfoCalculator;
    room.m_aPlayerState.set(row.States);
    calc.Init(room.m_rgPlayer, room.m_rgSlotInfo);
    const infoBefore = JSON.stringify(
      room.m_rgPlayer.map((u) => u?.m_userInfo),
    );
    for (const expected of row.Snapshots) {
      if (expected.Name === "Teams") room.PrepareRoundStatistics();
      else if (expected.Name === "Actions")
        for (const action of row.Actions) {
          if (action.Kind === "kill")
            calc.SetKillerIndex(action.Victim, action.Actor);
          else if (action.Kind === "save")
            calc.SetSaverIndex(action.Victim, action.Actor);
          else if (action.Kind === "nice")
            calc.SetNice(action.Actor, action.Value);
        }
      else if (expected.Name === "Premium") calc.SetHasPremium(row.Premium);
      else if (expected.Name === "Reset")
        calc.Init(room.m_rgPlayer, room.m_rgSlotInfo);
      expect(calc.GetStateBytes().toString("hex")).toBe(expected.State);
      for (let slot = 0; slot < 8; slot++) {
        expect(room.GetWinGameResult(slot)).toBe(expected.Win[slot]!);
        if (row.Players[slot])
          expect(room.GetGameDetailResult(slot)).toBe(expected.Detail[slot]!);
      }
    }
    expect([...room.m_aPlayerState]).toEqual(row.States);
    expect(room.m_bPlaying).toBe(false);
    expect(room.m_nGameState).toBe(GameStage.Loading);
    expect(clock.GetStartGameTime()).toBe(0);
    expect(clock.GetEndGameTime()).toBe(0);
    expect(JSON.stringify(room.m_rgPlayer.map((u) => u?.m_userInfo))).toBe(
      infoBefore,
    );
    noPackets(Clients);
  }
});

test("preparation rejects bad room ownership/colors before replacing previous statistics", () => {
  const { room, Clients, Players } = game();
  room.PrepareRoundStatistics();
  room.m_dynInfoCalculator.SetKillerIndex(3, 0);
  const before = room.m_dynInfoCalculator.GetStateBytes();
  room.m_rgSlotInfo[5]![2] = 31;
  expect(() => room.PrepareRoundStatistics()).toThrow("color");
  expect(room.m_dynInfoCalculator.GetStateBytes()).toEqual(before);
  room.m_rgSlotInfo[5]![2] = 3;
  Players[5]!.m_nSessionSerialNo++;
  expect(() => room.PrepareRoundStatistics()).toThrow("generation");
  expect(room.m_dynInfoCalculator.GetStateBytes()).toEqual(before);
  noPackets(Clients);
});

test("GetWinGameResult counts states 2/6 across all slots, not only the winning color or occupied slots", () => {
  const { room } = game();
  room.PrepareRoundStatistics();
  room.m_aPlayerState.fill(1);
  room.m_aPlayerState[0] = 2;
  room.m_aPlayerState[3] = 2;
  room.m_aPlayerState[7] = 6;
  expect(room.GetWinGameResult(0)).toBe(true);
  room.m_aPlayerState[7] = 5;
  expect(room.GetWinGameResult(0)).toBe(false); // state 5 is NOT counted
  const small = game(vectors.Rooms[3]!.Players);
  small.room.PrepareRoundStatistics();
  small.room.m_aPlayerState.fill(2);
  expect(small.room.GetWinGameResult(0)).toBe(false);
});

test("detail uses the authencode BYTE exactly equal to 1; ticket date and premium channel do not substitute", () => {
  const { room, Players } = game(undefined, true);
  room.PrepareRoundStatistics();
  const user = Players[0]!;
  for (const auth of [0, 2, 255]) {
    user.SetAuthenCode(auth);
    user.m_userInfo.TicketDate = 9999999999;
    expect(room.GetGameDetailResult(0)).toBe(0);
  }
  user.SetAuthenCode(0x101);
  expect(user.GetAuthencode()).toBe(1);
  user.m_userInfo.TicketDate = 0;
  expect(room.GetGameDetailResult(0)).toBe(3);
  for (let i = 0; i < 3; i++) room.m_dynInfoCalculator.SetKillerIndex(3, 0);
  expect(room.GetGameDetailResult(0)).toBe(1); // repeated same-victim kills are counted
  room.m_dynInfoCalculator.SetSaverIndex(1, 0);
  room.m_dynInfoCalculator.SetSaverIndex(1, 0);
  expect(room.GetGameDetailResult(0)).toBe(1);
  room.m_dynInfoCalculator.SetSaverIndex(2, 0);
  expect(room.GetGameDetailResult(0)).toBe(2);
  expect(() => room.GetGameDetailResult(7)).toThrow("Missing");
});

test("512 end/house-state patterns agree with independent C++; no clock/result/DB side effects", () => {
  const input = [
    { Level: 1, Color: 0, Socket: 1, Authencode: 0 },
    { Level: 1, Color: 3, Socket: 1, Authencode: 0 },
    { Level: 1, Color: 0, Socket: 2, Authencode: 0 },
    null,
    null,
    null,
    null,
    null,
  ];
  const { room, clock, Clients, Players } = game(input);
  room.PrepareRoundStatistics();
  room.m_bPlaying = true;
  room.m_nGameState = GameStage.Running;
  clock.StartGame();
  const info = JSON.stringify(Players.map((u) => u?.m_userInfo));
  const stats = room.m_dynInfoCalculator.GetStateBytes();
  for (const v of vectors.Decisions) {
    room.m_aPlayerState.set(v.States);
    expect(room.GetGameEndDecision()).toEqual({
      Ready: v.Ready,
      Forced: v.Forced,
      WinningColor: v.WinningColor,
      ConflictingClaims: v.ConflictingClaims,
      CountedSlots: v.CountedSlots,
    });
    expect([...room.m_aPlayerState]).toEqual(v.States);
    room.GetCurrentGameContext().m_aHouseCount.set(v.HouseCounts);
    send(room, Clients[0]!, new CSendPacket(162));
    expect([...room.m_aPlayerState]).toEqual(v.HouseStates);
  }
  expect(room.m_dynInfoCalculator.GetStateBytes()).toEqual(stats);
  expect(JSON.stringify(Players.map((u) => u?.m_userInfo))).toBe(info);
  expect(clock.GetEndGameTime()).toBe(0);
  expect(room.m_bPlaying).toBe(true);
  expect(room.m_nGameState).toBe(GameStage.Running);
  noPackets(Clients);
});

test("house arbitration clears an early tie on a later higher count and excludes dead/opaque-4-only teams", () => {
  const input = [
    { Level: 1, Color: 0, Socket: 1, Authencode: 0 },
    { Level: 1, Color: 3, Socket: 1, Authencode: 0 },
    { Level: 1, Color: 6, Socket: 2, Authencode: 0 },
    { Level: 1, Color: 7, Socket: 2, Authencode: 0 },
    { Level: 1, Color: 7, Socket: 3, Authencode: 0 },
    null,
    null,
    null,
  ];
  const { room, Clients, clock } = game(input);
  room.m_bPlaying = true;
  room.m_nGameState = GameStage.Running;
  clock.StartGame();
  const counts = room.GetCurrentGameContext().m_aHouseCount;
  counts[0] = 2;
  counts[3] = 2;
  counts[6] = 4;
  counts[7] = 999;
  room.m_aPlayerState[3] = 1;
  room.m_aPlayerState[4] = 4;
  send(room, Clients[0]!, new CSendPacket(162));
  expect([...room.m_aPlayerState]).toEqual([0, 0, 6, 1, 4, 1, 1, 1]);
  // A color becomes eligible through one active teammate. Its state-4 member
  // is changed too, because the native final pass excludes only state 1.
  room.m_aPlayerState[3] = 0;
  send(room, Clients[0]!, new CSendPacket(162));
  expect([...room.m_aPlayerState]).toEqual([0, 0, 6, 6, 6, 1, 1, 1]);
  expect(clock.GetEndGameTime()).toBe(0);
  noPackets(Clients);
});

test("end helper preserves empty-state-6 force and native conflicting-claim counter prefix", () => {
  const { room } = game();
  room.m_aPlayerState.fill(1);
  room.m_aPlayerState[0] = 0;
  room.m_aPlayerState[7] = 5;
  expect(room.GetGameEndDecision().Ready).toBe(false); // empty 5 does not force
  room.m_aPlayerState[7] = 6;
  expect(room.GetGameEndDecision()).toEqual({
    Ready: true,
    Forced: true,
    WinningColor: -1,
    ConflictingClaims: false,
    CountedSlots: [0, 1, 2, 3, 4, 5],
  });
  room.m_aPlayerState.fill(1);
  room.m_aPlayerState[0] = 2;
  room.m_aPlayerState[3] = 2;
  expect(room.GetGameEndDecision()).toEqual({
    Ready: true,
    Forced: false,
    WinningColor: -1,
    ConflictingClaims: true,
    CountedSlots: [0, 1, 2],
  });
});

test("event 2 records full WORD CPoint/time and excludes the whole sender socket from 159", () => {
  const { room, time, Clients } = running();
  time(800);
  send(room, Clients[0]!, event(0x21, 0xffff, 0xfffe));
  const ctx = room.GetCurrentGameContext();
  expect(room.m_aPlayerState[1]).toBe(3);
  expect(ctx.m_aPlayerStateTime[1]).toBe(700);
  expect(ctx.m_aGhostPosition[1]).toEqual({ x: 65535, y: 65534 });
  expect(Clients[0]!.packets).toHaveLength(0);
  for (const peer of Clients.slice(1)) {
    const p = peer.Take(159);
    expect(p.DecodeBuffer(p.remaining).toString("hex")).toBe("7b5a965a97");
    p.AssertEnd();
  }
});

test("event 3 deduplicates saver/victim, ignores saver >=8, and does not forward saver byte", () => {
  const { room, Clients } = running();
  for (const saver of [0, 0, 255, 8]) {
    room.m_aPlayerState[1] = 3;
    send(room, Clients[0]!, event(0x31, 0, 1).Encode1(saver));
    expect(room.m_aPlayerState[1]).toBe(0);
    expect(room.m_dynInfoCalculator.GetSaveCount(0)).toBe(1);
    for (const peer of Clients.slice(1)) {
      const p = peer.Take(159);
      expect(p.DecodeBuffer(p.remaining).toString("hex")).toBe("6ba569a568");
    }
  }
  noPackets(Clients);
});

test("normal event 4 clears every validated drop, counts repeated kills and broadcasts to sender too", () => {
  const { room, Clients, time } = running();
  time(950);
  const ctx = room.GetCurrentGameContext();
  ctx.m_aBoxItemState[126] = 2;
  ctx.m_aBoxItemState[249] = 1;
  ctx.SetObstacleState(0, 12, 1);
  ctx.SetObstacleState(12, 14, 1);
  const death = () =>
    event(0x41, 1, 2)
      .Encode1(2)
      .Encode1(2)
      .Encode1(0x0c)
      .Encode1(126)
      .Encode1(0xce)
      .Encode1(249);
  for (let repetition = 1; repetition <= 2; repetition++) {
    send(room, Clients[0]!, death());
    expect(room.m_dynInfoCalculator.GetKillCount(2)).toBe(repetition);
    for (const peer of Clients) {
      const p = peer.Take(159);
      expect(p.DecodeBuffer(p.remaining).toString("hex")).toBe(
        "1ba568a56b5858562494a3",
      );
    }
  }
  expect(ctx.m_aBoxItemState[126]).toBe(0);
  expect(ctx.m_aBoxItemState[249]).toBe(0);
  expect(ctx.GetObstacleState(0, 12)).toBe(0);
  expect(ctx.GetObstacleState(12, 14)).toBe(0);
  expect(room.m_aPlayerState[1]).toBe(1);
  expect(ctx.m_aPlayerStateTime[1]).toBe(850);
  noPackets(Clients);
});

test("event 4 signed -1 sentinel and preserved state 4 have their distinct native effects", () => {
  const { room, Clients, time } = running();
  time(900);
  const ctx = room.GetCurrentGameContext();
  room.m_aPlayerState[1] = 4;
  ctx.m_aPlayerStateTime[1] = 0xabcdef01;
  send(room, Clients[0]!, event(0x41).Encode1(255).Encode1(0));
  expect(room.m_aPlayerState[1]).toBe(4);
  expect(ctx.m_aPlayerStateTime[1]).toBe(0xabcdef01);
  for (let slot = 0; slot < 8; slot++)
    expect(room.m_dynInfoCalculator.GetKillCount(slot)).toBe(0);
  for (const client of Clients) {
    const p = client.Take(159);
    expect(p.DecodeBuffer(p.remaining).toString("hex")).toBe("1ba569a569a55a");
  }
});

test("truncated/trailing/invalid death events cannot partially increment kills or clear earlier drops", () => {
  const { room, Clients } = running();
  const ctx = room.GetCurrentGameContext();
  ctx.m_aBoxItemState[126] = 1;
  ctx.SetObstacleState(1, 2, 1);
  const before = snapshot(room);
  // Raw body includes scalar coding (BYTE ^5a, WORD ^a569), not plaintext.
  const valid = Buffer.from("1ba568a56b5858482494a3", "hex");
  const reject = (body: Buffer) => {
    expect(() =>
      send(room, Clients[0]!, new CSendPacket(146).EncodeBuffer(body)),
    ).toThrow();
    expect(snapshot(room)).toBe(before);
    noPackets(Clients);
  };
  for (let size = 0; size < valid.length; size++)
    reject(valid.subarray(0, size));
  reject(Buffer.concat([valid, Buffer.from([0])]));
  for (const killer of [8, 127, 128, 254]) {
    const b = Buffer.from(valid);
    b[5] = killer ^ 0x5a;
    reject(b);
  }
  for (const box of [250, 255]) {
    const b = Buffer.from(valid);
    b[10] = box ^ 0x5a;
    reject(b);
  }
  for (const position of [0x0f, 0xd0, 0xff]) {
    const b = Buffer.from(valid);
    b[9] = position ^ 0x5a;
    reject(b);
  }
  // Prove that the baseline body really is a valid death event, not a bad
  // header that merely made every preceding rejection test pass trivially.
  send(room, Clients[0]!, new CSendPacket(146).EncodeBuffer(valid));
  expect(room.m_dynInfoCalculator.GetKillCount(2)).toBe(1);
  expect(ctx.m_aBoxItemState[126]).toBe(0);
  expect(ctx.GetObstacleState(1, 2)).toBe(0);
  for (const client of Clients) {
    const p = client.Take(159);
    expect(p.DecodeBuffer(p.remaining)).toEqual(valid);
  }
});

test("notify 1/7 are header-only; event 6 records a claim but cannot end clock or settle", () => {
  const { room, clock, Clients } = running();
  for (const header of [0x11, 0x71, 0x61]) {
    send(room, Clients[0]!, event(header, 1234, 5678));
    for (const peer of Clients.slice(1)) {
      const p = peer.Take(159);
      expect(p.Decode1()).toBe(header);
      expect(p.Decode2()).toBe(1234);
      expect(p.Decode2()).toBe(5678);
      p.AssertEnd();
    }
  }
  expect(room.m_aPlayerState[1]).toBe(2);
  expect(clock.GetEndGameTime()).toBe(0);
  expect(room.m_nGameState).toBe(GameStage.Running);
  noPackets(Clients);
});

test("unsupported special/opaque/server-only/Mod-death variants fail before any state mutation", () => {
  const { room, Clients } = running();
  let before = snapshot(room);
  for (const header of [0x01, 0x81, 0x51, 0xf1]) {
    expect(() => send(room, Clients[0]!, event(header))).toThrow();
    expect(snapshot(room)).toBe(before);
    noPackets(Clients);
  }
  room.SendGameTypeMod();
  for (const peer of Clients) peer.Clear();
  before = snapshot(room);
  expect(() =>
    send(room, Clients[0]!, event(0x41).Encode1(2).Encode1(0)),
  ).toThrow("captain");
  expect(snapshot(room)).toBe(before);
  noPackets(Clients);
});

test("first occupied lap finish is retained, includes a secondary local user, and ignores empty state 5", () => {
  const { room, Clients, clock } = running();
  room.m_aPlayerState[7] = 5;
  send(room, Clients[0]!, new CSendPacket(154).Encode1(1));
  send(room, Clients[1]!, new CSendPacket(154).Encode1(3));
  expect(room.m_aPlayerState[1]).toBe(5);
  expect(room.m_aPlayerState[3]).toBe(0);
  expect(room.GetGameEndDecision().Forced).toBe(true);
  expect(clock.GetEndGameTime()).toBe(0);
  noPackets(Clients);
});

test("battle/house/lap guards reject spoofing, trailing data, marked users and stale generations atomically", () => {
  const { room, Clients, Players } = running();
  let before = snapshot(room);
  for (const packet of [
    event(0x22),
    event(0x28),
    new CSendPacket(154).Encode1(2),
    new CSendPacket(154).Encode1(1).Encode1(0),
    new CSendPacket(162).Encode1(0),
    event(0x21).Encode1(0),
  ]) {
    expect(() => send(room, Clients[0]!, packet)).toThrow();
    expect(snapshot(room)).toBe(before);
    noPackets(Clients);
  }
  Players[1]!.m_nSessionSerialNo++;
  expect(() => send(room, Clients[0]!, event(0x21))).toThrow("generation");
  expect(snapshot(room)).toBe(before);
  Players[1]!.m_nSessionSerialNo--;
  Players[1]!.SetFree();
  expect(() => send(room, Clients[0]!, event(0x20))).toThrow("sender");
  expect(snapshot(room)).toBe(before);
  room.m_bPlaying = false;
  before = snapshot(room);
  expect(() => send(room, Clients[1]!, new CSendPacket(162))).toThrow(
    "running",
  );
  expect(snapshot(room)).toBe(before);
  noPackets(Clients);
});

test("a fabricated Running flag without launch statistics is not sufficient for event 146", () => {
  const { room, Clients } = game();
  room.m_bPlaying = true;
  room.m_nGameState = GameStage.Running;
  const before = snapshot(room);
  expect(() => send(room, Clients[0]!, event(0x21))).toThrow("statistics");
  expect(snapshot(room)).toBe(before);
  noPackets(Clients);
});

test("preparing statistics does not unlock a valid network request-start", () => {
  const { room, Clients } = game(vectors.Rooms[3]!.Players);
  room.SetChiefSlotidx(0);
  room.m_nMapIdx = 200;
  room.m_rgSlotInfo[1]![0] = SlotStateMask.Ready;
  expect(room.CanStartGame()).toBe(0);
  room.PrepareRoundStatistics();
  const before = snapshot(room);
  expect(() => send(room, Clients[0]!, new CSendPacket(106))).toThrow(
    "no fabricated start success",
  );
  expect(snapshot(room)).toBe(before);
  noPackets(Clients);
});

test("PE anchors prove authencode byte access, no-authority stub and surprising end-force branch", () => {
  const gs = new CPeImage(OFFICIAL_SERVICES.FXGS);
  expect(gs.read(0x408148, 10).toString("hex")).toBe("8a4424048881d4070000");
  expect(gs.read(0x408e22, 6).toString("hex")).toBe("8a81d4070000");
  expect(gs.read(0x41688a, 5).toString("hex")).toBe("33c0c20400");
  expect(gs.read(0x41d347, 15).toString("hex")).toBe(
    "833900740580380574058038067507",
  );
  const u = new CUser(UserInfo("AuthByte"), 1);
  u.SetAuthenCode(-1);
  expect(u.GetAuthencode()).toBe(255);
});
