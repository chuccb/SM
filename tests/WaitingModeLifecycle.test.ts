import { afterEach, expect, test } from "bun:test";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CUser } from "../Common/CUser.ts";
import {
  GameType,
  GameStage,
  SessionLimit,
  BanPlayerRule,
} from "../Common/OfficialValues.ts";
import {
  GameLaunchFixture,
  DiscoverLaunchPeer,
  LaunchReadyPacket,
} from "./helpers/GameLaunch.ts";
import { WaitingChiefFixture, ChiefSQLState } from "./helpers/WaitingChief.ts";
import { MemoryClient, Received } from "./helpers/Clients.ts";
import { UserInfo } from "./helpers/Accounts.ts";
import { NativeInventory } from "./helpers/UserInventory.ts";
const close: (() => void)[] = [];
afterEach(() => {
  for (const f of close.splice(0).reverse()) f();
});
function create(counts: readonly number[] = [1, 1, 1, 1], manner = 0) {
  const e = GameLaunchFixture(
    counts,
    undefined,
    undefined,
    undefined,
    undefined,
    { Manner: manner },
  );
  close.push(e.close);
  return e;
}
function change(e: ReturnType<typeof create>, kind: number, peer = 0) {
  e.table.OnPacket(Received(new CSendPacket(kind)), e.clients[peer]!);
}
function vote(e: ReturnType<typeof create>, index = 1) {
  const target = e.clients[index]!.m_aUser[0]!.GetGlobalSerialNo();
  e.table.OnPacket(
    Received(new CSendPacket(104).Encode4(target).Encode1(0)),
    e.clients[0]!,
  );
  e.clear();
  return target;
}
function reply(
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
    Manner: e.room.m_nManner,
    Observation: e.room.CaptureBanPlayerObservation(),
    Slots: e.room.m_rgSlotInfo.map((b) => b.toString("hex")),
    Helper: e.room.m_banChief.CaptureSnapshot(),
    Clock: e.clock.GetStateSnapshot(),
    Launch: e.room.GetGameLaunchState(),
    Ghosts: [
      [...e.room.m_anSlotGhost],
      [...e.room.m_anGhostSlot],
      e.room.m_nGhostCount,
    ],
    Matrix: [...e.room.m_adwOpaqueSlotMatrix],
    Dirty: e.room.m_nModified,
    Pool: e.clients.map((p) => p.m_nPoolType),
    Users: e.clients
      .flatMap((p) => p.m_aUser)
      .map((u) => ({
        Info: { ...u.m_userInfo },
        Dynamic: u.GetDynamicInfoSnapshot(),
        Pair: u.CaptureUserInventoryInitialization(),
        Owned: u.GetUserInventoryGeneration(),
        Pre: u.GetPreInventoryGeneration(),
      })),
    SQL: ChiefSQLState(e.session),
  };
}
function assertModeOnly(e: ReturnType<typeof create>, opcode: number) {
  for (const p of e.clients) {
    expect(p.packets.map((p) => p.m_nPacketType)).toEqual([opcode]);
    expect(p.packets[0]!.m_pBlock.toString("hex")).toBe(
      opcode === 92 ? "06" : "07",
    );
  }
}

test("LIVE103/102 waiting setters write mode+948 only:92/93 opcode-only,unchanged Manner/ready/map/helper/clock/money/inventory/modified flags, no clock/RNG/strategy call", () => {
  const e = create([2, 1], 1),
    before = state(e),
    revision = e.room.GetGameTypeState().Revision;
  e.clock.GetCurrentTime = () => {
    throw new Error("mode must not sample clock");
  };
  e.random(() => {
    throw new Error("mode must not draw RNG");
  });
  e.room.m_pStrategy.SendSessionInfo = () => {
    throw new Error("setter is NOT strategy info");
  };
  change(e, 103);
  assertModeOnly(e, 92);
  expect(state(e)).toEqual(before);
  expect(e.room.GetGameTypeState()).toEqual({
    Value: 1,
    WaitingIssued: true,
    Revision: revision + 1,
  });
  e.clear();
  change(e, 102);
  assertModeOnly(e, 93);
  expect(state(e)).toEqual(before);
  expect(e.room.GetGameTypeState()).toEqual({
    Value: 0,
    WaitingIssued: true,
    Revision: revision + 2,
  });
});

test("LIVE issued vote survives103 Mod WAITING then102 Normal with exact same target/electorate/chief, no113/114/Defer/reload or helper reset", () => {
  const e = create(),
    target = vote(e),
    before = state(e);
  change(e, 103);
  assertModeOnly(e, 92);
  expect(state(e)).toEqual(before);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
  expect(e.room.m_ulBanTargetSerialNo).toBe(target);
  e.clear();
  change(e, 102);
  assertModeOnly(e, 93);
  expect(state(e)).toEqual(before);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
});

test("LIVE104 may begin in legitimately issued Mod waiting,105 still has native per-local weighting and whole target ejection, mode remains1", () => {
  const e = create([1, 2, 1, 1]);
  change(e, 103);
  e.clear();
  const target = vote(e);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
  reply(e, 2, target);
  expect(e.room.GetCurPlayer()).toBe(3);
  expect(e.clients[1]!.m_nPoolType).toBe("SessionRemoved");
  expect(e.room.GetGameTypeState().Value).toBe(1);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  expect(e.clients[1]!.packets.map((p) => p.m_nPacketType)).toEqual([106]);
});

test("LIVE Mod waiting105 No tie/failure clears ONLY target; no mode reset and new104 electorate remains legitimate", () => {
  const e = create([1, 1, 1]);
  change(e, 103);
  e.clear();
  const target = vote(e);
  reply(e, 2, target, 0);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  expect(e.room.GetCurPlayer()).toBe(3);
  expect(e.room.GetGameTypeState().Value).toBe(1);
  e.clear();
  vote(e);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
});

test("LIVE Mod waiting direct target departure cancels114/4, while denominator-shrinking unrelated departure can synchronously eject another group", () => {
  const e = create();
  const target = vote(e);
  change(e, 103);
  e.clear();
  expect(e.table.DestroyPlayer(e.clients[1]!)).toBe(true);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  expect(e.room.GetGameTypeState().Value).toBe(1);
  expect(e.clients[0]!.packets.at(-1)!.m_nPacketType).toBe(114);
  const f = create([1, 2, 1, 1, 1]),
    serial = vote(f);
  reply(f, 2, serial);
  change(f, 103);
  f.clear();
  expect(f.table.DestroyPlayer(f.clients[4]!)).toBe(true);
  expect(f.clients[1]!.m_nPoolType).toBe("SessionRemoved");
  expect(f.room.GetCurPlayer()).toBe(3);
  expect(f.room.GetGameTypeState().Value).toBe(1);
  expect(f.room.m_ulBanTargetSerialNo).toBe(0);
  expect(target).toBeGreaterThan(0);
});

test("LIVE mode snapshot to one recipient is native idempotent mode write plus one opcode, never a room broadcast/slot snapshot/election", () => {
  const e = create();
  change(e, 103);
  e.clear();
  const before = state(e),
    revision = e.room.GetGameTypeState().Revision;
  e.room.SendGameType(e.clients[2]!);
  expect(e.clients.map((p) => p.packets.map((p) => p.m_nPacketType))).toEqual([
    [],
    [],
    [92],
    [],
  ]);
  expect(state(e)).toEqual(before);
  expect(e.room.GetGameTypeState().Revision).toBe(revision + 1);
});

test("LIVE repeated same-mode103 is NOT silently suppressed:one92 each command and private revision advances without reissuing ballots", () => {
  const e = create();
  const target = vote(e);
  change(e, 103);
  e.clear();
  const votes = [...e.room.m_anBanPlayerVote],
    r = e.room.GetGameTypeState().Revision;
  change(e, 103);
  assertModeOnly(e, 92);
  expect(e.room.GetGameTypeState().Revision).toBe(r + 1);
  expect([...e.room.m_anBanPlayerVote]).toEqual(votes);
  expect(e.room.m_ulBanTargetSerialNo).toBe(target);
});

test("LIVE mode publication is guarded and detached:all peers observe new mode+valid vote, cannot respond/join/remove/Update/reenter before setter returns", () => {
  const e = create(),
    target = vote(e),
    send = e.clients[0]!.SendPacket.bind(e.clients[0]!);
  let seen = 0;
  e.clients[0]!.SendPacket = (p) => {
    if (p.m_nPacketType === 92) {
      seen++;
      expect(e.room.GetGameTypeState().Value).toBe(1);
      expect(e.room.HasActiveBanPlayerVote()).toBe(true);
      expect(() => reply(e, 2, target)).toThrow();
      expect(() => change(e, 102)).toThrow();
      expect(() => e.table.DestroyPlayer(e.clients[2]!)).toThrow();
      expect(() => e.room.DeferBanChief()).toThrow();
    }
    send(p);
  };
  change(e, 103);
  expect(seen).toBe(1);
  expect(e.room.GetCurPlayer()).toBe(4);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
});

test("LIVE failed92 transport is counted and does not rollback/replay mode, ballot or prevent other recipients; later real105 still resolves", () => {
  const e = create(),
    target = vote(e);
  e.clients[0]!.SendPacket = (p) => {
    if (p.m_nPacketType === 92) throw new Error("mode transport fault");
  };
  change(e, 103);
  expect(e.room.GetPacketPublicationFailureCount()).toBe(1);
  expect(
    e.clients
      .slice(1)
      .every((p) => p.packets.map((p) => p.m_nPacketType).join(",") === "92"),
  ).toBe(true);
  expect(e.room.GetGameTypeState().Value).toBe(1);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
  e.clear();
  reply(e, 2, target);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
});

test("LIVE chief/body validation remains before mode/private epoch; nonchief or trailing102/103 body cannot emit success or change Manner", () => {
  const e = create([2, 1], 1),
    before = state(e),
    mode = e.room.GetGameTypeState();
  for (const opcode of [102, 103]) {
    expect(() => change(e, opcode, 1)).toThrow("chief");
    expect(() =>
      e.table.OnPacket(
        Received(new CSendPacket(opcode).Encode1(0)),
        e.clients[0]!,
      ),
    ).toThrow("trailing");
  }
  expect(e.room.GetGameTypeState()).toEqual(mode);
  expect(state(e)).toEqual(before);
  expect(e.clients.every((p) => !p.packets.length)).toBe(true);
});

test("LIVE reflected Mod flag alone is NOT issued waiting mode; forged vote DTO is NOT repaired by102/103", () => {
  const e = create();
  Reflect.set(e.room, "m_nGameType", GameType.Mod);
  expect(e.room.GetGameTypeState().WaitingIssued).toBe(false);
  expect(e.room.IsWaitingChiefScheduled()).toBe(false);
  expect(() => vote(e)).toThrow();
  expect(() => e.room.DeferBanChief()).toThrow();
  const f = create(),
    plan = f.room.PrepareHostAskBanPlayer(f.clients[0]!, {
      TargetSerialNo: f.clients[1]!.m_aUser[0]!.GetGlobalSerialNo(),
      Immediate: 0,
    });
  f.room.m_ulBanTargetSerialNo = plan.After.TargetSerialNo;
  f.room.m_anBanPlayerVote.set(plan.After.Votes);
  const mode = f.room.GetGameTypeState();
  expect(() => change(f, 103)).toThrow("Unowned");
  expect(() => change(f, 102)).toThrow("Unowned");
  expect(f.room.GetGameTypeState()).toEqual(mode);
  expect(f.clients.every((p) => !p.packets.length)).toBe(true);
});

test("LIVE Mod waiting join snapshot ends92 not hardcoded93, new locals still0-vote and old105 resolves same target", () => {
  const e = create(),
    target = vote(e);
  change(e, 103);
  e.clear();
  const p = new MemoryClient();
  close.push(() => p.Close());
  for (let i = 0; i < 2; i++) {
    const u = new CUser(UserInfo(`ModeNew${i}`), 0xfedcba90 + i);
    u.m_pClientSocket = p;
    p.m_aUser.push(u);
  }
  const before = ChiefSQLState(e.session);
  e.table.DoJoinSession(p, e.room.m_nIdx, e.room.m_ulSerialNo, "", [0, 0]);
  expect(p.Take(81).Decode1()).toBe(0);
  expect(p.packets.at(-1)!.m_nPacketType).toBe(92);
  expect(e.room.GetGameTypeState().Value).toBe(1);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
  expect(p.m_aUser.map((u) => e.room.m_anBanPlayerVote[u.m_nSlotIdx])).toEqual([
    0, 0,
  ]);
  e.clear();
  p.Clear();
  e.room.OnPacket(Received(new CSendPacket(105).Encode4(target).Encode1(1)), p);
  expect(p.packets).toEqual([]);
  reply(e, 2, target);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  expect(p.packets.map((p) => p.m_nPacketType)).toEqual([106, 114]);
  expect(ChiefSQLState(e.session)).toEqual(before);
});

test("LIVE Mod waiting original CanStart/CBanChief scheduling remains active, ready warning/kick clocks native and unchanged by mode", () => {
  const e = WaitingChiefFixture({ Counts: [2, 1], Capacity: 3 });
  close.push(e.close);
  change(e, 103);
  e.clear();
  expect(e.room.IsWaitingChiefScheduled()).toBe(true);
  expect(e.table.GetWaitingChiefSessionCount()).toBe(1);
  e.tick(100);
  expect(e.room.m_banChief.IsCanStart()).toBe(true);
  const helper = e.room.m_banChief.CaptureSnapshot();
  change(e, 103);
  expect(e.room.m_banChief.CaptureSnapshot()).toEqual(helper);
  e.clear();
  e.tick(10101);
  expect(
    e.clients.every((p) => p.packets.some((p) => p.m_nPacketType === 121)),
  ).toBe(true);
  e.clear();
  e.tick(20102);
  expect(e.clients[0]!.m_nPoolType).toBe("SessionRemoved");
  expect(e.room.GetCurPlayer()).toBe(1);
  expect(e.room.GetGameTypeState().Value).toBe(1);
});

test("LIVE Mod waiting active vote retains native double-chief Init +outer odd setter during121 cascade, no normal-only timer suspension", () => {
  const e = create([1, 1, 2, 1, 1, 1], 1);
  e.table.OnPacket(Received(new CSendPacket(100).Encode1(0x71)), e.clients[0]!);
  const target = vote(e, 2);
  e.table.DestroyPlayer(e.clients[0]!);
  reply(e, 3, target);
  reply(e, 4, target);
  e.room.OnPacket(Received(new CSendPacket(103)), e.clients[1]!);
  e.clear();
  e.time(100);
  e.room.DeferBanChief();
  e.time(5101);
  e.room.DeferBanChief();
  e.clear();
  const ticks: number[] = [];
  e.clock.GetCurrentTime = () => {
    const n = 15102 + ticks.length;
    ticks.push(n);
    return n;
  };
  e.room.DeferBanChief();
  expect(ticks).toEqual([15102, 15103, 15104]);
  expect(e.room.GetCurPlayer()).toBe(3);
  expect(e.clients[1]!.m_nPoolType).toBe("SessionRemoved");
  expect(e.clients[2]!.m_nPoolType).toBe("SessionRemoved");
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  expect(e.room.GetGameTypeState().Value).toBe(1);
});

test("LIVE Mod106 stays explicitly unavailable BEFORE115/116 or clocks, then102 permits SAME issued vote through real Normal launch/start", () => {
  const e = create(),
    target = vote(e),
    votes = [...e.room.m_anBanPlayerVote];
  change(e, 103);
  e.clear();
  const mode = e.room.GetGameTypeState();
  e.clock.GetCurrentTime = () => {
    throw new Error("unported Mod must not read launch clock");
  };
  expect(() => change(e, 106)).toThrow("special result lifecycle");
  expect(e.room.GetGameTypeState()).toEqual(mode);
  expect(e.room.m_bPlaying).toBe(false);
  expect(e.clients.every((p) => !p.packets.length)).toBe(true);
  e.clock.GetCurrentTime = () => 100;
  change(e, 102);
  e.clear();
  change(e, 106);
  expect(e.room.m_bPlaying).toBe(true);
  for (const p of e.clients) {
    expect(DiscoverLaunchPeer(e.room, p)).toBe(true);
    e.room.OnPacket(Received(LaunchReadyPacket(e.room, p)), p);
  }
  expect(e.room.m_nGameState).toBe(GameStage.Running);
  expect([...e.room.m_anBanPlayerVote]).toEqual(votes);
  expect(e.room.m_ulBanTargetSerialNo).toBe(target);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
  e.clear();
  expect(() => change(e, 103)).toThrow("committed ordinary round");
  expect(e.room.GetGameTypeState().Value).toBe(0);
  expect(e.clients.every((p) => !p.packets.length)).toBe(true);
});

test("LIVE active native Result conflict rejects102/103 before private mode revision/packet, same receipt and target survive", () => {
  const e = create(),
    target = vote(e);
  change(e, 106);
  for (const p of e.clients) {
    DiscoverLaunchPeer(e.room, p);
    e.room.OnPacket(Received(LaunchReadyPacket(e.room, p)), p);
  }
  e.clear();
  e.db.CommitGameResult = () => "conflict";
  e.time(180101);
  e.room.Update();
  expect(e.room.IsResultCommitPending()).toBe(true);
  const before = e.room.GetGameTypeState(),
    sql = ChiefSQLState(e.session);
  expect(() => change(e, 102)).toThrow("frozen");
  expect(() => change(e, 103)).toThrow("committed ordinary round");
  expect(e.room.GetGameTypeState()).toEqual(before);
  expect(e.room.m_ulBanTargetSerialNo).toBe(target);
  expect(ChiefSQLState(e.session)).toEqual(sql);
});

test("LIVE same-value normal reentry during native shuffle is blocked by transition, not permission to replace current mode/epoch", () => {
  const e = create();
  vote(e);
  let calls = 0;
  e.random(() => {
    calls++;
    expect(() => change(e, 102)).toThrow();
    return 1;
  });
  change(e, 106);
  expect(calls).toBeGreaterThan(0);
  expect(e.room.GetGameTypeState().Value).toBe(0);
  expect(e.room.m_bPlaying).toBe(true);
});

test("LIVE game-type inspection is immutable metadata, not private mode issuance, financial/launch authority or room Manner", () => {
  const e = create([1, 1], 1),
    p = e.room.GetGameTypeState();
  expect(Object.isFrozen(p)).toBe(true);
  expect(p).toEqual({ Value: 0, WaitingIssued: true, Revision: 1 }); // existing join SendGameType writes mode0 again
  expect(Reflect.has(p, "Apply")).toBe(false);
  expect(Reflect.has(p, "Issuer")).toBe(false);
  expect(e.room.IsManner()).toBe(true);
  expect(e.room.m_nManner).toBe(1);
  expect(e.clients[0]!.m_aUser[0]!.GetSessionIdx()).not.toBe(
    SessionLimit.NoSession,
  );
});

test("LIVE same-value normal setter invalidates a read-only preparation epoch even though native mode/vote bytes stay identical; external setter is not rolled back", () => {
  const e = create(),
    u = e.clients[1]!.m_aUser[0]!,
    revision = e.room.GetGameTypeState().Revision;
  let armed = true;
  u.HasFunctionalItem = () => {
    if (armed) {
      armed = false;
      e.room.SendGameTypeNormal();
    }
    return false;
  };
  expect(() =>
    e.room.PrepareHostAskBanPlayer(e.clients[0]!, {
      TargetSerialNo: u.GetGlobalSerialNo(),
      Immediate: 0,
    }),
  ).toThrow("changed");
  expect(e.room.GetGameTypeState().Value).toBe(0);
  expect(e.room.GetGameTypeState().Revision).toBe(revision + 1);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  expect(
    e.clients.every(
      (p) => p.packets.map((q) => q.m_nPacketType).join(",") === "93",
    ),
  ).toBe(true);
});

test("LIVE active waiting financial predicates refuse BOTH mode setters before revision or any mode packet; no authority inferred from snapshot", () => {
  for (const field of [
    "IsMoneyPickupPending",
    "IsHouseClaimPending",
    "IsSpecialItemUsePending",
  ] as const) {
    const e = create();
    vote(e);
    const before = e.room.GetGameTypeState(),
      sql = ChiefSQLState(e.session);
    e.room[field] = () => true;
    expect(() => change(e, 103)).toThrow(/frozen|transition/);
    expect(() => change(e, 102)).toThrow(/frozen|transition/);
    expect(e.room.GetGameTypeState()).toEqual(before);
    expect(ChiefSQLState(e.session)).toEqual(sql);
    expect(e.clients.every((p) => !p.packets.length)).toBe(true);
  }
});

test("LIVE Known Mod waiting still honors issuer-bound SuperChief/BanReflex native attributes and whole-group reflection without inventing Mod combat", () => {
  const e = create([2, 2, 1, 1]);
  change(e, 103);
  e.clear();
  e.clients[1]!.m_aUser[1]!.InstallUserInventory([
    NativeInventory({
      strAttr: BanPlayerRule.BanReflexAttribute,
      Amount: 0,
      Slot: 255,
    }),
  ]);
  vote(e);
  expect(e.clients[0]!.m_nPoolType).toBe("SessionRemoved");
  expect(e.room.GetCurPlayer()).toBe(4);
  expect(e.room.GetGameTypeState().Value).toBe(1);
  expect(e.room.IsWaitingChiefScheduled()).toBe(true);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
});
