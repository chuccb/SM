import { afterEach, expect, test } from "bun:test";
import { CSendPacket } from "../Common/CSendPacket.ts";
import {
  BanChiefRule,
  BanPlayerRule,
  GameType,
  JoinSessionResult,
  SessionLimit,
} from "../Common/OfficialValues.ts";
import { CUser } from "../Common/CUser.ts";
import { CUser as CenterUser } from "../Center/CUser.ts";
import { GameLaunchFixture } from "./helpers/GameLaunch.ts";
import { Received, MemoryClient } from "./helpers/Clients.ts";
import { NativeInventory } from "./helpers/UserInventory.ts";
import { UserInfo } from "./helpers/Accounts.ts";
import { ChiefSQLState } from "./helpers/WaitingChief.ts";
const closes: (() => void)[] = [];
afterEach(() => {
  for (const close of closes.splice(0).reverse()) close();
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
  closes.push(e.close);
  return e;
}
function start(e: ReturnType<typeof create>, target = 1, immediate = 0) {
  const serial = e.clients[target]!.m_aUser[0]!.GetGlobalSerialNo();
  e.table.OnPacket(
    Received(new CSendPacket(104).Encode4(serial).Encode1(immediate)),
    e.clients[0]!,
  );
  return serial;
}
function respond(
  e: ReturnType<typeof create>,
  peer: number,
  answer: number,
  serial = e.room.m_ulBanTargetSerialNo,
) {
  e.table.OnPacket(
    Received(new CSendPacket(105).Encode4(serial).Encode1(answer)),
    e.clients[peer]!,
  );
}
function results(peer: MemoryClient) {
  return peer.packets
    .filter((p) => p.m_nPacketType === 114)
    .map((p) => {
      const q = Received(
        new CSendPacket(114, p.m_nCipherDegree).EncodeBuffer(
          p.m_pBlock.subarray(1),
        ),
      );
      q.Decode1();
      const Code = q.Decode1(),
        Name = [2, 3, 5].includes(Code) ? q.DecodeStr() : undefined;
      q.AssertEnd();
      return { Code, Name };
    });
}
function financial(e: ReturnType<typeof create>) {
  return {
    SQL: ChiefSQLState(e.session),
    Users: e.clients
      .flatMap((s) => s.m_aUser)
      .map((u) => ({
        Dynamic: u.GetDynamicInfoSnapshot(),
        Pair: u.CaptureUserInventoryInitialization(),
      })),
  };
}
function assertRemoved(peer: MemoryClient) {
  expect(peer.m_nPoolType).toBe("SessionRemoved");
  for (const u of peer.m_aUser) {
    expect(u.GetSessionIdx()).toBe(0xffff);
    expect(u.GetSessionSerialNo()).toBe(0xffffffff);
    expect(u.m_nSlotIdx).toBe(-1);
    expect(u.IsSetFree()).toBe(0);
  }
}

test("LIVE104/105 ordinary waiting:113 goes only to eligible sockets,114/0 chief-only; strict majority removes target group(TRUE) before114/2, no195/Lobby/SQL", () => {
  const e = create(),
    before = financial(e),
    target = start(e);
  expect(e.room.m_ulBanTargetSerialNo).toBe(target);
  expect([...e.room.m_anBanPlayerVote]).toEqual([2, 0, 1, 1, 0, 0, 0, 0]);
  expect(e.clients.map((s) => s.packets.map((p) => p.m_nPacketType))).toEqual([
    [114],
    [],
    [113],
    [113],
  ]);
  expect(results(e.clients[0]!)).toEqual([{ Code: 0, Name: undefined }]);
  e.clear();
  respond(e, 2, 255);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  assertRemoved(e.clients[1]!);
  expect(e.room.GetCurPlayer()).toBe(3);
  expect(e.clients[1]!.packets.map((p) => p.m_nPacketType)).toEqual([106]);
  expect(results(e.clients[0]!)).toEqual([
    { Code: 2, Name: e.clients[1]!.m_aUser[0]!.GetName() },
  ]);
  expect(
    e.clients
      .flatMap((s) => s.packets)
      .some((p) => [15, 195].includes(p.m_nPacketType)),
  ).toBe(false);
  expect(financial(e)).toEqual(before);
});

test("LIVE missing104 target initializes occupied1 but NO ACK/query; busy104 does not decode malformed body; inactive/wrong-serial105 does not read answer", () => {
  const e = create();
  e.table.OnPacket(Received(new CSendPacket(105)), e.clients[2]!);
  expect(e.clients.every((s) => !s.packets.length)).toBe(true);
  e.table.OnPacket(
    Received(new CSendPacket(104).Encode4(0xffffffff).Encode1(255)),
    e.clients[0]!,
  );
  expect([...e.room.m_anBanPlayerVote]).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
  expect(e.clients.every((s) => !s.packets.length)).toBe(true);
  const target = start(e);
  e.clear();
  e.table.OnPacket(Received(new CSendPacket(104)), e.clients[0]!);
  expect(results(e.clients[0]!)).toEqual([{ Code: 1, Name: undefined }]);
  e.clear();
  e.table.OnPacket(
    Received(new CSendPacket(105).Encode4(0xffffffff)),
    e.clients[2]!,
  );
  expect(e.room.m_ulBanTargetSerialNo).toBe(target);
  expect(e.clients.every((s) => !s.packets.length)).toBe(true);
});

test("LIVE105 any nonzero yes,No tie fails with114/3; duplicate already answered/chief/target cannot alter ballots or replay outcome", () => {
  const e = create([1, 1, 1]),
    serial = start(e);
  e.clear();
  respond(e, 1, 1);
  respond(e, 0, 0);
  expect(e.room.m_ulBanTargetSerialNo).toBe(serial);
  expect(e.clients.every((s) => !s.packets.length)).toBe(true);
  respond(e, 2, 0);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  expect(e.room.GetCurPlayer()).toBe(3);
  expect(results(e.clients[0]!)[0]!.Code).toBe(3);
  e.clear();
  respond(e, 2, 1, serial);
  expect(e.clients.every((s) => !s.packets.length)).toBe(true);
});

test("LIVE chief dual-local auto-Yes can pass immediately; target dual-local receives ONLY last106 and never113/started0/result2", () => {
  const e = create([2, 2]);
  start(e);
  assertRemoved(e.clients[1]!);
  expect(e.room.GetCurPlayer()).toBe(2);
  expect(e.clients[1]!.packets.map((p) => p.m_nPacketType)).toEqual([106]);
  expect(results(e.clients[0]!)[0]!.Code).toBe(2);
  expect(
    e.clients.flatMap((s) => s.packets).some((p) => p.m_nPacketType === 113),
  ).toBe(false);
});

test("LIVE secondary SuperChief withAmount0/Slot255 precedes BanReflex, immediate255 removes entire victim and114/4; no stock effects", () => {
  const e = create([2, 2, 1, 1]);
  e.clients[0]!.m_aUser[1]!.InstallUserInventory([
    NativeInventory({
      strAttr: BanChiefRule.SuperChiefAttribute,
      Amount: 0,
      Slot: 255,
    }),
  ]);
  e.clients[1]!.m_aUser[1]!.InstallUserInventory([
    NativeInventory({ strAttr: BanPlayerRule.BanReflexAttribute }),
  ]);
  const before = financial(e);
  start(e, 1, 255);
  assertRemoved(e.clients[1]!);
  expect(results(e.clients[0]!)[0]!.Code).toBe(4);
  expect(financial(e)).toEqual(before);
});

test("LIVE secondary BanReflex ejects WHOLE chief and114/5 names actual secondary chief; Init preflight occurs before any IDs/pointers consumed", () => {
  const e = create([2, 2, 1, 1]);
  e.room.SetChiefSlotidx(1);
  e.clients[1]!.m_aUser[1]!.InstallUserInventory([
    NativeInventory({
      strAttr: BanPlayerRule.BanReflexAttribute,
      Amount: 0,
      Slot: 255,
    }),
  ]);
  const before = financial(e),
    reads: number[] = [];
  e.clock.GetCurrentTime = () => {
    reads.push(e.room.GetCurPlayer());
    return 0xfffffffe;
  };
  start(e);
  expect(reads).toEqual([6]);
  assertRemoved(e.clients[0]!);
  expect(e.room.m_banChief.CaptureSnapshot().CanStartTime).toBe(0xfffffffe);
  expect(results(e.clients[1]!)[0]).toEqual({
    Code: 5,
    Name: e.clients[0]!.m_aUser[1]!.GetName(),
  });
  expect(financial(e)).toEqual(before);
});

test("LIVE target physical departure cancels pending vote with114/4(no name), normal leave pool1, no stale-target ejection", () => {
  const e = create();
  start(e);
  e.clear();
  e.clients[1]!.Close();
  expect(e.table.DestroyPlayer(e.clients[1]!, false)).toBe(true);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  expect(e.room.GetCurPlayer()).toBe(3);
  expect(e.clients[1]!.m_nPoolType).toBe("Lobby");
  expect(results(e.clients[2]!)[0]).toEqual({ Code: 4, Name: undefined });
});

test("LIVE departure shrinks denominator and synchronously ejects ANOTHER whole group; nested outer guard and batches remain owned, no intermediate86", () => {
  const e = create([1, 2, 1, 1, 1]),
    before = financial(e);
  start(e);
  respond(e, 2, 1);
  expect(e.room.m_ulBanTargetSerialNo).not.toBe(0);
  e.clear();
  const send = e.clients[0]!.SendPacket.bind(e.clients[0]!);
  e.clients[0]!.SendPacket = (p) => {
    expect(e.room.GetCurPlayer()).toBe(3);
    expect(() => e.table.DestroyPlayer(e.clients[3]!)).toThrow();
    send(p);
  };
  expect(e.table.DestroyPlayer(e.clients[4]!)).toBe(true);
  assertRemoved(e.clients[1]!);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  expect(e.room.GetCurPlayer()).toBe(3);
  expect(e.notices).toEqual([86]);
  expect(financial(e)).toEqual(before);
});

function successorScenario(manner = 0) {
  const e = create([1, 1, 2, 1, 1, 1], manner);
  if (manner)
    e.table.OnPacket(
      Received(new CSendPacket(100).Encode1(0x71)),
      e.clients[0]!,
    );
  start(e, 2);
  expect(e.table.DestroyPlayer(e.clients[0]!)).toBe(true);
  respond(e, 3, 1);
  respond(e, 4, 1);
  expect(e.room.m_ulBanTargetSerialNo).toBe(
    e.clients[2]!.m_aUser[0]!.GetGlobalSerialNo(),
  );
  expect(e.room.m_nChiefSlotidx).toBe(1);
  e.clear();
  return e;
}
test("LIVE legitimate two-stage chief succession: later chief leaves -> target is newly elected chief -> nested ejection performs TWO distinct Init samples", () => {
  const e = successorScenario(),
    values: number[] = [];
  e.clock.GetCurrentTime = () => {
    const n = (0xfffffffe + values.length) >>> 0;
    values.push(n);
    return n;
  };
  expect(e.table.DestroyPlayer(e.clients[1]!)).toBe(true);
  expect(values).toEqual([0xfffffffe, 0xffffffff]);
  assertRemoved(e.clients[2]!);
  expect(e.room.m_nChiefSlotidx).toBe(4);
  expect(e.room.GetCurPlayer()).toBe(3);
  expect(e.room.m_banChief.CaptureSnapshot().CanStartTime).toBe(0xffffffff);
});

test("LIVE waiting-chief odd121/3 while vote active:121 BEFORE root removal, then target(new chief) nested ejection, final odd setter AFTER both Init clocks", () => {
  const e = successorScenario(1);
  e.time(100);
  e.room.DeferBanChief();
  e.time(5101);
  e.room.DeferBanChief();
  expect(e.clients[1]!.packets.some((p) => p.m_nPacketType === 121)).toBe(true);
  e.clear();
  const reads: number[] = [];
  const send = e.clients[1]!.SendPacket.bind(e.clients[1]!);
  e.clients[1]!.SendPacket = (p) => {
    if (p.m_nPacketType === 121) expect(e.room.GetCurPlayer()).toBe(6);
    send(p);
  };
  e.clock.GetCurrentTime = () => {
    const n = 15102 + reads.length;
    reads.push(n);
    return n;
  };
  e.room.DeferBanChief();
  expect(reads).toEqual([15102, 15103, 15104]);
  assertRemoved(e.clients[1]!);
  assertRemoved(e.clients[2]!);
  expect(e.room.GetCurPlayer()).toBe(3);
  expect(e.room.m_banChief.CaptureSnapshot().CanStartTime).toBe(15104);
  expect(e.room.m_banChief.IsOddSlot()).toBe(false);
});

test("LIVE waiting-chief ready121/2 final SetCanStart has a THIRD reset-marker sample AFTER double Init; all clock faults occur before121/roster changes", () => {
  const e = successorScenario();
  expect(e.room.CanStartGame(true, e.room.m_nMapIdxPlaying)).toBe(0);
  e.time(100);
  e.room.DeferBanChief();
  e.time(20101);
  e.room.DeferBanChief();
  e.clear();
  const reads: number[] = [];
  e.clock.GetCurrentTime = () => {
    const n = 30102 + reads.length;
    reads.push(n);
    return n;
  };
  e.room.DeferBanChief();
  expect(reads).toEqual([30102, 30103, 30104, 30105, 30106]);
  assertRemoved(e.clients[1]!);
  assertRemoved(e.clients[2]!);
  expect(e.room.m_banChief.CaptureSnapshot().CanStartTime).toBe(30106);
  expect(e.room.m_banChief.IsCanStart()).toBe(false);
});

test("LIVE final clock fault discards entire prepared double-removal/helper: no121,IDs or SQL consumed; retry same vote remains possible", () => {
  const e = successorScenario();
  e.time(100);
  e.room.DeferBanChief();
  e.time(20101);
  e.room.DeferBanChief();
  e.clear();
  const before = financial(e),
    helper = e.room.m_banChief.CaptureSnapshot(),
    votes = [...e.room.m_anBanPlayerVote];
  let reads = 0;
  e.clock.GetCurrentTime = () => {
    if (++reads === 5) throw new Error("final setter fault");
    return 30102 + reads - 1;
  };
  expect(() => e.room.DeferBanChief()).toThrow("final setter fault");
  expect(e.room.GetCurPlayer()).toBe(6);
  expect(e.room.m_banChief.CaptureSnapshot()).toEqual(helper);
  expect([...e.room.m_anBanPlayerVote]).toEqual(votes);
  expect(e.clients.every((s) => !s.packets.length)).toBe(true);
  expect(financial(e)).toEqual(before);
});

test("LIVE codec fault and native/pre epoch reload during result-body preflight cannot install vote or remove any user", () => {
  for (const kind of ["throw", "pre"] as const) {
    const e = create([1, 1, 1]),
      target = e.clients[1]!.m_aUser[0]!,
      before = financial(e),
      encode = e.room.text.Encode.bind(e.room.text);
    e.room.text.Encode = (str) => {
      if (str === target.GetName()) {
        if (kind === "throw") throw new Error("result codec fault");
        e.clients[2]!.m_aUser[0]!.InstallPreInventory([]);
      }
      return encode(str);
    };
    // Immediate count2 split is pending, so113's name is preflighted too.
    expect(() => start(e)).toThrow();
    expect(e.room.m_ulBanTargetSerialNo).toBe(0);
    expect(e.room.GetCurPlayer()).toBe(3);
    expect(e.clients.every((s) => !s.packets.length)).toBe(true);
    expect(ChiefSQLState(e.session)).toEqual(before.SQL);
  }
});

test("LIVE public vote fields/DTO cannot manufacture owned state or table authority; direct DeleteAllUser/ghost/Mod/start/join are gated while legitimately pending", () => {
  const fake = create(),
    planned = fake.room.PrepareHostAskBanPlayer(fake.clients[0]!, {
      TargetSerialNo: fake.clients[1]!.m_aUser[0]!.GetGlobalSerialNo(),
      Immediate: 0,
    });
  fake.room.m_anBanPlayerVote.set(planned.After.Votes);
  fake.room.m_ulBanTargetSerialNo = planned.After.TargetSerialNo;
  expect(() => respond(fake, 2, 1)).toThrow("Unowned");
  expect(() => fake.table.DestroyPlayer(fake.clients[2]!)).toThrow();
  const e = create();
  start(e);
  expect(() => e.room.DeleteAllUser(e.clients[2]!)).toThrow();
  expect(() =>
    e.room.WithTablePlayerRemoval({}, e.clients[2]!, () => true),
  ).toThrow("issuer");
  expect(() => e.room.ValidateBanPlayerEjection({}, e.clients[2]!)).toThrow(
    "unissued",
  );
  expect(() => e.room.SendGameTypeMod()).toThrow("Mod switch during vote");
  expect(() =>
    e.table.OnPacket(Received(new CSendPacket(106)), e.clients[0]!),
  ).toThrow("launch during vote");
  const outsider = new MemoryClient();
  closes.push(() => outsider.Close());
  const u = new CUser(UserInfo("NewVoter"), 0xfedcba98);
  u.m_pClientSocket = outsider;
  outsider.m_aUser.push(u);
  e.table.DoJoinSession(outsider, e.room.m_nIdx, e.room.m_ulSerialNo, "", [0]);
  expect(outsider.Take(81).Decode1()).toBe(JoinSessionResult.Unavailable);
  expect(u.GetSessionIdx()).toBe(SessionLimit.NoSession);
});

test("LIVE both packet-body truncation/trailing data and non-chief requests fail before any vote state/publication, guard retires after failure", () => {
  const e = create();
  for (const p of [
    new CSendPacket(104),
    new CSendPacket(104).Encode4(1),
    new CSendPacket(104).Encode4(1).Encode1(1).Encode1(2),
  ])
    expect(() => e.table.OnPacket(Received(p), e.clients[0]!)).toThrow();
  expect(() =>
    e.table.OnPacket(Received(new CSendPacket(104)), e.clients[2]!),
  ).toThrow("Non-chief");
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  expect(e.clients.every((s) => !s.packets.length)).toBe(true);
  start(e);
  expect(e.room.m_ulBanTargetSerialNo).not.toBe(0);
});

test("LIVE unsupported playing/Mod scope and financial pending remain BEFORE plan callbacks/SQL, never a success reply", () => {
  for (const kind of ["playing", "mod", "financial"] as const) {
    const e = create(),
      before = financial(e);
    if (kind === "playing") e.room.m_bPlaying = true;
    else if (kind === "mod") Reflect.set(e.room, "m_nGameType", GameType.Mod);
    else e.room.IsGameplayCommitPending = () => true;
    e.clients[1]!.m_aUser[0]!.HasFunctionalItem = () => {
      throw new Error("MUST NOT QUERY");
    };
    expect(() => start(e)).toThrow();
    expect(e.room.m_ulBanTargetSerialNo).toBe(0);
    expect(e.clients.every((s) => !s.packets.length)).toBe(true);
    expect(financial(e)).toEqual(before);
  }
});

test("LIVE ejection service retained without consuming expires on return; no callback becomes future removal authority", () => {
  const e = create([2, 1]),
    services = Reflect.get(
      e.room,
      "removalServices",
    ) as import("../FXGS/CGameSession.ts").GameSessionRemovalServices,
    original = services.EjectBanPlayer!;
  let retained: (() => void) | undefined;
  Reflect.set(
    services,
    "EjectBanPlayer",
    (room: typeof e.room, socket: MemoryClient) => {
      retained = () => original(room, socket);
    },
  );
  expect(() => start(e)).toThrow("did not consume");
  expect(e.room.GetCurPlayer()).toBe(3);
  expect(() => retained!()).toThrow("unissued");
  expect(e.room.GetCurPlayer()).toBe(3);
  expect(e.clients.every((s) => !s.packets.length)).toBe(true);
  expect(Reflect.get(e.room, "PublishBanPlayerState")).toBeUndefined();
  expect(Reflect.get(e.room, "EjectLiveBanPlayer")).toBeUndefined();
});

test("LIVE consumed ejection service cannot be replayed twice, or retained for a later target even after failure; committed removal is not rolled back", () => {
  const e = create([2, 1]),
    services = Reflect.get(
      e.room,
      "removalServices",
    ) as import("../FXGS/CGameSession.ts").GameSessionRemovalServices,
    original = services.EjectBanPlayer!;
  let replay: (() => void) | undefined;
  Reflect.set(
    services,
    "EjectBanPlayer",
    (room: typeof e.room, socket: MemoryClient) => {
      replay = () => original(room, socket);
      original(room, socket);
      original(room, socket);
    },
  );
  expect(() => start(e)).toThrow("unissued");
  assertRemoved(e.clients[1]!);
  expect(e.room.GetCurPlayer()).toBe(2);
  expect(() => replay!()).toThrow("unissued");
  expect(
    e.clients[1]!.packets.filter((p) => p.m_nPacketType === 106),
  ).toHaveLength(1);
  expect(results(e.clients[0]!)).toEqual([]);
});

test("LIVE late same-byte native/pre reload at table service boundary rejects BEFORE ID clearing; published policy is not fraudulently rolled back or ACKed", () => {
  for (const kind of ["native", "pre"] as const) {
    const e = create([2, 1]),
      other = e.clients[0]!.m_aUser[0]!,
      services = Reflect.get(
        e.room,
        "removalServices",
      ) as import("../FXGS/CGameSession.ts").GameSessionRemovalServices,
      original = services.EjectBanPlayer!,
      sql = ChiefSQLState(e.session);
    other.InstallUserInventory([]);
    Reflect.set(
      services,
      "EjectBanPlayer",
      (room: typeof e.room, socket: MemoryClient) => {
        if (kind === "native") other.InstallUserInventory([]);
        else other.InstallPreInventory([]);
        original(room, socket);
      },
    );
    expect(() => start(e)).toThrow("generation changed");
    expect(e.room.GetCurPlayer()).toBe(3);
    expect(e.clients[1]!.m_aUser[0]!.GetSessionIdx()).toBe(e.room.m_nIdx);
    expect(e.clients.every((s) => !s.packets.length)).toBe(true);
    expect(ChiefSQLState(e.session)).toEqual(sql);
  }
});

test("LIVE transport failure is counted and other peers still get114, callback reentry cannot join/remove/respond, no duplicate replay on late105", () => {
  const e = create(),
    serial = start(e);
  e.clear();
  const chief = e.clients[0]!,
    send = chief.SendPacket.bind(chief);
  let attempts = 0;
  chief.SendPacket = (p) => {
    if (p.m_nPacketType === 114) {
      attempts++;
      expect(e.room.GetCurPlayer()).toBe(3);
      expect(() => e.table.DestroyPlayer(e.clients[3]!)).toThrow();
      expect(() => respond(e, 3, 1, serial)).toThrow();
      throw new Error("transport-not-an-ACK");
    }
    send(p);
  };
  respond(e, 2, 1);
  expect(attempts).toBe(1);
  expect(e.room.GetPacketPublicationFailureCount()).toBe(1);
  expect(results(e.clients[2]!)[0]!.Code).toBe(2);
  assertRemoved(e.clients[1]!);
  e.clear();
  respond(e, 3, 1, serial);
  expect(attempts).toBe(1);
  expect(e.clients.every((s) => !s.packets.length)).toBe(true);
});

test("LIVE preparation holds transition guard across native functional query; normal vote/departure/update reentry is refused and original plan still completes", () => {
  const e = create(),
    u = e.clients[1]!.m_aUser[0]!,
    real = u.HasFunctionalItem.bind(u);
  let calls = 0;
  u.HasFunctionalItem = (a) => {
    calls++;
    expect(() => e.table.DestroyPlayer(e.clients[3]!)).toThrow();
    expect(() => start(e)).toThrow();
    expect(() => e.room.DeferBanChief()).toThrow();
    return real(a);
  };
  start(e);
  expect(calls).toBe(1);
  expect(e.room.GetCurPlayer()).toBe(4);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
  expect(e.table.GetPendingBanPlayerCount()).toBe(1);
});

test("LIVE owned target/votes drift cannot be legitimized by DTO,ready flags or reflected deleting bool; financial freeze still rejects departure BEFORE membership mutation", () => {
  const e = create();
  start(e);
  Reflect.set(e.room, "m_bDeletingPlayerRecords", true);
  expect(() => e.room.DeleteAllUser(e.clients[2]!)).toThrow();
  Reflect.set(e.room, "m_bDeletingPlayerRecords", false);
  e.room.IsGameplayCommitPending = () => true;
  expect(() => e.table.DestroyPlayer(e.clients[2]!)).toThrow("frozen");
  expect(e.room.GetCurPlayer()).toBe(4);
  e.room.IsGameplayCommitPending = () => false;
  e.room.m_anBanPlayerVote[7] = 0xffffffff;
  expect(() => respond(e, 2, 1)).toThrow("Unowned");
  expect(() => e.table.DestroyPlayer(e.clients[2]!)).toThrow();
  expect(e.room.GetCurPlayer()).toBe(4);
  expect(e.room.IsWaitingChiefScheduled()).toBe(false);
});

test("LIVE113 preserves nonconsecutive duplicate sockets using LEGITIMATE pre-vote slot reuse, not synthetic row reordering", () => {
  const e = create([1, 1, 1, 1, 1, 1]);
  e.table.DestroyPlayer(e.clients[2]!);
  e.table.DestroyPlayer(e.clients[4]!);
  const pair = new MemoryClient();
  closes.push(() => pair.Close());
  for (let i = 0; i < 2; i++) {
    const u = new CUser(UserInfo(`HolePair${i}`), 0xfedcba90 + i);
    u.m_pClientSocket = pair;
    pair.m_aUser.push(u);
  }
  e.table.DoJoinSession(pair, e.room.m_nIdx, e.room.m_ulSerialNo, "", [0, 0]);
  expect(pair.m_aUser.map((u) => u.m_nSlotIdx)).toEqual([2, 4]);
  e.clear();
  pair.Clear();
  start(e);
  expect(pair.packets.filter((p) => p.m_nPacketType === 113)).toHaveLength(2);
  expect(
    e.clients[3]!.packets.filter((p) => p.m_nPacketType === 113),
  ).toHaveLength(1);
  expect(e.room.HasActiveBanPlayerVote()).toBe(true);
});

test("LIVE target/second removal invalid ghost image or fallible chief clock preflights before any group IDs are changed", () => {
  const e = create([2, 2, 1, 1]);
  e.clients[1]!.m_aUser[0]!.InstallUserInventory([
    NativeInventory({ strAttr: BanPlayerRule.BanReflexAttribute }),
  ]);
  const sql = ChiefSQLState(e.session),
    helper = e.room.m_banChief.CaptureSnapshot();
  e.clock.GetCurrentTime = () => {
    throw new Error("chief clock fault");
  };
  expect(() => start(e)).toThrow("chief clock fault");
  expect(e.room.GetCurPlayer()).toBe(6);
  expect(e.room.m_banChief.CaptureSnapshot()).toEqual(helper);
  expect(e.clients.every((s) => !s.packets.length)).toBe(true);
  expect(ChiefSQLState(e.session)).toEqual(sql);
  e.clock.GetCurrentTime = () => 100;
  e.room.m_anSlotGhost[3] = 0;
  e.room.m_anGhostSlot[0] = -1;
  expect(() => start(e)).toThrow("ghost mapping");
  expect(e.room.GetCurPlayer()).toBe(6);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
});

test("LIVE nested removal restores RAW outer removing boolean BEFORE its table service returns; packet-batch ownership is not a substitute for that guard", () => {
  const e = create([1, 2, 1, 1, 1]);
  start(e);
  respond(e, 2, 1);
  const services = Reflect.get(
      e.room,
      "removalServices",
    ) as import("../FXGS/CGameSession.ts").GameSessionRemovalServices,
    original = services.EjectBanPlayer!;
  let checked = 0;
  Reflect.set(
    services,
    "EjectBanPlayer",
    (room: typeof e.room, socket: MemoryClient) => {
      original(room, socket);
      checked++;
      expect(Reflect.get(room, "m_bRemovingPlayer")).toBe(true);
      expect(room.IsRemovingPlayer()).toBe(true);
    },
  );
  expect(e.table.DestroyPlayer(e.clients[4]!)).toBe(true);
  expect(checked).toBe(1);
  expect(Reflect.get(e.room, "m_bRemovingPlayer")).toBe(false);
  expect(e.room.IsRemovingPlayer()).toBe(false);
});

test("LIVE financial freeze rejects BEFORE functional lookup/body generation, not merely because a later callback happens to fail", () => {
  const e = create(),
    sql = ChiefSQLState(e.session);
  let reads = 0;
  e.room.IsGameplayCommitPending = () => true;
  e.clients[1]!.m_aUser[0]!.HasFunctionalItem = () => {
    reads++;
    return false;
  };
  expect(() => start(e)).toThrow("frozen financial/result");
  expect(reads).toBe(0);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  expect(ChiefSQLState(e.session)).toEqual(sql);
});

test("LIVE actual Center same-value pending ABA in native functional comparator is rejected by opaque generation before ballots or packets install", () => {
  const e = create(),
    peer = e.clients[3]!,
    old = peer.m_aUser[0]!,
    owner = new CenterUser(old.m_userInfo, old.GetGlobalSerialNo());
  owner.m_pClientSocket = peer;
  owner.m_nSlotIdx = old.m_nSlotIdx;
  owner.m_nSessionIdx = old.m_nSessionIdx;
  owner.m_nSessionSerialNo = old.m_nSessionSerialNo;
  peer.m_aUser[0] = owner;
  e.room.m_rgPlayer[owner.m_nSlotIdx] = owner;
  const generation = owner.GetConnectionGeneration(),
    sql = ChiefSQLState(e.session);
  e.clients[1]!.m_aUser[0]!.HasFunctionalItem = () => {
    owner.m_pendingConnection = undefined;
    return false;
  };
  expect(() => start(e)).toThrow("generation changed");
  expect(owner.GetConnectionGeneration()).not.toBe(generation);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  expect(e.clients.every((s) => !s.packets.length)).toBe(true);
  expect(ChiefSQLState(e.session)).toEqual(sql);
});

test("LIVE coherent ghost-image drift during chief-clock preflight is fenced BEFORE table clears IDs, not silently adopted as a different removal plan", () => {
  const e = create([2, 2, 1, 1]);
  e.clients[1]!.m_aUser[0]!.InstallUserInventory([
    NativeInventory({ strAttr: BanPlayerRule.BanReflexAttribute }),
  ]);
  const sql = ChiefSQLState(e.session),
    helper = e.room.m_banChief.CaptureSnapshot();
  e.clock.GetCurrentTime = () => {
    e.room.m_anSlotGhost[5] = 0;
    e.room.m_anGhostSlot[0] = 5;
    return 100;
  };
  expect(() => start(e)).toThrow("changed during preparation");
  expect(e.room.GetCurPlayer()).toBe(6);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  expect(
    e.clients.every((s) =>
      s.m_aUser.every((u) => u.GetSessionIdx() === e.room.m_nIdx),
    ),
  ).toBe(true);
  expect(e.room.m_banChief.CaptureSnapshot()).toEqual(helper);
  expect(e.clients.every((s) => !s.packets.length)).toBe(true);
  expect(ChiefSQLState(e.session)).toEqual(sql);
});
