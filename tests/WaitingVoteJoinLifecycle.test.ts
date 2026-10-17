import { afterEach, expect, test } from "bun:test";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CUser } from "../Common/CUser.ts";
import { CUser as CenterUser } from "../Center/CUser.ts";
import {
  ChannelType,
  GameType,
  JoinSessionResult,
  SessionLimit,
  SlotStateMask,
} from "../Common/OfficialValues.ts";
import { GameLaunchFixture } from "./helpers/GameLaunch.ts";
import { MemoryClient, Received } from "./helpers/Clients.ts";
import { UserInfo } from "./helpers/Accounts.ts";
import { NativeInventory } from "./helpers/UserInventory.ts";
import { ChiefSQLState } from "./helpers/WaitingChief.ts";
const cleanup: (() => void)[] = [];
let nextSerial = 0xa0000000;
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
function create(counts: readonly number[] = [1, 1, 1, 1]) {
  const e = GameLaunchFixture(counts);
  cleanup.push(e.close);
  return e;
}
function incoming(count = 1, center = false) {
  const p = new MemoryClient();
  cleanup.push(() => p.Close());
  for (let i = 0; i < count; i++) {
    const U = center ? CenterUser : CUser,
      u = new U(UserInfo(`Join${++nextSerial}`), nextSerial);
    u.m_pClientSocket = p;
    p.m_aUser.push(u);
  }
  return p;
}
function start(e: ReturnType<typeof create>, index = 1) {
  const target = e.clients[index]!.m_aUser[0]!.GetGlobalSerialNo();
  e.table.OnPacket(
    Received(new CSendPacket(104).Encode4(target).Encode1(0)),
    e.clients[0]!,
  );
  e.clear();
  return target;
}
function join(
  e: ReturnType<typeof create>,
  p: MemoryClient,
  bombers = p.m_aUser.map(() => 0),
) {
  e.table.DoJoinSession(p, e.room.m_nIdx, e.room.m_ulSerialNo, "", bombers);
}
function reply(
  e: ReturnType<typeof create>,
  p: MemoryClient,
  target: number,
  answer: number,
) {
  e.table.OnPacket(
    Received(new CSendPacket(105).Encode4(target).Encode1(answer)),
    p,
  );
}
function money(
  e: ReturnType<typeof create>,
  peers: readonly MemoryClient[] = [],
) {
  return {
    SQL: ChiefSQLState(e.session),
    Users: [...e.clients, ...peers]
      .flatMap((s) => s.m_aUser)
      .map((u) => ({
        Dynamic: u.GetDynamicInfoSnapshot(),
        Pair: u.CaptureUserInventoryInitialization(),
        Owned: u.GetUserInventoryGeneration(),
        Pre: u.GetPreInventoryGeneration(),
      })),
  };
}
function roomState(e: ReturnType<typeof create>) {
  return {
    Observation: e.room.CaptureBanPlayerObservation(),
    Slots: e.room.m_rgSlotInfo.map((b) => b.toString("hex")),
    Helper: e.room.m_banChief.CaptureSnapshot(),
    Clock: e.clock.GetStateSnapshot(),
    Launch: e.room.GetGameLaunchState(),
    Matrix: [...e.room.m_adwOpaqueSlotMatrix],
    Ghosts: [
      [...e.room.m_anSlotGhost],
      [...e.room.m_anGhostSlot],
      e.room.m_nGhostCount,
    ],
    Dirty: e.room.m_nModified,
  };
}
function untouched(
  e: ReturnType<typeof create>,
  p: MemoryClient,
  count: number,
  original: ReturnType<typeof roomState>,
) {
  expect(e.room.GetCurPlayer()).toBe(count);
  expect(roomState(e)).toEqual(original);
  expect(
    p.m_aUser.every(
      (u) =>
        u.GetSessionIdx() === SessionLimit.NoSession &&
        u.GetSessionSerialNo() === 0xffffffff,
    ),
  ).toBe(true);
  expect(p.packets).toEqual([]);
  expect(e.clients.every((s) => !s.packets.length)).toBe(true);
}

test("LIVE81 during issued waiting vote: dual-local first open slots, complete81/8-slot/112/112/93 snapshot, foreign105 to old peers, NO113/114/Defer or SQL/epoch effects", () => {
  const e = create(),
    target = start(e),
    p = incoming(2),
    before = money(e, [p]),
    votes = [...e.room.m_anBanPlayerVote],
    helper = e.room.m_banChief.CaptureSnapshot(),
    chief = e.room.m_nChiefSlotidx;
  join(e, p, [5, 0]);
  expect(p.m_aUser.map((u) => u.m_nSlotIdx)).toEqual([4, 5]);
  expect(p.packets.map((q) => q.m_nPacketType)).toEqual([
    81, 105, 105, 105, 105, 105, 105, 107, 107, 112, 112, 93,
  ]);
  expect(p.Take(81).Decode1()).toBe(JoinSessionResult.Success);
  expect(
    e.clients.every(
      (s) => s.packets.map((q) => q.m_nPacketType).join(",") === "105,105",
    ),
  ).toBe(true);
  expect([...e.room.m_anBanPlayerVote]).toEqual(votes);
  expect(e.room.m_ulBanTargetSerialNo).toBe(target);
  expect(e.room.m_nChiefSlotidx).toBe(chief);
  expect(e.room.m_banChief.CaptureSnapshot()).toEqual(helper);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
  expect(e.table.GetPendingBanPlayerCount()).toBe(1);
  expect(money(e, [p])).toEqual(before);
  expect(e.notices).toEqual([86]);
});

test("LIVE105 from joined zero-vote locals is a native early return: electorate unchanged, old participant response still resolves the SAME target", () => {
  const e = create(),
    target = start(e),
    p = incoming(2);
  join(e, p);
  e.clear();
  p.Clear();
  const votes = [...e.room.m_anBanPlayerVote];
  reply(e, p, target, 255);
  expect([...e.room.m_anBanPlayerVote]).toEqual(votes);
  expect(e.room.m_ulBanTargetSerialNo).toBe(target);
  expect(e.clients.every((s) => !s.packets.length)).toBe(true);
  expect(p.packets).toEqual([]);
  reply(e, e.clients[2]!, target, 1);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  expect(e.clients[1]!.m_nPoolType).toBe("SessionRemoved");
  expect(e.room.GetCurPlayer()).toBe(5);
  expect(p.packets.map((q) => q.m_nPacketType)).toEqual([106, 114]);
});

test("LIVE joined-zero group departure re-tallies without deleting another ballot or forgetting private player binding", () => {
  const e = create(),
    target = start(e),
    p = incoming(2);
  join(e, p);
  e.clear();
  p.Clear();
  expect(e.table.DestroyPlayer(p)).toBe(true);
  expect(e.room.GetCurPlayer()).toBe(4);
  expect(e.room.m_ulBanTargetSerialNo).toBe(target);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
  expect(
    e.clients.every(
      (s) => s.packets.map((q) => q.m_nPacketType).join(",") === "106,106",
    ),
  ).toBe(true);
  reply(e, e.clients[2]!, target, 1);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
});

test("LIVE sparse healthy vacancies retain high slot bits, reuse exact first OPEN holes, do not copy pending old ballots or fill closed holes", () => {
  const e = create([1, 1, 1, 1, 1, 1]);
  e.table.DestroyPlayer(e.clients[2]!);
  e.table.DestroyPlayer(e.clients[4]!);
  e.room.m_rgSlotInfo[2]!.set([0xe0, 0xc5, 0xe7]);
  e.room.m_rgSlotInfo[4]!.set([0xe0, 0xc0, 0xe6]);
  start(e);
  const p = incoming(2);
  join(e, p, [5, 0]);
  expect(p.m_aUser.map((u) => u.m_nSlotIdx)).toEqual([2, 4]);
  expect(e.room.m_rgSlotInfo[2]![0]! & 0xe0).toBe(0xe0);
  expect(e.room.m_rgSlotInfo[2]![1]).toBe(0xc5);
  expect(e.room.m_rgSlotInfo[4]![1]).toBe(0xc0);
  expect(e.room.m_rgSlotInfo[2]![2]! & 0xe0).toBe(0xe0);
  expect(e.room.m_rgSlotInfo[4]![2]! & 31).toBe(
    e.room.m_rgSlotInfo[2]![2]! & 31,
  );
  expect([e.room.m_anBanPlayerVote[2], e.room.m_anBanPlayerVote[4]]).toEqual([
    0, 0,
  ]);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
});

test("LIVE per-local join clocks are independent DWORDs sampled BEFORE either tuple/slot changes, source clock markers/helper stay unchanged", () => {
  const e = create(),
    target = start(e),
    p = incoming(2),
    values: number[] = [],
    helper = e.room.m_banChief.CaptureSnapshot(),
    clock = e.clock.GetStateSnapshot();
  e.clock.GetCurrentTime = () => {
    expect(e.room.GetCurPlayer()).toBe(4);
    expect(
      p.m_aUser.every(
        (u) => u.GetSessionIdx() === 0xffff && u.m_nSlotIdx === -1,
      ),
    ).toBe(true);
    const n = (0xfffffffe + values.length) >>> 0;
    values.push(n);
    return n;
  };
  join(e, p);
  expect(values).toEqual([0xfffffffe, 0xffffffff]);
  expect(p.m_aUser.map((u) => e.room.GetPlayerJoinTime(u.m_nSlotIdx))).toEqual(
    values,
  );
  expect(e.clock.GetStateSnapshot()).toEqual(clock);
  expect(e.room.m_banChief.CaptureSnapshot()).toEqual(helper);
  expect(e.room.m_ulBanTargetSerialNo).toBe(target);
});

test("LIVE second-local clock fault leaves no81,room actor,pool or first tuple; guard releases and SAME peer can retry", () => {
  const e = create();
  start(e);
  const p = incoming(2),
    before = roomState(e),
    financial = money(e, [p]);
  let reads = 0;
  e.clock.GetCurrentTime = () => {
    if (++reads === 2) throw new Error("second-local-clock");
    return 100;
  };
  expect(() => join(e, p)).toThrow("second-local-clock");
  untouched(e, p, 4, before);
  expect(money(e, [p])).toEqual(financial);
  e.clock.GetCurrentTime = () => 200;
  join(e, p);
  expect(p.Take(81).Decode1()).toBe(0);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
});

test("LIVE second-local or existing-occupant105 bad codepage/oversize fails before enrollment/ACK, not halfway through an eight-slot snapshot", () => {
  for (const kind of ["second", "occupant", "oversize"] as const) {
    const e = create();
    start(e);
    const p = incoming(2);
    if (kind === "second") p.m_aUser[1]!.m_userInfo.ID = "🙂";
    else if (kind === "occupant")
      e.clients[3]!.m_aUser[0]!.m_userInfo.ID = "🙂";
    else p.m_aUser[1]!.m_userInfo.ID = "x".repeat(0x8000);
    const before = roomState(e),
      sql = ChiefSQLState(e.session);
    expect(() => join(e, p)).toThrow();
    untouched(e, p, 4, before);
    expect(ChiefSQLState(e.session)).toEqual(sql);
  }
});

test("LIVE native/legacy mixed incoming pair keeps copied equipment/decoration105 and inventory epochs; joining neither loads SQL nor grants a ballot", () => {
  const e = create();
  start(e);
  const p = incoming(2);
  p.m_aUser[0]!.InstallUserInventory([
    NativeInventory({ Category: 4, nAttr1: 13, Slot: 0, Amount: 0 }),
    NativeInventory({ Category: 6, Slot: 0, nAttr1: 0x1234 }),
  ]);
  p.m_aUser[1]!.m_aInventory = [
    {
      SN: 77,
      ID: p.m_aUser[1]!.GetName(),
      ItemID: 77,
      Slot: 0,
      Amount: 3,
      ExpireDate: 0,
      Verbose: "legacy only",
      CreatedAt: 0,
    },
  ];
  const before = money(e, [p]);
  join(e, p);
  expect(money(e, [p])).toEqual(before);
  const q = p.packets.find(
    (q) =>
      q.m_nPacketType === 105 &&
      q.m_pBlock.length > 0 &&
      q.m_pBlock[1] === ((4 ^ 0x5a) & 255),
  )!;
  expect(q.m_pBlock).toEqual(e.room.MakeSetPlayerPacket(4, true).GetBuffer());
  expect([...e.room.m_anBanPlayerVote].slice(4, 6)).toEqual([0, 0]);
});

test("LIVE incoming second native/pre equal-byte reload and incumbent reload during105 codec are independently fenced", () => {
  for (const kind of ["new-native", "new-pre", "old-native"] as const) {
    const e = create();
    start(e);
    const p = incoming(2),
      other = kind === "old-native" ? e.clients[3]!.m_aUser[0]! : p.m_aUser[1]!;
    other.InstallUserInventory([]);
    const sql = ChiefSQLState(e.session),
      name = p.m_aUser[0]!.GetName(),
      encode = e.room.text.Encode.bind(e.room.text);
    let armed = true;
    e.room.text.Encode = (s) => {
      if (armed && s === name) {
        armed = false;
        if (kind === "new-pre") other.InstallPreInventory([]);
        else other.InstallUserInventory([]);
      }
      return encode(s);
    };
    expect(() => join(e, p)).toThrow("generation changed");
    expect(e.room.GetCurPlayer()).toBe(4);
    expect(e.room.HasActiveBanPlayerVote()).toBe(true);
    expect(p.m_aUser.every((u) => u.GetSessionIdx() === 0xffff)).toBe(true);
    expect(p.packets).toEqual([]);
    expect(e.clients.every((s) => !s.packets.length)).toBe(true);
    expect(ChiefSQLState(e.session)).toEqual(sql);
  }
});

test("LIVE actual incoming Center same-value pending ABA is opaque-epoch fenced before either local tuple writes", () => {
  const e = create();
  start(e);
  const p = incoming(2, true),
    u = p.m_aUser[1]! as CenterUser,
    old = u.GetConnectionGeneration(),
    name = p.m_aUser[0]!.GetName(),
    encode = e.room.text.Encode.bind(e.room.text),
    before = roomState(e);
  let armed = true;
  e.room.text.Encode = (s) => {
    if (armed && s === name) {
      armed = false;
      u.m_pendingConnection = undefined;
    }
    return encode(s);
  };
  expect(() => join(e, p)).toThrow("owner/generation changed");
  expect(u.GetConnectionGeneration()).not.toBe(old);
  untouched(e, p, 4, before);
});

test("LIVE join clock cannot silently adopt coherent ghost,slot-buffer,chief,target or room-generation drift", () => {
  for (const kind of [
    "ghost",
    "buffer",
    "chief",
    "target",
    "generation",
  ] as const) {
    const e = create();
    start(e);
    const p = incoming();
    e.clock.GetCurrentTime = () => {
      if (kind === "ghost") {
        e.room.m_anSlotGhost[3] = 0;
        e.room.m_anGhostSlot[0] = 3;
      } else if (kind === "buffer")
        e.room.m_rgSlotInfo[3] = Buffer.from(e.room.m_rgSlotInfo[3]!);
      else if (kind === "chief") e.room.m_nChiefSlotidx = 2;
      else if (kind === "target") e.room.m_ulBanTargetSerialNo = 0;
      else {
        Reflect.set(e.room, "m_ulSerialNo", e.room.m_ulSerialNo + 1);
        for (const u of e.clients.flatMap((s) => s.m_aUser))
          u.m_nSessionSerialNo = e.room.m_ulSerialNo;
      }
      return 100;
    };
    expect(() => join(e, p)).toThrow();
    expect(e.room.GetCurPlayer()).toBe(4);
    expect(p.m_aUser[0]!.GetSessionIdx()).toBe(0xffff);
    expect(p.packets).toEqual([]);
    expect(e.clients.every((s) => !s.packets.length)).toBe(true);
  }
});

test("LIVE incoming join reservation blocks direct81/80/removal/autojoin and room105/121 reentry during codec, then retires on success", () => {
  const e = create(),
    target = start(e),
    p = incoming(2),
    name = p.m_aUser[0]!.GetName(),
    encode = e.room.text.Encode.bind(e.room.text);
  let armed = true;
  e.room.text.Encode = (s) => {
    if (armed && s === name) {
      armed = false;
      expect(e.table.IsRemovingPlayer(p)).toBe(true);
      expect(() => join(e, p)).toThrow("transition");
      expect(() => e.table.DestroyPlayer(p)).toThrow("incoming join");
      expect(() =>
        e.table.CreateSession(Received(new CSendPacket(80)), p),
      ).toThrow("incoming join");
      expect(() =>
        e.table.JoinFreeSession(Received(new CSendPacket(82)), p),
      ).toThrow("transition");
      expect(() => reply(e, e.clients[2]!, target, 1)).toThrow();
      expect(() => e.room.DeferBanChief()).toThrow();
    }
    return encode(s);
  };
  join(e, p);
  expect(armed).toBe(false);
  expect(e.table.IsRemovingPlayer(p)).toBe(false);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
});

test("LIVE join callback publication sees WHOLE expanded roster/issued binding; transport failure is counted, never rollback or double-install", () => {
  const e = create(),
    target = start(e),
    p = incoming(2),
    send = p.SendPacket.bind(p);
  let ack = 0;
  p.SendPacket = (q) => {
    expect(e.room.GetCurPlayer()).toBe(6);
    expect(e.room.HasActiveBanPlayerVote()).toBe(true);
    expect(p.m_aUser.map((u) => u.m_nSlotIdx)).toEqual([4, 5]);
    expect(() => e.table.DestroyPlayer(p)).toThrow();
    if (q.m_nPacketType === 81) {
      ack++;
      throw new Error("ACK is not a transaction");
    }
    send(q);
  };
  join(e, p);
  expect(ack).toBe(1);
  expect(e.room.GetPacketPublicationFailureCount()).toBe(1);
  expect(e.room.GetCurPlayer()).toBe(6);
  e.clear();
  p.Clear();
  reply(e, p, target, 1);
  expect(ack).toBe(1);
  expect(p.packets).toEqual([]);
});

test("LIVE unowned DTO/forged issuer/direct AddAllUser do not authorize enrollment; healthy private vote only admits constructor-bound table route", () => {
  const e = create(),
    target = start(e),
    p = incoming();
  expect(() => e.room.JoinPlayerDuringVote({}, p, [0])).toThrow("issuer");
  expect(() => e.room.AddAllUser(p, [0])).toThrow();
  const before = roomState(e);
  e.room.m_anBanPlayerVote[7] = 1;
  join(e, p);
  expect(p.Take(81).Decode1()).toBe(JoinSessionResult.Unavailable);
  expect(p.m_aUser[0]!.GetSessionIdx()).toBe(0xffff);
  e.room.m_anBanPlayerVote[7] = 0;
  expect(e.room.m_ulBanTargetSerialNo).toBe(target);
  expect(roomState(e)).toEqual(before);
});

test("LIVE malformed incoming second tuple,duplicate serial,sparse group,foreign owner and freed local cannot half-enroll a pair", () => {
  for (const kind of [
    "serial",
    "duplicate",
    "sparse",
    "owner",
    "free",
  ] as const) {
    const e = create();
    start(e);
    const p = incoming(2);
    if (kind === "serial") p.m_aUser[1]!.m_nSessionSerialNo = 0;
    else if (kind === "duplicate")
      Reflect.set(
        p.m_aUser[1]!,
        "m_nGlobalSerialNo",
        p.m_aUser[0]!.GetGlobalSerialNo(),
      );
    else if (kind === "sparse") delete p.m_aUser[1];
    else if (kind === "owner") p.m_aUser[1]!.m_pClientSocket = e.clients[0];
    else p.m_aUser[1]!.SetFree();
    const before = roomState(e);
    expect(() => join(e, p)).toThrow();
    expect(roomState(e)).toEqual(before);
    expect(p.packets).toEqual([]);
    expect(e.clients.every((s) => !s.packets.length)).toBe(true);
  }
});

test("LIVE stale positive stored slot with valid no-session tuple is overwritten, not invented as a blanket join prohibition", () => {
  const e = create();
  start(e);
  const p = incoming();
  p.m_aUser[0]!.m_nSlotIdx = 7;
  join(e, p);
  expect(p.m_aUser[0]!.m_nSlotIdx).toBe(4);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
});

test("LIVE full/password/closed-hole rejection happens before any clock; healthy failed join changes no native vote/helper", () => {
  const e = create([1, 1, 1, 1, 1, 1, 1]);
  start(e);
  const p = incoming(2),
    before = roomState(e);
  e.clock.GetCurrentTime = () => {
    throw new Error("must not sample full room");
  };
  join(e, p);
  expect(p.Take(81).Decode1()).toBe(JoinSessionResult.Unavailable);
  expect(roomState(e)).toEqual(before);
  const f = create();
  start(f);
  for (let slot = 4; slot < 8; slot++)
    f.room.m_rgSlotInfo[slot]![0] =
      f.room.m_rgSlotInfo[slot]![0]! | SlotStateMask.Closed;
  const q = incoming();
  f.clock.GetCurrentTime = () => {
    throw new Error("must not sample closed holes");
  };
  join(f, q);
  expect(q.Take(81).Decode1()).toBe(JoinSessionResult.Unavailable);
  expect(f.room.HasActiveBanPlayerVote()).toBe(true);
});

test("LIVE joining does not reset/elect higher-level chief,change ghost/opaque matrix or refresh native inventory/helper; new locals join the NEXT electorate only", () => {
  const e = create(),
    target = start(e),
    p = incoming(2),
    chief = e.room.m_nChiefSlotidx;
  for (const u of p.m_aUser) {
    u.m_userInfo.Exp = 1_000_000;
    u.SetLevel();
  }
  e.room.m_adwOpaqueSlotMatrix[6 * 12 + 7] = 0xdeadbeef;
  const before = roomState(e);
  join(e, p);
  expect(e.room.m_nChiefSlotidx).toBe(chief);
  expect(e.room.m_adwOpaqueSlotMatrix[6 * 12 + 7]).toBe(0xdeadbeef);
  expect(e.room.m_banChief.CaptureSnapshot()).toEqual(before.Helper);
  reply(e, e.clients[2]!, target, 0);
  reply(e, e.clients[3]!, target, 0);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  e.clear();
  p.Clear();
  start(e);
  expect(p.m_aUser.map((u) => e.room.m_anBanPlayerVote[u.m_nSlotIdx])).toEqual([
    1, 1,
  ]);
  expect(p.packets.filter((q) => q.m_nPacketType === 113)).toHaveLength(1);
});

test("LIVE financial freeze/Mod/Guild/Playing remain before incoming clock/codec, without admitting data-only ballots", () => {
  for (const kind of ["financial", "mod", "guild", "playing"] as const) {
    const e = create();
    start(e);
    const p = incoming(),
      sql = ChiefSQLState(e.session);
    e.clock.GetCurrentTime = () => {
      throw new Error("must not reach join clock");
    };
    if (kind === "financial") e.room.IsGameplayCommitPending = () => true;
    else if (kind === "mod") Reflect.set(e.room, "m_nGameType", GameType.Mod);
    else if (kind === "guild")
      Reflect.set(e.room, "channelType", ChannelType.Guild);
    else e.room.m_bPlaying = true;
    if (kind === "playing") {
      join(e, p);
      expect(p.Take(81).Decode1()).toBe(JoinSessionResult.Unavailable);
    } else expect(() => join(e, p)).toThrow();
    expect(p.m_aUser[0]!.GetSessionIdx()).toBe(0xffff);
    expect(ChiefSQLState(e.session)).toEqual(sql);
  }
});

test("LIVE incoming global serial is range-checked and cannot drift during clock/codec after the snapshot serial was captured", () => {
  for (const value of [0, -1, 0x100000000, NaN]) {
    const e = create();
    start(e);
    const p = incoming(2),
      before = roomState(e);
    Reflect.set(p.m_aUser[1]!, "m_nGlobalSerialNo", value);
    expect(() => join(e, p)).toThrow("serial");
    untouched(e, p, 4, before);
  }
  const e = create();
  start(e);
  const p = incoming(),
    before = roomState(e);
  e.clock.GetCurrentTime = () => {
    Reflect.set(p.m_aUser[0]!, "m_nGlobalSerialNo", 0xffffffff);
    return 100;
  };
  expect(() => join(e, p)).toThrow("user data changed");
  untouched(e, p, 4, before);
});

test("LIVE password mismatch uses native81/1 before clock/105, original issued vote survives and same peer may join after correct password", () => {
  const e = create();
  start(e);
  Reflect.set(e.room, "m_strPassword", "Correct");
  const p = incoming(2),
    before = roomState(e);
  e.clock.GetCurrentTime = () => {
    throw new Error("password failure cannot sample join clock");
  };
  e.table.DoJoinSession(p, e.room.m_nIdx, e.room.m_ulSerialNo, "Wrong", [0, 0]);
  expect(p.Take(81).Decode1()).toBe(JoinSessionResult.IncorrectPassword);
  expect(roomState(e)).toEqual(before);
  expect(e.clients.every((s) => !s.packets.length)).toBe(true);
  e.clock.GetCurrentTime = () => 100;
  e.table.DoJoinSession(
    p,
    e.room.m_nIdx,
    e.room.m_ulSerialNo,
    "Correct",
    [0, 0],
  );
  expect(p.Take(81).Decode1()).toBe(0);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
});

test("LIVE native authority1 zero means CLOSED slots are not free even for SQL AuthorityFFFFFFFF; zero-valued new votes are not an admin exclusion invention", () => {
  const e = create();
  start(e);
  e.table.OnPacket(Received(new CSendPacket(100).Encode1(0x41)), e.clients[0]!);
  e.clear();
  const p = incoming(2);
  p.m_aUser.forEach((u) => (u.m_userInfo.Authority = 0xffffffff));
  join(e, p);
  expect(p.m_aUser.map((u) => u.m_nSlotIdx)).toEqual([5, 6]);
  expect(e.room.m_rgPlayer[4]).toBeUndefined();
  expect([...e.room.m_anBanPlayerVote].slice(5, 7)).toEqual([0, 0]);
});

test("LIVE reservation releases after incoming-codec failure: same socket may explicitly create its OWN room afterward, without stale table join lock", () => {
  const e = create();
  start(e);
  const p = incoming(),
    original = p.m_aUser[0]!.m_userInfo.ID;
  p.m_aUser[0]!.m_userInfo.ID = "🙂";
  expect(() => join(e, p)).toThrow();
  expect(e.table.IsRemovingPlayer(p)).toBe(false);
  p.m_aUser[0]!.m_userInfo.ID = original;
  e.table.OnPacket(
    Received(
      new CSendPacket(80)
        .EncodeStr("Different room")
        .EncodeStr("")
        .Encode1(0)
        .Encode1(1)
        .Encode1(0),
    ),
    p,
  );
  expect(p.Take(80).Decode1()).toBe(0);
  expect(p.m_aUser[0]!.GetSessionIdx()).not.toBe(e.room.m_nIdx);
  expect(e.room.GetCurPlayer()).toBe(4);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
});

test("LIVE automatic first-fit82 reaches the SAME owned-vote join preparation, no113 or native vote reset", () => {
  const e = create(),
    target = start(e),
    p = incoming(2),
    votes = [...e.room.m_anBanPlayerVote];
  e.table.OnPacket(
    Received(new CSendPacket(82).Encode1(2).Encode1(0).Encode1(0)),
    p,
  );
  expect(p.Take(81).Decode1()).toBe(0);
  expect(p.m_aUser.map((u) => u.m_nSlotIdx)).toEqual([4, 5]);
  expect([...e.room.m_anBanPlayerVote]).toEqual(votes);
  expect(e.room.m_ulBanTargetSerialNo).toBe(target);
});

test("LIVE repeated joins refresh ONLY the private roster binding; helper/electorate remain old, higher level newcomers never steal chief", () => {
  const e = create(),
    target = start(e),
    a = incoming(1),
    b = incoming(2),
    helper = e.room.m_banChief.CaptureSnapshot(),
    votes = [...e.room.m_anBanPlayerVote],
    chief = e.room.m_nChiefSlotidx;
  join(e, a);
  join(e, b);
  expect(e.room.GetCurPlayer()).toBe(7);
  expect(e.room.m_nChiefSlotidx).toBe(chief);
  expect(e.room.m_banChief.CaptureSnapshot()).toEqual(helper);
  expect([...e.room.m_anBanPlayerVote]).toEqual(votes);
  expect(e.room.m_ulBanTargetSerialNo).toBe(target);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
  expect(e.table.DestroyPlayer(a)).toBe(true);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
  reply(e, e.clients[2]!, target, 1);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
});
