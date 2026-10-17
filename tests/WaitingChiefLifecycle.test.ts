import { afterEach, expect, test } from "bun:test";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CTextCodec } from "../Common/CTextCodec.ts";
import { CUser } from "../Common/CUser.ts";
import { CUser as CenterUser } from "../Center/CUser.ts";
import {
  BanChiefRule,
  ChannelType,
  GameType,
  SessionLimit,
} from "../Common/OfficialValues.ts";
import { ClientRequest } from "../Common/Protocol/PacketTypes.ts";
import { CGameSession } from "../FXGS/CGameSession.ts";
import type { GameSessionRemovalServices } from "../FXGS/CGameSession.ts";
import {
  ChiefNotices,
  ChiefSQLState,
  WaitingChiefFixture,
} from "./helpers/WaitingChief.ts";
import { MemoryClient, Received } from "./helpers/Clients.ts";
import { NativeInventory } from "./helpers/UserInventory.ts";
import { UserInfo } from "./helpers/Accounts.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function create(options: Parameters<typeof WaitingChiefFixture>[0] = {}) {
  const e = WaitingChiefFixture(options);
  cleanup.push(e.close);
  return e;
}
function stock(e: ReturnType<typeof create>) {
  return e.clients
    .flatMap((s) => s.m_aUser)
    .map((u) => ({
      Dynamic: u.GetDynamicInfoSnapshot(),
      Pair: u.CaptureUserInventoryInitialization(),
    }));
}
function normalWarn(e: ReturnType<typeof create>) {
  e.tick(100);
  expect(e.room.m_banChief.IsCanStart()).toBe(true);
  e.tick(10100);
  expect(e.clients.every((s) => ChiefNotices(s).length === 0)).toBe(true);
  e.tick(10101);
  expect(e.clients.every((s) => ChiefNotices(s).length === 1)).toBe(true);
  e.clear();
}

test("ACTUAL table scheduling: native waiting room has no round/UDP requirement; ready timeout warns ALL sockets once, then121/2 removes WHOLE chief pair without195 or finance", () => {
  const e = create({ Counts: [2, 1], Capacity: 3 }),
    users = e.clients.flatMap((s) => s.m_aUser),
    initial = stock(e),
    sql = ChiefSQLState(e.session),
    launch = e.room.GetGameLaunchState();
  expect(e.table.GetWaitingChiefSessionCount()).toBe(1);
  expect(e.table.GetScheduledRoundCount()).toBe(0);
  expect(e.room.HasScheduledGame()).toBe(true);
  e.tick(100);
  expect(e.room.m_banChief.IsCanStart()).toBe(true);
  e.tick(10100);
  expect(e.clients.every((s) => ChiefNotices(s).length === 0)).toBe(true);
  e.tick(10101);
  for (const p of e.clients)
    expect(ChiefNotices(p)).toEqual([
      { Reason: 0, Seconds: 10, Hex: "235aa563" },
    ]);
  e.clear();
  e.tick(20101);
  expect(e.clients.every((s) => ChiefNotices(s).length === 0)).toBe(true);
  const chief = e.clients[0]!,
    survivor = e.clients[1]!;
  const send = chief.SendPacket.bind(chief);
  let beforeRemoval = false;
  chief.SendPacket = (packet) => {
    if (packet.m_nPacketType === 121) {
      beforeRemoval = true;
      expect(e.room.GetCurPlayer()).toBe(3);
      expect(chief.m_nPoolType).toBe("Session");
      expect(
        chief.m_aUser.every((u) => u.GetSessionIdx() === e.room.m_nIdx),
      ).toBe(true);
    }
    send(packet);
  };
  e.tick(20102);
  expect(beforeRemoval).toBe(true);
  expect(ChiefNotices(chief)).toEqual([
    { Reason: 2, Seconds: 10, Hex: "2358a563" },
  ]);
  expect(ChiefNotices(survivor)).toEqual([]);
  expect(
    e.clients
      .flatMap((s) => s.packets)
      .some((p) => [15, 195].includes(p.m_nPacketType)),
  ).toBe(false);
  expect(chief.m_aUser).toEqual(users.slice(0, 2));
  expect(
    chief.m_aUser.every(
      (u) =>
        u.GetSessionIdx() === SessionLimit.NoSession &&
        u.GetSessionSerialNo() === 0xffffffff &&
        u.m_nSlotIdx === -1 &&
        u.IsSetFree() === 0,
    ),
  ).toBe(true);
  expect(chief.m_nPoolType).toBe("SessionRemoved");
  expect(chief.IsConnected()).toBe(true);
  expect(e.room.GetCurPlayer()).toBe(1);
  expect(e.room.IsChief(survivor)).toBe(true);
  expect(e.room.m_banChief.IsCanStart()).toBe(false);
  expect(e.room.m_banChief.IsWarnedBan()).toBe(false);
  expect(e.table.GetSession(chief)).toBeUndefined();
  expect(e.table.GetSession(survivor)).toBe(e.room);
  expect(e.room.GetGameLaunchState()).toEqual(launch);
  expect(e.room.GetResultRoundID()).toBeUndefined();
  expect(stock(e)).toEqual(initial);
  expect(ChiefSQLState(e.session)).toEqual(sql);
  expect(sql.Receipts).toEqual([0, 0, 0, 0]);
  expect(e.rank).toEqual([]);
  expect(e.table.GetUpdateFailures()).toEqual([]);
  e.clear();
  e.tick(20103);
  expect(ChiefNotices(chief)).toEqual([]);
});

test("non-full room waits20s, not10s; CURRENT full-room changes affect the ready gate but never fabricate a new warning/financial grant", () => {
  const e = create();
  e.tick(100);
  e.tick(10101);
  expect(e.clients.every((s) => ChiefNotices(s).length === 0)).toBe(true);
  e.tick(20100);
  expect(ChiefNotices(e.clients[0]!)).toEqual([]);
  e.tick(20101);
  expect(ChiefNotices(e.clients[0]!).map((n) => n.Reason)).toEqual([0]);
});

test("MANNER uses odd CAPACITY3 with EVEN player count2; native121/1 then121/3 are independent of readiness", () => {
  const e = create({ Manner: 1, Capacity: 3 });
  e.table.OnPacket(
    Received(new CSendPacket(ClientRequest.SetPlayerReady).Encode1(0)),
    e.clients[1]!,
  );
  e.clear();
  expect(e.room.GetCurPlayer()).toBe(2);
  expect(e.room.m_nMaxPlayer).toBe(3);
  e.tick(100);
  expect(e.room.m_banChief.IsOddSlot()).toBe(true);
  e.tick(5100);
  expect(ChiefNotices(e.clients[0]!)).toEqual([]);
  e.tick(5101);
  for (const p of e.clients)
    expect(ChiefNotices(p)).toEqual([
      { Reason: 1, Seconds: 10, Hex: "235ba563" },
    ]);
  e.clear();
  e.tick(15101);
  expect(ChiefNotices(e.clients[0]!)).toEqual([]);
  e.tick(15102);
  expect(ChiefNotices(e.clients[0]!).map((n) => n.Reason)).toEqual([3]);
  expect(e.clients[0]!.m_nPoolType).toBe("SessionRemoved");
  expect(e.room.GetCurPlayer()).toBe(1);
});

test("MANNER even CAPACITY4 with ODD live count3 never starts odd warning; non-manner three-player capacity3 never uses parity", () => {
  for (const Manner of [0, 1]) {
    const e = create({ Counts: [2, 1], Manner, Capacity: Manner ? 4 : 3 });
    e.tick(100);
    e.tick(5101);
    expect(e.room.m_banChief.IsOddSlot()).toBe(false);
    expect(e.clients.every((s) => ChiefNotices(s).length === 0)).toBe(true);
  }
});

test("non-manner single-slot capacity1 DOES use odd warning; default capacity8 with just one occupant does NOT", () => {
  for (const Capacity of [1, 8]) {
    const e = create({ Counts: [1], Capacity });
    e.tick(100);
    e.tick(5101);
    expect(ChiefNotices(e.clients[0]!).map((n) => n.Reason)).toEqual(
      Capacity === 1 ? [1] : [],
    );
  }
});

test("trusted native SuperChief Amount0/Slot255/past raw DATE still triples ready30s and warning30s; query/expiration/dirty/epochs/SQL are untouched", () => {
  const e = create({ Counts: [2, 1], Capacity: 3, SuperChief: true }),
    initial = stock(e),
    sql = ChiefSQLState(e.session);
  e.tick(100);
  e.tick(10101);
  e.tick(30100);
  expect(e.clients.every((s) => ChiefNotices(s).length === 0)).toBe(true);
  e.tick(30101);
  for (const s of e.clients)
    expect(ChiefNotices(s)).toEqual([
      { Reason: 0, Seconds: 30, Hex: "235aa577" },
    ]);
  e.clear();
  e.tick(60101);
  expect(ChiefNotices(e.clients[0]!)).toEqual([]);
  e.tick(60102);
  expect(ChiefNotices(e.clients[0]!)).toEqual([
    { Reason: 2, Seconds: 30, Hex: "2358a577" },
  ]);
  expect(stock(e)).toEqual(initial);
  expect(ChiefSQLState(e.session)).toEqual(sql);
});

test("native SuperChief triples ODD delay to15s AND warning to30s; Category/encoded exact attr matter, legacy ItemID/Verbose never substitute", () => {
  const e = create({ Manner: 1, Capacity: 3, SuperChief: true });
  e.tick(100);
  e.tick(5101);
  e.tick(15100);
  expect(ChiefNotices(e.clients[0]!)).toEqual([]);
  e.tick(15101);
  expect(ChiefNotices(e.clients[0]!)[0]!.Seconds).toBe(30);
  e.clear();
  e.tick(45101);
  expect(ChiefNotices(e.clients[0]!)).toEqual([]);
  e.tick(45102);
  expect(ChiefNotices(e.clients[0]!)[0]!.Reason).toBe(3);
  for (const extra of [
    { Category: 1 },
    { strAttr: "item/SuperChief" },
    { strAttr: "Item/SuperChiefX" },
  ]) {
    const f = create({ Counts: [2, 1], Capacity: 3 });
    f.clients[0]!.m_aUser[0]!.InstallUserInventory([
      NativeInventory({ strAttr: BanChiefRule.SuperChiefAttribute, ...extra }),
    ]);
    f.tick(100);
    f.tick(10101);
    expect(ChiefNotices(f.clients[0]!)[0]!.Seconds).toBe(10);
  }
  const f = create({ Counts: [2, 1], Capacity: 3 });
  f.clients[0]!.m_aUser[0]!.m_aInventory = [
    {
      SN: 7,
      ID: "legacy",
      ItemID: 7,
      Slot: 255,
      Amount: 3,
      ExpireDate: 0,
      CreatedAt: 0,
      Verbose: "Item/SuperChief",
    },
  ];
  f.tick(100);
  f.tick(10101);
  expect(ChiefNotices(f.clients[0]!)[0]!.Seconds).toBe(10);
});

test("SuperChief is queried on the CURRENT CHIEF LOCAL, not socket primary or another user's row; entire pair still leaves", () => {
  const e = create({ Counts: [2, 1], Capacity: 3 }),
    pair = e.clients[0]!.m_aUser;
  pair[1]!.InstallUserInventory([
    NativeInventory({ strAttr: BanChiefRule.SuperChiefAttribute }),
  ]);
  e.room.SetChiefSlotidx(pair[1]!.m_nSlotIdx); // trusted native chief-selection helper, not a new client command
  e.tick(100);
  e.tick(10101);
  expect(ChiefNotices(e.clients[0]!)).toEqual([]);
  e.tick(30101);
  expect(ChiefNotices(e.clients[0]!)[0]!.Seconds).toBe(30);
  e.clear();
  e.tick(60102);
  expect(pair.every((u) => u.GetSessionIdx() === SessionLimit.NoSession)).toBe(
    true,
  );
  expect(e.room.GetCurPlayer()).toBe(1);
});

test("CURRENT functional query can change the announced delay's later expiry; removing a row is an explicit trusted install, never consumption or automatic SQL reload", () => {
  const e = create({ Counts: [2, 1], Capacity: 3, SuperChief: true });
  e.tick(100);
  e.tick(30101);
  expect(ChiefNotices(e.clients[0]!)[0]!.Seconds).toBe(30);
  e.clear();
  const u = e.clients[0]!.m_aUser[0]!,
    previous = u.GetUserInventoryGeneration().Revision;
  u.InstallUserInventory([]);
  expect(u.GetUserInventoryGeneration().Revision).toBe(previous + 1);
  e.tick(40102);
  expect(ChiefNotices(e.clients[0]!)).toEqual([
    { Reason: 2, Seconds: 10, Hex: "2358a563" },
  ]);
});

test("actual readiness loss resets normal warning; reopened even capacity clears odd warning; a fresh valid interval is required", () => {
  const e = create({ Capacity: 2 });
  normalWarn(e);
  e.table.OnPacket(Received(new CSendPacket(96).Encode1(0)), e.clients[1]!);
  e.clear();
  e.tick(20102);
  expect(e.room.m_banChief.IsCanStart()).toBe(false);
  expect(e.room.m_banChief.IsWarnedBan()).toBe(false);
  expect(e.room.GetCurPlayer()).toBe(2);
  expect(ChiefNotices(e.clients[0]!)).toEqual([]);
  e.table.OnPacket(Received(new CSendPacket(96).Encode1(1)), e.clients[1]!);
  e.clear();
  e.tick(20103);
  e.tick(30103);
  expect(ChiefNotices(e.clients[0]!)).toEqual([]);
  e.tick(30104);
  expect(ChiefNotices(e.clients[0]!)[0]!.Reason).toBe(0);
  const f = create({ Manner: 1, Capacity: 3 });
  f.tick(100);
  f.tick(5101);
  f.clear();
  f.table.OnPacket(
    Received(new CSendPacket(100).Encode1(3 << 4)),
    f.clients[0]!,
  );
  f.clear();
  f.tick(15102);
  expect(f.room.m_nMaxPlayer).toBe(4);
  expect(f.room.m_banChief.IsOddSlot()).toBe(false);
  expect(f.room.m_banChief.IsWarnedBanOddSlot()).toBe(false);
  expect(f.room.GetCurPlayer()).toBe(2);
  expect(ChiefNotices(f.clients[0]!)).toEqual([]);
});

test("native zero HasAuthority means SQLite Authority22/all-bits grants NO exemption; normal non-Guild channel variants retain the same policy", () => {
  for (const channel of [
    ChannelType.Normal,
    ChannelType.Beginner,
    ChannelType.Premium,
    ChannelType.Expert,
  ]) {
    const e = create({ Capacity: 2, ChannelType: channel });
    e.clients[0]!.m_aUser[0]!.m_userInfo.Authority = channel % 2 ? 22 : -1;
    e.tick(100);
    e.tick(10101);
    expect(ChiefNotices(e.clients[0]!)[0]!.Reason).toBe(0);
  }
});

test("waiting CanStart uses native PLAYING map -1, not waiting-selected200; no launch/result/clock/timer/financial state is fabricated", () => {
  const e = create({ Capacity: 2 }),
    before = e.room.GetGameLaunchState(),
    raw = e.clock.GetStateSnapshot();
  expect(e.room.m_nMapIdx).toBe(200);
  expect(e.room.m_nMapIdxPlaying).toBe(-1);
  const old = e.room.CanStartGame.bind(e.room);
  const maps: (number | undefined)[] = [];
  e.room.CanStartGame = (allow, map) => {
    maps.push(map);
    return old(allow, map);
  };
  e.tick(100);
  e.tick(10101);
  expect(maps).toEqual([-1, -1]);
  expect(e.room.GetGameLaunchState()).toEqual(before);
  expect(e.clock.GetStateSnapshot()).toEqual(raw);
  expect(e.room.m_bPlaying).toBe(false);
  expect(e.room.GetResultRoundID()).toBeUndefined();
  expect(e.table.GetScheduledRoundCount()).toBe(0);
});

test("malformed SECOND local ownership cannot warn or partly eject; table records a sanitized protocol failure, then valid repair reuses no financial capability", () => {
  const e = create({ Counts: [2, 1], Capacity: 3 });
  e.tick(100);
  const second = e.clients[0]!.m_aUser[1]!,
    serial = second.m_nSessionSerialNo,
    before = e.room.m_banChief.CaptureSnapshot(),
    sql = ChiefSQLState(e.session);
  second.m_nSessionSerialNo ^= 1;
  e.tick(10101);
  expect(e.room.m_banChief.CaptureSnapshot()).toEqual(before);
  expect(e.clients.every((s) => s.packets.length === 0)).toBe(true);
  expect(e.room.GetCurPlayer()).toBe(3);
  expect(e.table.GetUpdateFailures()[0]!.Code).toBe("protocol-error");
  expect(Object.keys(e.table.GetUpdateFailures()[0]!).sort()).toEqual([
    "Code",
    "ConsecutiveFailures",
    "SessionIndex",
    "SessionSerialNo",
  ]);
  second.m_nSessionSerialNo = serial;
  e.tick(10101);
  expect(ChiefNotices(e.clients[0]!)[0]!.Reason).toBe(0);
  expect(e.table.GetUpdateFailures()).toEqual([]);
  expect(ChiefSQLState(e.session)).toEqual(sql);
});

test("a same-value SECOND local pre reinstall INSIDE native functional codec fails before clock/helper/packet publication; changed external generation is NOT rolled back", () => {
  const e = create({ Counts: [2, 1], Capacity: 3 }),
    first = e.clients[0]!.m_aUser[0]!,
    second = e.clients[0]!.m_aUser[1]!;
  let armed = false,
    clockReads = 0;
  const codec = new CTextCodec(),
    encode = codec.Encode.bind(codec),
    clock = e.clock.GetCurrentTime.bind(e.clock);
  codec.Encode = (text) => {
    if (armed) {
      armed = false;
      second.InstallPreInventory([]);
    }
    return encode(text);
  };
  first.InstallUserInventory(
    [NativeInventory({ strAttr: BanChiefRule.SuperChiefAttribute })],
    {},
    codec,
  );
  second.InstallPreInventory([]);
  const generation = second.GetPreInventoryGeneration(),
    before = e.room.m_banChief.CaptureSnapshot();
  e.clock.GetCurrentTime = () => {
    clockReads++;
    return clock();
  };
  armed = true;
  expect(() => e.room.DeferBanChief()).toThrow("changed");
  expect(second.GetPreInventoryGeneration()).toBe(generation + 1);
  expect(clockReads).toBe(0);
  expect(e.room.m_banChief.CaptureSnapshot()).toEqual(before);
  expect(e.clients.every((s) => !s.packets.length)).toBe(true);
  e.tick(100);
  expect(e.room.m_banChief.IsCanStart()).toBe(true);
});

test("fallible entry/IsBanChief/ordinary Init/final-reset clock reads ALL precede121 and roster consumption, including the last fourth sample", () => {
  for (let failAt = 1; failAt <= 4; failAt++) {
    const e = create({ Counts: [2, 1], Capacity: 3 });
    normalWarn(e);
    const before = e.room.m_banChief.CaptureSnapshot(),
      clock = e.clock.GetCurrentTime.bind(e.clock),
      sql = ChiefSQLState(e.session);
    let reads = 0;
    e.clock.GetCurrentTime = () => {
      if (++reads === failAt) throw new Error("trusted clock fault");
      return clock();
    };
    e.tick(20102);
    expect(reads).toBe(failAt);
    expect(e.room.m_banChief.CaptureSnapshot()).toEqual(before);
    expect(e.clients.every((s) => !s.packets.length)).toBe(true);
    expect(e.room.GetCurPlayer()).toBe(3);
    expect(e.table.GetUpdateFailures()[0]!.Code).toBe("update-error");
    expect(ChiefSQLState(e.session)).toEqual(sql);
    e.clock.GetCurrentTime = clock;
    e.tick(20102);
    expect(e.clients[0]!.m_nPoolType).toBe("SessionRemoved");
    expect(e.table.GetUpdateFailures()).toEqual([]);
  }
});

test("clock callback cannot inject a room packet or a new local group while waiting; direct/table chief removal remain blocked DURING121 send, then exact authorized destruction succeeds", () => {
  // One genuinely free slot is necessary: a FULL room would reject the join
  // before reaching AddAllUser's NEW nonplaying-update guard.
  const e = create({ Counts: [2, 1], Capacity: 4 });
  e.tick(100);
  e.tick(20101);
  expect(ChiefNotices(e.clients[0]!)[0]!.Reason).toBe(0);
  e.clear();
  const newcomer = new MemoryClient(),
    user = new CUser(UserInfo("Newcomer"), 99999);
  cleanup.push(() => newcomer.Close());
  newcomer.m_aUser.push(user);
  user.m_pClientSocket = newcomer;
  const oldClock = e.clock.GetCurrentTime.bind(e.clock);
  let callbacks = 0;
  e.clock.GetCurrentTime = () => {
    callbacks++;
    expect(() => e.room.DeferBanChief()).toThrow("transition");
    expect(() =>
      e.table.DoJoinSession(
        newcomer,
        e.room.m_nIdx,
        e.room.m_ulSerialNo,
        "",
        [0],
      ),
    ).toThrow("update");
    expect(() =>
      e.room.OnPacket(Received(new CSendPacket(96).Encode1(0)), e.clients[1]!),
    ).toThrow("update");
    e.table.UpdateGameSessions();
    e.room.Update();
    return oldClock();
  };
  const chief = e.clients[0]!,
    send = chief.SendPacket.bind(chief);
  let sends = 0;
  chief.SendPacket = (p) => {
    if (p.m_nPacketType === 121) {
      sends++;
      expect(() => e.table.DestroyPlayer(chief)).toThrow(
        "recovery publication",
      );
      expect(() => e.room.DestroyPlayer(chief)).toThrow("round update");
      expect(() =>
        e.table.DoJoinSession(
          newcomer,
          e.room.m_nIdx,
          e.room.m_ulSerialNo,
          "",
          [0],
        ),
      ).toThrow("update");
    }
    send(p);
  };
  e.tick(30102);
  expect(callbacks).toBe(4);
  expect(sends).toBe(1);
  expect(e.room.GetCurPlayer()).toBe(1);
  expect(user.GetSessionIdx()).toBe(SessionLimit.NoSession);
  expect(e.table.GetUpdateFailures()).toEqual([]);
});

test("warning transport failures are counted, not replayed; detached121 bodies cannot be corrupted for the second socket", () => {
  const e = create({ Capacity: 2 });
  e.tick(100);
  e.clients[0]!.SendPacket = (p) => {
    p.GetBuffer().fill(0);
    p.Encode1(255);
    throw new Error("send failed");
  };
  e.tick(10101);
  expect(ChiefNotices(e.clients[1]!)).toEqual([
    { Reason: 0, Seconds: 10, Hex: "235aa563" },
  ]);
  expect(e.room.GetWaitingChiefPublicationFailures()).toBe(1);
  expect(e.table.GetWaitingChiefPublicationFailures()).toBe(1);
  e.clear();
  e.tick(10102);
  expect(e.clients[1]!.packets).toEqual([]);
  expect(e.table.GetUpdateFailures()).toEqual([]);
});

test("chief121 transport failure cannot replay or prevent committed whole-group departure/pool4; it does NOT emit195", () => {
  const e = create({ Counts: [2, 1], Capacity: 3 });
  normalWarn(e);
  e.clients[0]!.SendPacket = () => {
    throw new Error("failed chief121");
  };
  e.tick(20102);
  expect(e.room.GetCurPlayer()).toBe(1);
  expect(e.clients[0]!.m_nPoolType).toBe("SessionRemoved");
  expect(e.table.GetRemovalPublicationFailures().RecoveryNotice).toBe(1);
  expect(e.clients[1]!.packets.some((p) => p.m_nPacketType === 195)).toBe(
    false,
  );
  e.tick(20103);
  expect(e.table.GetRemovalPublicationFailures().RecoveryNotice).toBe(1);
});

test("post121 native same-value reinstall is fenced BEFORE removal; already-attempted notice is NOT rolled back or an exactly-once delivery receipt", () => {
  const e = create({ Counts: [2, 1], Capacity: 3 });
  normalWarn(e);
  const u = e.clients[0]!.m_aUser[1]!,
    chief = e.clients[0]!,
    send = chief.SendPacket.bind(chief);
  u.InstallUserInventory([]);
  const rev = u.GetUserInventoryGeneration().Revision,
    sql = ChiefSQLState(e.session);
  chief.SendPacket = (p) => {
    send(p);
    if (p.m_nPacketType === 121) u.InstallUserInventory([]);
  };
  e.tick(20102);
  expect(ChiefNotices(chief).map((n) => n.Reason)).toEqual([2]);
  expect(u.GetUserInventoryGeneration().Revision).toBe(rev + 1);
  expect(e.room.GetCurPlayer()).toBe(3);
  expect(chief.m_nPoolType).toBe("Session");
  expect(e.table.GetUpdateFailures()[0]!.Code).toBe("protocol-error");
  expect(ChiefSQLState(e.session)).toEqual(sql);
  expect(e.table.IsRemovingPlayer(chief)).toBe(false);
});

test("missing native table hook fails CLOSED at deadline before121/helper reset/group consumption, not an imaginary lobby recovery", () => {
  const e = create({ Counts: [2, 1], Capacity: 3 });
  normalWarn(e);
  const hooks = Reflect.get(
      e.room,
      "removalServices",
    ) as GameSessionRemovalServices,
    eject = hooks.EjectChief,
    before = e.room.m_banChief.CaptureSnapshot();
  Reflect.deleteProperty(hooks, "EjectChief");
  e.tick(20102);
  expect(e.room.m_banChief.CaptureSnapshot()).toEqual(before);
  expect(e.room.GetCurPlayer()).toBe(3);
  expect(e.clients.every((s) => !s.packets.length)).toBe(true);
  expect(e.table.GetUpdateFailures()[0]!.Code).toBe("unported-feature");
  Reflect.set(hooks, "EjectChief", eject);
  e.tick(20102);
  expect(e.clients[0]!.m_nPoolType).toBe("SessionRemoved");
  expect(e.table.GetUpdateFailures()).toEqual([]);
});

test("last chief pair leaves via odd121/3 then table87; recycled room generation cannot receive stale121/86 or mutate the old helper", () => {
  const e = create({ Counts: [2], Manner: 1, Capacity: 3 });
  e.tick(100);
  e.tick(5101);
  e.clear();
  e.tick(15102);
  expect(ChiefNotices(e.clients[0]!)[0]!.Reason).toBe(3);
  expect(e.clients[0]!.m_nPoolType).toBe("SessionRemoved");
  expect(
    e.table.GetBaseSession(e.room.m_nIdx, e.room.m_ulSerialNo),
  ).toBeUndefined();
  expect(e.notices).toEqual([87]);
  const f = create({ Capacity: 2 });
  f.tick(100);
  const before = f.room.m_banChief.CaptureSnapshot(),
    read = f.clock.GetCurrentTime.bind(f.clock);
  const replacement = new CGameSession(
    f.room.m_nIdx,
    f.room.m_ulSerialNo + 1,
    "Replacement",
    "",
    0,
    f.room.text,
    f.room.bombers,
    f.room.maps,
  );
  let armed = true;
  f.clock.GetCurrentTime = () => {
    if (armed) {
      armed = false;
      f.table.m_rgGameSession.set(f.room.m_nIdx, replacement);
    }
    return read();
  };
  f.tick(10101);
  expect(f.room.m_banChief.CaptureSnapshot()).toEqual(before);
  expect(f.clients.every((s) => !s.packets.length)).toBe(true);
  expect(f.notices).toEqual([]);
  expect(
    f.table.GetBaseSession(replacement.m_nIdx, replacement.m_ulSerialNo),
  ).toBe(replacement);
});

test("Guild/Mod/BangPok/vote scopes stay unavailable and unscheduled; active transition guards fail before even reading the injected clock", () => {
  for (const [key, value] of [
    ["channelType", ChannelType.Guild],
    ["m_nGameType", GameType.Mod],
    ["m_bBangPok", true],
    ["m_ulBanTargetSerialNo", 7],
  ] as const) {
    const e = create();
    Reflect.set(e.room, key, value);
    e.clock.GetCurrentTime = () => {
      throw new Error("unexpected clock");
    };
    expect(e.room.IsWaitingChiefScheduled()).toBe(false);
    expect(e.room.HasScheduledGame()).toBe(false);
    expect(() => e.room.DeferBanChief()).toThrow("ordinary normal");
    e.table.UpdateGameSessions();
    expect(e.clients.every((s) => !s.packets.length)).toBe(true);
  }
  for (const key of ["m_bUpdating", "m_bRemovingPlayer", "m_bGameTransition"]) {
    const e = create();
    Reflect.set(e.room, key, true);
    e.clock.GetCurrentTime = () => {
      throw new Error("unexpected clock");
    };
    expect(() => e.room.DeferBanChief()).toThrow("transition");
    Reflect.set(e.room, key, false);
  }
});

test("real Center CUser same-value pending ABA is fenced even when all common fields/native bytes stay identical; epoch is NOT transfer/financial permission", () => {
  const e = create({ Capacity: 2 }),
    peer = e.clients[0]!,
    previous = peer.m_aUser[0]!,
    slot = previous.m_nSlotIdx;
  // Trusted binding fixture, not a bypass registration/network grant API.
  const owner = new CenterUser(
    previous.m_userInfo,
    previous.GetGlobalSerialNo(),
  );
  owner.m_pClientSocket = peer;
  owner.m_nSlotIdx = slot;
  owner.m_nSessionIdx = previous.m_nSessionIdx;
  owner.m_nSessionSerialNo = previous.m_nSessionSerialNo;
  peer.m_aUser[0] = owner;
  e.room.m_rgPlayer[slot] = owner;
  e.tick(100);
  const before = e.room.m_banChief.CaptureSnapshot(),
    generation = owner.GetConnectionGeneration(),
    clock = e.clock.GetCurrentTime.bind(e.clock),
    sql = ChiefSQLState(e.session);
  let armed = true;
  e.clock.GetCurrentTime = () => {
    if (armed) {
      armed = false;
      owner.m_pendingConnection = undefined;
    }
    return clock();
  };
  e.tick(10101);
  expect(owner.m_pendingConnection).toBeUndefined();
  expect(owner.GetConnectionGeneration()).not.toBe(generation);
  expect(e.room.m_banChief.CaptureSnapshot()).toEqual(before);
  expect(e.clients.every((s) => !s.packets.length)).toBe(true);
  expect(e.table.GetUpdateFailures()[0]!.Code).toBe("protocol-error");
  expect(ChiefSQLState(e.session)).toEqual(sql);
});

test("one-shot chief-removal callback expires when service returns, even if retained without consuming; it cannot become a later authority", () => {
  const e = create({ Capacity: 2 });
  normalWarn(e);
  const hooks = Reflect.get(
    e.room,
    "removalServices",
  ) as GameSessionRemovalServices;
  let saved: ((destroy: () => boolean) => boolean) | undefined,
    calls = 0;
  const hold: NonNullable<GameSessionRemovalServices["EjectChief"]> = (
    _room,
    _socket,
    _notice,
    commit,
  ) => {
    saved = commit;
  };
  Reflect.set(hooks, "EjectChief", hold);
  e.tick(20102);
  expect(e.table.GetUpdateFailures()[0]!.Code).toBe("protocol-error");
  expect(e.room.GetCurPlayer()).toBe(2);
  expect(saved).toBeDefined();
  expect(() =>
    saved!(() => {
      calls++;
      return true;
    }),
  ).toThrow("expired");
  expect(calls).toBe(0);
  expect(e.room.GetCurPlayer()).toBe(2);
  expect(e.clients.every((s) => !s.packets.length)).toBe(true);
});

test("trusted chief121 callback closing its TCP stops consumption after the attempted notice; no fake rollback,195,replay or automatic orphan recovery", () => {
  const e = create({ Capacity: 2 });
  normalWarn(e);
  const chief = e.clients[0]!,
    send = chief.SendPacket.bind(chief),
    sql = ChiefSQLState(e.session);
  chief.SendPacket = (p) => {
    send(p);
    if (p.m_nPacketType === 121) chief.Close();
  };
  e.tick(20102);
  expect(ChiefNotices(chief).map((n) => n.Reason)).toEqual([2]);
  expect(chief.IsConnected()).toBe(false);
  expect(e.room.GetCurPlayer()).toBe(2);
  expect(chief.m_nPoolType).toBe("Session");
  expect(e.table.GetUpdateFailures()[0]!.Code).toBe("protocol-error");
  e.tick(99999);
  expect(ChiefNotices(chief).map((n) => n.Reason)).toEqual([2]);
  expect(e.room.GetCurPlayer()).toBe(2);
  expect(ChiefSQLState(e.session)).toEqual(sql);
});

test("native invalid chief index/missing socket short-circuits with NO clock or121, even if a forged non-index array property exists", () => {
  for (const slot of [-2, -1, 8, 1.5]) {
    const e = create();
    e.room.m_nChiefSlotidx = slot;
    Reflect.set(e.room.m_rgPlayer, String(slot), e.clients[0]!.m_aUser[0]);
    const before = e.room.m_banChief.CaptureSnapshot();
    e.clock.GetCurrentTime = () => {
      throw new Error("unreached clock");
    };
    expect(e.room.IsWaitingChiefScheduled()).toBe(false);
    e.room.DeferBanChief();
    expect(e.room.m_banChief.CaptureSnapshot()).toEqual(before);
    expect(e.clients.every((s) => !s.packets.length)).toBe(true);
  }
  const e = create(),
    chief = e.room.m_rgPlayer[e.room.m_nChiefSlotidx]!;
  chief.m_pClientSocket = undefined;
  e.clock.GetCurrentTime = () => {
    throw new Error("unreached clock");
  };
  e.room.DeferBanChief();
  expect(e.clients.every((s) => !s.packets.length)).toBe(true);
});
