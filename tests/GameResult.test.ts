import { afterEach, expect, test } from "bun:test";
import vectors from "./fixtures/game-result-vectors.json";
import { CFastFile } from "../Common/CFastFile.ts";
import { CTextCodec } from "../Common/CTextCodec.ts";
import { CUser } from "../Common/CUser.ts";
import { CDBSession } from "../Common/DB/CDBSession.ts";
import { CDBMan } from "../FXGS/CDBMan.ts";
import { CGameClock } from "../FXGS/CGameClock.ts";
import { CGameSession } from "../FXGS/CGameSession.ts";
import { CBomberAttr } from "../FXGS/CBomberAttr.ts";
import { CGameMapTmplList } from "../FXGS/CGameMapTmplList.ts";
import { CPeImage, OFFICIAL_SERVICES } from "../Tools/OfficialSource.ts";
import {
  ChannelType,
  DynInfoLayout,
  GameResultRule,
  SessionLimit,
} from "../Common/OfficialValues.ts";
import { g_nLevel2ExpTable } from "../Common/Protocol/OfficialTables.ts";
import { MemoryClient, Received } from "./helpers/Clients.ts";
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
const normal = vectors.Cases.find((row) => row.Name === "normal-w0-t45001")!;
type ResultCase = (typeof vectors.Cases)[number];

/** Trusted static-kernel injection ONLY, never reachable from network handlers. */
function game(row: ResultCase = normal, prepare = true, channel?: number) {
  let now = 0xfffffff0;
  const clock = new CGameClock(() => now);
  const room = new CGameSession(
    17,
    91,
    "Result kernel",
    "",
    0,
    new CTextCodec(),
    bombers,
    maps,
    channel ?? (row.PremiumChannel ? ChannelType.Premium : ChannelType.Normal),
    clock,
  );
  const clients = new Map<number, MemoryClient>();
  for (let slot = 0; slot < 8; slot++) {
    const spec = row.Players[slot];
    if (!spec) continue;
    let client = clients.get(spec.Socket);
    if (!client) {
      client = new MemoryClient();
      clients.set(spec.Socket, client);
      sockets.push(client);
    }
    const info = Object.assign(UserInfo(`Result${slot}`), spec.State.Dynamic, {
      Exp: g_nLevel2ExpTable[spec.Level - 1]!,
    });
    const user = new CUser(info, spec.GlobalSerialNo);
    if (spec.State.DynamicModified) user.IncDecExp(0);
    user.SetSimpleInfoModified(spec.State.SimpleInfoModified);
    user.SetAuthenCode(spec.Authencode);
    user.SetFakeLevel(spec.State.FakeLevel);
    user.SetLevelIcon(spec.State.LevelIconEnabled, spec.State.LevelIconSN);
    for (let i = 0; i < spec.State.GamesSinceFlush; i++) user.IncGame();
    // Intentionally preserve stale cache in the dedicated native cache probes.
    info.Exp = spec.State.Dynamic.Exp;
    user.m_pClientSocket = client;
    client.m_aUser.push(user);
    user.m_nSlotIdx = slot;
    user.m_nSessionIdx = room.m_nIdx;
    user.m_nSessionSerialNo = room.m_ulSerialNo;
    room.m_rgPlayer[slot] = user;
    room.m_rgSlotInfo[slot]![2] = spec.Color;
    expect(user.GetDynamicInfoSnapshot()).toEqual(spec.State);
  }
  if (prepare) {
    room.PrepareRoundStatistics();
    room.m_dynInfoCalculator.SetHasPremium(row.CalculatorPremium);
    for (let slot = 0; slot < 8; slot++) {
      for (let i = 0; i < row.KillCounts[slot]!; i++)
        room.m_dynInfoCalculator.SetKillerIndex(0, slot);
      for (let victim = 0; victim < row.SaveCounts[slot]!; victim++)
        room.m_dynInfoCalculator.SetSaverIndex(victim, slot);
    }
  }
  for (let slot = 0; slot < 8; slot++) {
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
    clients: [...clients.values()],
    time: (value: number) => {
      now = value;
    },
  };
}
function state(room: CGameSession, clock: CGameClock) {
  return {
    Users: room.m_rgPlayer.map((p) =>
      p
        ? { Info: { ...p.m_userInfo }, Snapshot: p.GetDynamicInfoSnapshot() }
        : null,
    ),
    Calculator: room.m_dynInfoCalculator.GetStateBytes().toString("hex"),
    Slots: room.m_rgSlotInfo.map((slot) => Buffer.from(slot).toString("hex")),
    States: [...room.m_aPlayerState],
    Attempts: [...room.m_aShopItemAttempted],
    Stage: room.m_nGameState,
    Playing: room.m_bPlaying,
    Start: clock.GetStartGameTime(),
    End: clock.GetEndGameTime(),
  };
}

for (const row of vectors.Cases) {
  test(`result163 independent manual C++ vector: ${row.Name}`, () => {
    const { room, clock, clients } = game(row);
    const before = state(room, clock);
    const preview = room.MakeGameResultPreview(row.WinningColor, row.Duration);
    const expected = row.Expected;
    expect(preview.WinningColor).toBe(row.WinningColor);
    expect(preview.ElapsedMilliseconds).toBe(row.Duration);
    expect(preview.ExperienceScale).toBe(expected.ExperienceScale);
    expect(preview.HasLapOrHouseState).toBe(expected.HasLapOrHouseState);
    expect(preview.DifferentColorShopItemAttempted).toBe(
      expected.DifferentColorShopItemAttempted,
    );
    expect(preview.Players.map((player) => player ?? null)).toEqual(
      expected.Players,
    );
    expect(preview.RankUpdateSlots).toEqual(expected.RankUpdateSlots);
    expect(
      preview.CalculatorAfterBytes.readInt32LE(DynInfoLayout.HasPremium * 4),
    ).toBe(expected.CalculatorPremiumAfter);
    expect(preview.Packet.GetBuffer().toString("hex")).toBe(expected.Packet);
    const present = preview.Players.filter(Boolean).length;
    expect(preview.Packet.GetBuffer().length).toBe(14 + 15 * present);
    const decoded = Received(preview.Packet);
    expect(decoded.Decode1()).toBe(163);
    expect(decoded.Decode1()).toBe(expected.HasLapOrHouseState ? 1 : 0);
    expect(decoded.Decode1()).toBe(row.WinningColor & 0xff);
    expect(decoded.Decode1()).toBe(0); // ordinary strategy result view
    expect(decoded.Decode1()).toBe(0); // IsLadderGame, not GetExtraPlayerNo
    expect(decoded.Decode1()).toBe(
      expected.DifferentColorShopItemAttempted ? 1 : 0,
    );
    for (const player of preview.Players) {
      expect(decoded.Decode1()).toBe(player ? 1 : 0);
      if (!player) continue;
      expect(decoded.Decode4()).toBe(player.GlobalSerialNo);
      expect(decoded.Decode1()).toBe(player.Category);
      expect(decoded.Decode1()).toBe(player.KillCount & 0xff);
      expect(decoded.Decode1()).toBe(player.SaveCount & 0xff);
      expect(decoded.Decode2()).toBe(player.OldPercentage & 0xffff);
      expect(decoded.Decode2()).toBe(player.NewPercentage & 0xffff);
      expect(decoded.Decode2()).toBe(player.LookLevel);
      expect(decoded.Decode1()).toBe(player.LevelUp ? 1 : 0);
      expect(decoded.Decode1()).toBe(player.Detail);
      expect(player.After.Dynamic.Money).toBe(player.Before.Dynamic.Money);
      expect(player.After.GamesSinceFlush).toBe(player.Before.GamesSinceFlush);
    }
    expect(decoded.remaining).toBe(0); // NO extra money or XP amount field
    expect(state(room, clock)).toEqual(before);
    expect(clients.every((client) => client.packets.length === 0)).toBe(true);
  });
}

test("result scale/bonus values and ordinary virtuals match read-only PE bytes", () => {
  const pe = new CPeImage(OFFICIAL_SERVICES.FXGS);
  const encoded = Buffer.alloc(4);
  encoded.writeFloatLE(GameResultRule.DurationRampReciprocal);
  expect(encoded.equals(pe.read(0x0048f5e0, 4))).toBe(true);
  expect(pe.read(0x0048f5d0, 8).readDoubleLE()).toBe(
    GameResultRule.OpposingShopItemWinMultiplier,
  );
  expect(pe.read(0x0048f5c8, 8).readDoubleLE()).toBe(
    GameResultRule.PremiumTeammateWinBonus,
  );
  expect(pe.read(0x004209a6, 3).toString("hex")).toBe("33c0c3");
  expect(pe.read(0x004216cf, 3).toString("hex")).toBe("33c0c3");
  // Room vtable +156 and strategy +44 point to those exact base methods.
  expect(pe.read(0x0048f60c + 156, 4).readUInt32LE()).toBe(0x004209a6);
  expect(pe.read(0x0048f7d4 + 44, 4).readUInt32LE()).toBe(0x004216cf);
});
test("preview defaults to unsigned elapsed clock across wrap, never stops it", () => {
  const { room, clock, time } = game();
  clock.StartGame();
  time(0x20);
  const before = state(room, clock);
  expect(room.MakeGameResultPreview(0).ElapsedMilliseconds).toBe(48);
  expect(state(room, clock)).toEqual(before);
});
test("preview snapshots, calculator bytes and mutable packet never alias live state", () => {
  const { room, clock } = game();
  const before = state(room, clock);
  const result = room.MakeGameResultPreview(0, 45001);
  expect(() => {
    (result.Players[0]!.After.Dynamic as { Exp: number }).Exp = 7;
  }).toThrow();
  expect(() => {
    (result.Players as unknown[]).pop();
  }).toThrow();
  result.CalculatorAfterBytes.fill(0);
  result.Packet.Encode1(123);
  expect(state(room, clock)).toEqual(before);
  expect(
    room.MakeGameResultPreview(0, 45001).Packet.GetBuffer().toString("hex"),
  ).toBe(normal.Expected.Packet);
});
test("bad winner/duration, unprepared statistics and guild plugin fail without side effects", () => {
  const { room, clock, clients } = game();
  const before = state(room, clock);
  for (const color of [-2, 8, 31, 256, 0.5, NaN])
    expect(() => room.MakeGameResultPreview(color, 45001)).toThrow();
  for (const duration of [-1, 0.5, NaN, Infinity, 0x100000000])
    expect(() => room.MakeGameResultPreview(0, duration)).toThrow();
  expect(state(room, clock)).toEqual(before);
  expect(clients.every((client) => !client.packets.length)).toBe(true);
  const fresh = game(normal, false);
  expect(() => fresh.room.MakeGameResultPreview(0, 45001)).toThrow("prepared");
  const guild = game(normal, true, ChannelType.Guild);
  expect(() => guild.room.MakeGameResultPreview(0, 45001)).toThrow("guild");
});
test("a valid replacement user cannot inherit the launch occupant's statistics", () => {
  const { room, clock } = game();
  const old = room.m_rgPlayer[0]!,
    client = old.m_pClientSocket!;
  const replacement = new CUser(UserInfo("Replacement"), 888);
  replacement.m_pClientSocket = client;
  replacement.m_nSlotIdx = old.m_nSlotIdx;
  replacement.m_nSessionIdx = room.m_nIdx;
  replacement.m_nSessionSerialNo = room.m_ulSerialNo;
  client.m_aUser[0] = replacement;
  room.m_rgPlayer[0] = replacement;
  const before = state(room, clock);
  expect(() => room.MakeGameResultPreview(0, 45001)).toThrow("changed");
  expect(state(room, clock)).toEqual(before);
});
test("closed sockets, free/stale second local user and out-of-range color fail atomically", () => {
  const closed = game();
  closed.clients.at(-1)!.Close();
  expect(() => closed.room.MakeGameResultPreview(0, 45001)).toThrow("closed");
  const stale = game();
  stale.room.m_rgPlayer[1]!.m_nSessionSerialNo++;
  const beforeStale = state(stale.room, stale.clock);
  expect(() => stale.room.MakeGameResultPreview(0, 45001)).toThrow();
  expect(state(stale.room, stale.clock)).toEqual(beforeStale);
  const freed = game();
  freed.room.m_rgPlayer[1]!.SetFree();
  expect(() => freed.room.MakeGameResultPreview(0, 45001)).toThrow();
  const badColor = game();
  badColor.room.m_rgSlotInfo[0]![2] = 31;
  const beforeColor = state(badColor.room, badColor.clock);
  expect(() => badColor.room.MakeGameResultPreview(0, 45001)).toThrow("color");
  expect(state(badColor.room, badColor.clock)).toEqual(beforeColor);
});

test("bonus uses cached winner colors, but requires the recipient's own cached team size >=2", () => {
  const row = vectors.Cases.find(
    (r) => r.Name === "current-versus-cached-colors",
  )!;
  const env = game(row),
    preview = env.room.MakeGameResultPreview(0, row.Duration);
  expect(
    row.Players.filter(
      (p, slot) => p?.Authencode === 1 && row.CurrentColors[slot] === 0,
    ).length,
  ).toBe(1);
  expect(preview.Players[4]!.WinMultiplier).toBe(1.05 + 0.1); // two CACHED winner-color auth1 players
  const solo = vectors.Cases.find(
    (r) => r.Name === "solo-launch-team-has-no-premium-cohort-bonus",
  )!;
  const other = game(solo).room.MakeGameResultPreview(0, solo.Duration);
  expect(other.Players[0]!.WinMultiplier).toBe(1.05 + 0.1);
  expect(other.Players[2]!.WinMultiplier).toBe(1.05); // current winner, cached singleton
});
test("empty special-state byte affects prefix, empty shop flag does NOT affect the win multiplier", () => {
  const row = vectors.Cases.find((r) => r.Name === "empty-shop-and-lap-state")!;
  const preview = game(row).room.MakeGameResultPreview(0, row.Duration);
  expect(row.CurrentColors[7]).toBe(7);
  expect(row.ShopAttempts[7]).toBe(1);
  expect(preview.HasLapOrHouseState).toBe(true);
  expect(preview.DifferentColorShopItemAttempted).toBe(false);
  expect(preview.Players[0]!.WinMultiplier).toBe(1 + 0.1);
});
test("zero XP still increments valid WDL, preserves detail1/2, but clears detail3", () => {
  const preview = game().room.MakeGameResultPreview(0, 15000);
  const first = preview.Players[0]!,
    second = preview.Players[1]!,
    loser = preview.Players[3]!;
  expect(first.ExperienceDelta).toBe(0);
  expect(first.LevelUp).toBe(false);
  expect(first.Detail).toBe(2);
  expect(first.After.Dynamic.Win).toBe(first.Before.Dynamic.Win + 1);
  expect(second.Detail).toBe(0);
  expect(loser.ExperienceDelta).toBe(0);
  expect(loser.After.Dynamic.Lose).toBe(loser.Before.Dynamic.Lose + 1);
  expect(
    preview.Players.every(
      (p) => !p || p.After.Dynamic.Money === p.Before.Dynamic.Money,
    ),
  ).toBe(true);
});
test("explicit SQLite consumer can persist the preview atomically without pretending to finish a live round", async () => {
  const env = game(),
    before = state(env.room, env.clock),
    session = new CDBSession(":memory:"),
    db = new CDBMan(session);
  try {
    for (const user of env.room.m_rgPlayer) {
      if (!user) continue;
      await db.RegisterNewUser({ ID: user.GetName(), Password: "test" });
      const d = user.GetDynamicInfoSnapshot().Dynamic;
      db.UpdateUserDynamic(d.ID, d.Money, d.Exp, d.Win, d.Draw, d.Lose);
    }
    const preview = env.room.MakeGameResultPreview(0, 45001);
    for (const p of preview.Players)
      if (p)
        expect(db.GetUserInfo(p.Before.Dynamic.ID)!.Exp).toBe(
          p.Before.Dynamic.Exp,
        );
    const changes = preview.Players.flatMap((p) =>
      p ? [{ Before: p.Before.Dynamic, After: p.After.Dynamic }] : [],
    );
    expect(db.UpdateUserDynamicBatch(changes)).toBe(true);
    for (const p of preview.Players) {
      if (!p) continue;
      const info = db.GetUserInfo(p.After.Dynamic.ID)!;
      expect([info.Money, info.Exp, info.Win, info.Draw, info.Lose]).toEqual([
        p.After.Dynamic.Money,
        p.After.Dynamic.Exp,
        p.After.Dynamic.Win,
        p.After.Dynamic.Draw,
        p.After.Dynamic.Lose,
      ]);
    }
    expect(db.UpdateUserDynamicBatch(changes)).toBe(false);
    expect(state(env.room, env.clock)).toEqual(before); // no live memory, timer, phase, rank or packet commit
    expect(env.clients.every((client) => !client.packets.length)).toBe(true);
    session.IntegrityCheck();
  } finally {
    session.Close();
  }
});
