import { afterEach, expect, test } from "bun:test";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CTextCodec } from "../Common/CTextCodec.ts";
import { CUser } from "../Common/CUser.ts";
import { UserInfo } from "./helpers/Accounts.ts";
import { CUser as CenterUser } from "../Center/CUser.ts";
import {
  BanChiefRule,
  BanPlayerRule,
  ChannelType,
  GameType,
} from "../Common/OfficialValues.ts";
import { ClientRequest } from "../Common/Protocol/PacketTypes.ts";
import { GameLaunchFixture } from "./helpers/GameLaunch.ts";
import { ChiefSQLState } from "./helpers/WaitingChief.ts";
import { NativeInventory } from "./helpers/UserInventory.ts";
import { MemoryClient, Received } from "./helpers/Clients.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function create(
  groups: readonly number[] = [1, 1, 1, 1],
  channel: number = ChannelType.Normal,
) {
  const e = GameLaunchFixture(groups, channel);
  cleanup.push(e.close);
  return e;
}
function target(e: ReturnType<typeof create>) {
  return e.clients[1]!.m_aUser[0]!.GetGlobalSerialNo();
}
function request(e: ReturnType<typeof create>, immediate = 0) {
  return { TargetSerialNo: target(e), Immediate: immediate };
}
function state(e: ReturnType<typeof create>) {
  return {
    Observation: e.room.CaptureBanPlayerObservation(),
    SlotInfo: e.room.m_rgSlotInfo.map((b) => b.toString("hex")),
    Matrix: Array.from(e.room.m_adwOpaqueSlotMatrix),
    BanChief: e.room.m_banChief.CaptureSnapshot(),
    Launch: e.room.GetGameLaunchState(),
    SQL: ChiefSQLState(e.session),
    Sockets: e.clients.map((s) => ({
      Pool: s.m_nPoolType,
      Closed: s.m_bClosed,
      Packets: s.packets.length,
      Users: s.m_aUser.map((u) => ({
        SerialNo: u.GetGlobalSerialNo(),
        Slot: u.m_nSlotIdx,
        Session: u.GetSessionIdx(),
        RoomSerial: u.GetSessionSerialNo(),
        Free: u.IsSetFree(),
        Dynamic: u.GetDynamicInfoSnapshot(),
        Pair: u.CaptureUserInventoryInitialization(),
        Owned: u.GetUserInventoryGeneration(),
        Pre: u.GetPreInventoryGeneration(),
      })),
    })),
  };
}
function activeFixture(e: ReturnType<typeof create>, votes: readonly number[]) {
  // Explicit trusted DATA fixture, not dispatch, authorized restoration or a
  // claim that live104/105 is enabled. Preparations must NOT install it.
  e.room.m_ulBanTargetSerialNo = target(e);
  e.room.m_anBanPlayerVote.set(votes);
}
function noClock(e: ReturnType<typeof create>) {
  e.clock.GetCurrentTime = () => {
    throw new Error("READ-SIDE MUST NOT SAMPLE A CLOCK");
  };
}

test("actual80/81/96 room prepares native vote/defer/respond/departure plans with ZERO dispatch,packets,clock,IDs,slot flags,helper,launch,inventory,dynamic,SQL or receipt changes", () => {
  const e = create(),
    before = state(e);
  noClock(e);
  const p = e.room.PrepareHostAskBanPlayer(e.clients[0]!, request(e));
  expect(p.After.TargetSerialNo).toBe(target(e));
  expect(p.After.Votes).toEqual([2, 0, 1, 1, 0, 0, 0, 0]);
  expect(p.Messages.map((p) => p.Message.Kind)).toEqual(["Question", "Result"]);
  expect(
    e.room.PrepareRespondToBanPlayer(e.clients[2]!, {
      TargetSerialNo: target(e),
      Answer: 1,
    }).DeferCalls,
  ).toBe(0);
  expect(e.room.PrepareDeferBanPlayer().Messages[0]!.Message).toEqual({
    Kind: "Result",
    Code: 4,
  });
  expect(
    e.room.PrepareBanPlayerAfterDeparture(e.clients[0]!).Remaining.ChiefSlot,
  ).toBe(1);
  expect(state(e)).toEqual(before);
});

test("actual native owned SuperChief on SECOND chief local,Amount0/Slot255/negative DATE/expired-looking level: prepares immediate target-WHOLE-group intent without grant/consumption or BanReflex query", () => {
  const e = create([2, 2, 1, 1]),
    chief = e.clients[0]!,
    victim = e.clients[1]!;
  chief.m_aUser[1]!.InstallUserInventory([
    NativeInventory({
      strAttr: BanChiefRule.SuperChiefAttribute,
      Amount: 0,
      Slot: 255,
      DateCreated: -1.75,
      LevelCreated: -32768,
    }),
  ]);
  victim.m_aUser[0]!.HasFunctionalItem = () => {
    throw new Error("SuperChief must precede BanReflex");
  };
  const before = state(e);
  noClock(e);
  const p = e.room.PrepareHostAskBanPlayer(chief, request(e, 255));
  expect(p.Eject!.SocketKey).toBe(1);
  expect(p.Messages[0]!.Message).toEqual({ Kind: "Result", Code: 4 });
  expect(p.Messages[0]!.Recipients).toEqual([0, 2, 3]);
  expect(state(e)).toEqual(before);
});

test("actual native owned BanReflex on SECOND target local reflects WHOLE chief pair and names current chief secondary, with NO financial or CBanChief Init effect", () => {
  const e = create([2, 2, 1, 1]);
  e.room.SetChiefSlotidx(1);
  e.clients[1]!.m_aUser[1]!.InstallUserInventory([
    NativeInventory({
      strAttr: BanPlayerRule.BanReflexAttribute,
      Amount: 0,
      Slot: 255,
      DateCreated: -1.75,
    }),
  ]);
  const before = state(e);
  noClock(e);
  const p = e.room.PrepareHostAskBanPlayer(e.clients[0]!, request(e));
  expect(p.Eject).toEqual({
    Slot: 1,
    SocketKey: 0,
    IncludeSelf: true,
    NativePoolType: 4,
  });
  expect(p.Messages[0]!.Message).toEqual({
    Kind: "Result",
    Code: 5,
    Name: e.clients[0]!.m_aUser[1]!.GetName(),
  });
  expect(p.Messages[0]!.Recipients).toEqual([1, 2, 3]);
  expect(state(e)).toEqual(before);
});

test("real Category2 / EXACT encoded functional attribute only: wrong category,case and suffix do NOT reflect or become immediate; SQL Authority21/22/23/25 is not permission", () => {
  for (const row of [
    { Category: 1, strAttr: BanPlayerRule.BanReflexAttribute },
    { Category: 2, strAttr: "item/BanReflex" },
    { Category: 2, strAttr: "Item/BanReflexX" },
  ]) {
    const e = create(),
      user = e.clients[1]!.m_aUser[0]!;
    user.InstallUserInventory([NativeInventory(row)]);
    for (const u of e.clients[0]!.m_aUser) u.m_userInfo.Authority = 0xffffffff;
    const before = state(e);
    const p = e.room.PrepareHostAskBanPlayer(e.clients[0]!, request(e, 1));
    expect(p.Eject).toBeNull();
    expect(p.Messages[0]!.Message.Kind).toBe("Question");
    expect(state(e)).toEqual(before);
  }
});

test("legacy SQL inventory and pre-inventory rows NEVER substitute native Category2 owned functional items, even if numeric IDs/names look like BanReflex/SuperChief", () => {
  const e = create(),
    chief = e.clients[0]!.m_aUser[0]!,
    victim = e.clients[1]!.m_aUser[0]!;
  chief.m_aInventory = [
    {
      SN: 7,
      ID: chief.GetName(),
      ItemID: 7,
      Slot: 0,
      Amount: 1,
      ExpireDate: 0,
      Verbose: BanChiefRule.SuperChiefAttribute,
      CreatedAt: 0,
    },
  ];
  victim.m_aInventory = [
    {
      SN: 7,
      ID: victim.GetName(),
      ItemID: 7,
      Slot: 0,
      Amount: 1,
      ExpireDate: 0,
      Verbose: BanPlayerRule.BanReflexAttribute,
      CreatedAt: 0,
    },
  ];
  chief.InstallPreInventory([
    {
      SN: 7,
      Type: 2,
      ItemSn: 7,
      StockSn: 7,
      Slot: 0,
      Amount: 1,
      ValidityPeriod: -1,
      ValidityLevel: -1,
      Description: BanChiefRule.SuperChiefAttribute,
      strAttr: BanChiefRule.SuperChiefAttribute,
    },
  ]);
  victim.InstallPreInventory([
    {
      SN: 7,
      Type: 2,
      ItemSn: 7,
      StockSn: 7,
      Slot: 0,
      Amount: 1,
      ValidityPeriod: -1,
      ValidityLevel: -1,
      Description: BanPlayerRule.BanReflexAttribute,
      strAttr: BanPlayerRule.BanReflexAttribute,
    },
  ]);
  const before = state(e),
    p = e.room.PrepareHostAskBanPlayer(e.clients[0]!, request(e, 1));
  expect(p.Eject).toBeNull();
  expect(p.Messages[0]!.Message.Kind).toBe("Question");
  expect(state(e)).toEqual(before);
});

test("prepared respond preserves native partial-prefix semantics as detached state, NEVER applies the prefix to a live room", () => {
  const e = create([1, 1, 2]);
  activeFixture(e, [2, 0, 1, 3, 0, 0, 0, 0]);
  const before = state(e);
  noClock(e);
  const p = e.room.PrepareRespondToBanPlayer(e.clients[2]!, {
    TargetSerialNo: target(e),
    Answer: 255,
  });
  expect(p.After.Votes).toEqual([2, 0, 2, 3, 0, 0, 0, 0]);
  expect(p.DeferCalls).toBe(0);
  expect(state(e)).toEqual(before);
});

test("prepared post-departure can predict second chief removal / TWO Init calls; neither removal,Init,clock nor publication executes", () => {
  const e = create([2, 2, 1]);
  activeFixture(e, [2, 2, 0, 0, 2, 0, 0, 0]);
  const before = state(e);
  noClock(e);
  const p = e.room.PrepareBanPlayerAfterDeparture(e.clients[0]!);
  expect(p.ChiefInitializations).toBe(2);
  expect(p.Remaining.ChiefSlot).toBe(2);
  expect(p.Decision!.Eject!.SocketKey).toBe(1);
  expect(p.Decision!.Messages[0]!.Message).toEqual({
    Kind: "Result",
    Code: 2,
    Name: e.clients[1]!.m_aUser[0]!.GetName(),
  });
  expect(state(e)).toEqual(before);
});

test("prepared busy response never reads request getters; rejected current/nonchief/outside-group inputs leave room/SQL untouched", () => {
  const e = create();
  activeFixture(e, [2, 0, 1, 1, 0, 0, 0, 0]);
  const before = state(e),
    never = {
      get TargetSerialNo(): number {
        throw new Error("busy request not reached");
      },
      get Immediate(): number {
        throw new Error("busy request not reached");
      },
    };
  expect(
    e.room.PrepareHostAskBanPlayer(e.clients[0]!, never).Messages[0]!.Message,
  ).toEqual({ Kind: "Result", Code: 1 });
  expect(() => e.room.PrepareHostAskBanPlayer(e.clients[2]!, never)).toThrow(
    "Non-chief",
  );
  const outside = new MemoryClient();
  cleanup.push(() => outside.Close());
  expect(() =>
    e.room.PrepareRespondToBanPlayer(outside, { TargetSerialNo: 0, Answer: 0 }),
  ).toThrow("outside room");
  expect(() => e.room.PrepareBanPlayerAfterDeparture(outside)).toThrow(
    "outside room",
  );
  expect(state(e)).toEqual(before);
});

test("read-only prepared DTO remains NOT installed or authority; copying its public fields cannot issue a live105/departure", () => {
  const e = create(),
    before = state(e),
    p = e.room.PrepareHostAskBanPlayer(e.clients[0]!, request(e));
  expect(p.After.TargetSerialNo).toBe(target(e));
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  expect(state(e)).toEqual(before);
  e.room.m_anBanPlayerVote.set(p.After.Votes);
  e.room.m_ulBanTargetSerialNo = p.After.TargetSerialNo;
  const copied = state(e);
  expect(() =>
    e.room.OnPacket(
      Received(
        new CSendPacket(ClientRequest.RespondToBanPlayer)
          .Encode4(target(e))
          .Encode1(1),
      ),
      e.clients[2]!,
    ),
  ).toThrow("Unowned");
  expect(() => e.table.DestroyPlayer(e.clients[2]!)).toThrow();
  expect(state(e)).toEqual(copied);
});

test("unowned public pending-vote removal and launch fences remain: observation does NOT authorize a table cascade or bypass unavailable native playing path", () => {
  const e = create();
  activeFixture(e, [2, 0, 1, 1, 0, 0, 0, 0]);
  const before = state(e);
  expect(
    e.room.PrepareBanPlayerAfterDeparture(e.clients[2]!).Decision,
  ).not.toBeNull();
  expect(() => e.table.DestroyPlayer(e.clients[2]!, true)).toThrow(
    "pending vote cascades",
  );
  expect(() =>
    e.room.OnPacket(
      Received(new CSendPacket(ClientRequest.RequestStartGame)),
      e.clients[0]!,
    ),
  ).toThrow("Unowned");
  expect(state(e)).toEqual(before);
});

test("ordinary departure model does NOT claim Guild/Mod/BangPok/practice succession", () => {
  const guild = create([1, 1]);
  // Trusted scope fixture; real Guild creation remains refused at the table.
  Reflect.set(guild.room, "channelType", ChannelType.Guild);
  expect(() =>
    guild.room.PrepareBanPlayerAfterDeparture(guild.clients[0]!),
  ).toThrow("Nonordinary");
  const mod = create([1, 1]);
  Reflect.set(mod.room, "m_nGameType", GameType.Mod);
  expect(() =>
    mod.room.PrepareBanPlayerAfterDeparture(mod.clients[0]!),
  ).toThrow("Nonordinary");
  const bang = create([1, 1]);
  bang.room.m_bBangPok = true;
  expect(() =>
    bang.room.PrepareBanPlayerAfterDeparture(bang.clients[0]!),
  ).toThrow("Only ordinary");
  const practice = create([1, 1]);
  Reflect.set(practice.room, "m_nIdx", 10000);
  for (const u of practice.clients.flatMap((s) => s.m_aUser))
    u.m_nSessionIdx = 10000;
  expect(() =>
    practice.room.PrepareBanPlayerAfterDeparture(practice.clients[0]!),
  ).toThrow("Only ordinary");
});

test("reentrant preparation is refused during functional query and guard is released after throw; no half-plan,packet,helper or SQL mutation", () => {
  const e = create(),
    user = e.clients[1]!.m_aUser[0]!,
    original = user.HasFunctionalItem.bind(user),
    before = state(e);
  user.HasFunctionalItem = () => {
    e.room.PrepareDeferBanPlayer();
    return false;
  };
  expect(() =>
    e.room.PrepareHostAskBanPlayer(e.clients[0]!, request(e)),
  ).toThrow("Reentrant");
  expect(state(e)).toEqual(before);
  user.HasFunctionalItem = original;
  expect(
    e.room.PrepareHostAskBanPlayer(e.clients[0]!, request(e)).Messages[0]!
      .Message.Kind,
  ).toBe("Question");
  expect(state(e)).toEqual(before);
});

test("full vote-array drift is fenced, even when target/chief/roster stay identical (waiting fingerprint alone is insufficient)", () => {
  const e = create(),
    user = e.clients[1]!.m_aUser[0]!,
    sql = ChiefSQLState(e.session),
    helper = e.room.m_banChief.CaptureSnapshot();
  user.HasFunctionalItem = () => {
    e.room.m_anBanPlayerVote[7] = 0xffffffff;
    return false;
  };
  expect(() =>
    e.room.PrepareHostAskBanPlayer(e.clients[0]!, request(e)),
  ).toThrow("state changed");
  expect(e.room.m_anBanPlayerVote[7]).toBe(0xffffffff);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  expect(e.clients.every((s) => s.packets.length === 0)).toBe(true);
  expect(e.room.m_banChief.CaptureSnapshot()).toEqual(helper);
  expect(ChiefSQLState(e.session)).toEqual(sql);
});

test("whole-room generation fence catches equal-byte native owned reload on a NONQUERY other voter, without financial/packet effects", () => {
  const e = create(),
    victim = e.clients[1]!.m_aUser[0]!,
    other = e.clients[3]!.m_aUser[0]!;
  other.InstallUserInventory([]);
  const revision = other.GetUserInventoryGeneration().Revision,
    sql = ChiefSQLState(e.session);
  victim.HasFunctionalItem = () => {
    other.InstallUserInventory([]);
    return false;
  };
  expect(() =>
    e.room.PrepareHostAskBanPlayer(e.clients[0]!, request(e)),
  ).toThrow("generation changed");
  expect(other.GetUserInventoryGeneration().Revision).toBe(revision + 1);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  expect(e.clients.every((s) => !s.packets.length)).toBe(true);
  expect(ChiefSQLState(e.session)).toEqual(sql);
});

test("whole-room fence catches pre-only equal-byte reload and native->legacy replacement independently", () => {
  for (const kind of ["pre", "legacy"] as const) {
    const e = create(),
      victim = e.clients[1]!.m_aUser[0]!,
      other = e.clients[3]!.m_aUser[0]!;
    other.InstallUserInventory([]);
    const sql = ChiefSQLState(e.session);
    victim.HasFunctionalItem = () => {
      if (kind === "pre") other.InstallPreInventory([]);
      else other.m_aInventory = [];
      return false;
    };
    expect(() =>
      e.room.PrepareHostAskBanPlayer(e.clients[0]!, request(e)),
    ).toThrow("generation changed");
    expect(e.room.m_ulBanTargetSerialNo).toBe(0);
    expect(e.clients.every((s) => !s.packets.length)).toBe(true);
    expect(ChiefSQLState(e.session)).toEqual(sql);
  }
});

test("actual Center opaque pending ABA is fenced despite identical common/native data; observation epoch is NOT authorization", () => {
  const e = create(),
    peer = e.clients[3]!,
    prior = peer.m_aUser[0]!,
    owner = new CenterUser(prior.m_userInfo, prior.GetGlobalSerialNo());
  owner.m_pClientSocket = peer;
  owner.m_nSlotIdx = prior.m_nSlotIdx;
  owner.m_nSessionIdx = prior.m_nSessionIdx;
  owner.m_nSessionSerialNo = prior.m_nSessionSerialNo;
  peer.m_aUser[0] = owner;
  e.room.m_rgPlayer[owner.m_nSlotIdx] = owner;
  const epoch = owner.GetConnectionGeneration(),
    sql = ChiefSQLState(e.session);
  e.clients[1]!.m_aUser[0]!.HasFunctionalItem = () => {
    owner.m_pendingConnection = undefined;
    return false;
  };
  expect(() =>
    e.room.PrepareHostAskBanPlayer(e.clients[0]!, request(e)),
  ).toThrow("generation changed");
  expect(owner.GetConnectionGeneration()).not.toBe(epoch);
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  expect(e.clients.every((s) => !s.packets.length)).toBe(true);
  expect(ChiefSQLState(e.session)).toEqual(sql);
});

test("whole-group identity changes,actual room-slot ownership drift and transport-pool drift are independently refused before a plan escapes", () => {
  for (const kind of ["group", "slot", "pool", "closed"] as const) {
    const e = create(),
      victim = e.clients[1]!.m_aUser[0]!,
      other = e.clients[3]!.m_aUser[0]!,
      sql = ChiefSQLState(e.session);
    victim.HasFunctionalItem = () => {
      if (kind === "group") e.clients[3]!.m_aUser.length = 0;
      else if (kind === "slot") other.m_nSlotIdx = 7;
      else e.clients[3]!.m_nPoolType = "SessionRemoved";
      return false;
    };
    expect(() =>
      e.room.PrepareHostAskBanPlayer(e.clients[0]!, request(e)),
    ).toThrow();
    expect(e.room.m_ulBanTargetSerialNo).toBe(0);
    expect(e.clients.every((s) => !s.packets.length)).toBe(true);
    expect(ChiefSQLState(e.session)).toEqual(sql);
  }
});

test("changing a request through a getter is caught by source fence AFTER pure planning: chief/name/target source mutation is NOT accepted as a new authority", () => {
  const e = create(),
    sql = ChiefSQLState(e.session),
    serial = target(e),
    r = {
      get TargetSerialNo() {
        e.room.m_nChiefSlotidx = 2;
        return serial;
      },
      Immediate: 0,
    };
  expect(() => e.room.PrepareHostAskBanPlayer(e.clients[0]!, r)).toThrow(
    "state changed",
  );
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  expect(e.clients.every((s) => !s.packets.length)).toBe(true);
  expect(ChiefSQLState(e.session)).toEqual(sql);
});

test("functional comparator codec can throw: native rows/SQL untouched and guard releases for subsequent successful preparation", () => {
  const e = create(),
    user = e.clients[1]!.m_aUser[0]!,
    codec = new CTextCodec();
  user.InstallUserInventory(
    [NativeInventory({ strAttr: BanPlayerRule.BanReflexAttribute })],
    {},
    codec,
  );
  const encode = codec.Encode.bind(codec),
    before = state(e);
  codec.Encode = () => {
    throw new Error("intentional comparator fault");
  };
  expect(() =>
    e.room.PrepareHostAskBanPlayer(e.clients[0]!, request(e)),
  ).toThrow("intentional comparator fault");
  expect(state(e)).toEqual(before);
  codec.Encode = encode;
  expect(
    e.room.PrepareHostAskBanPlayer(e.clients[0]!, request(e)).Messages[0]!
      .Message,
  ).toEqual({
    Kind: "Result",
    Code: 5,
    Name: e.clients[0]!.m_aUser[0]!.GetName(),
  });
  expect(state(e)).toEqual(before);
});

test("room-generation change cannot be hidden by updating EVERY user tuple to the same new serial while primitive voting data stays identical", () => {
  const e = create(),
    serial = e.room.m_ulSerialNo,
    sql = ChiefSQLState(e.session);
  e.clients[1]!.m_aUser[0]!.HasFunctionalItem = () => {
    Reflect.set(e.room, "m_ulSerialNo", serial + 1);
    for (const u of e.clients.flatMap((s) => s.m_aUser))
      u.m_nSessionSerialNo = serial + 1;
    return false;
  };
  expect(() =>
    e.room.PrepareHostAskBanPlayer(e.clients[0]!, request(e)),
  ).toThrow("ownership changed");
  expect(e.room.m_ulBanTargetSerialNo).toBe(0);
  expect(e.clients.every((s) => !s.packets.length)).toBe(true);
  expect(ChiefSQLState(e.session)).toEqual(sql);
});

test("phase/BangPok/strategy-context drift rejects observational preparation without pretending to execute or roll back the injected outside mutation", () => {
  for (const field of [
    "m_bPlaying",
    "m_bBangPok",
    "m_nGameType",
    "channelType",
  ] as const) {
    const e = create(),
      sql = ChiefSQLState(e.session);
    e.clients[1]!.m_aUser[0]!.HasFunctionalItem = () => {
      Reflect.set(
        e.room,
        field,
        field === "m_nGameType"
          ? GameType.Mod
          : field === "channelType"
            ? ChannelType.Guild
            : true,
      );
      return false;
    };
    expect(() =>
      e.room.PrepareHostAskBanPlayer(e.clients[0]!, request(e)),
    ).toThrow("ownership changed");
    expect(e.room.m_ulBanTargetSerialNo).toBe(0);
    expect(e.clients.every((s) => !s.packets.length)).toBe(true);
    expect(ChiefSQLState(e.session)).toEqual(sql);
  }
});

test("cold real-app diagnostics explicitly retain unsupported vote scopes and both completion/client flagsfalse; ordinary waiting-only integration adds NO completion flag", async () => {
  const { CServerApp } = await import("../CServerApp.ts"),
    { TestConfig } = await import("./helpers/Accounts.ts"),
    app = new CServerApp(TestConfig());
  try {
    const status = app.GetStatus();
    expect(status.completeOfficialRewrite).toBe(false);
    expect(status.officialClientVerified).toBe(false);
    expect(status.processReady).toBe(false);
    expect(status.unported).toContain(
      "Mod combat/captain cascade/result; guild/BangPok/practice vote and restart restoration",
    );
    expect(
      status.gameUpdate.every(
        (g) =>
          !g.running &&
          g.waitingChiefRooms === 0 &&
          g.waitingChiefWarningFailures === 0,
      ),
    ).toBe(true);
    expect(app.m_dbSession.db.query("PRAGMA user_version").get()).toEqual({
      user_version: 6,
    });
  } finally {
    await app.CleanUp();
  }
});

test("whole-group capture rejects source secondary outside room,sparse locals and duplicate user identities BEFORE any functional query", () => {
  for (const kind of ["outsider", "sparse", "duplicate"] as const) {
    const e = create(),
      peer = e.clients[1]!,
      primary = peer.m_aUser[0]!,
      sql = ChiefSQLState(e.session);
    if (kind === "sparse") peer.m_aUser.length = 2;
    else if (kind === "duplicate") peer.m_aUser.push(primary);
    else {
      const outsider = new CUser(UserInfo("OutsideOnly"), 0xfedcba98);
      outsider.m_pClientSocket = peer;
      peer.m_aUser.push(outsider);
    }
    primary.HasFunctionalItem = () => {
      throw new Error("must not query an invalid group");
    };
    expect(() =>
      e.room.PrepareHostAskBanPlayer(e.clients[0]!, request(e)),
    ).toThrow("incomplete local group");
    expect(e.room.m_ulBanTargetSerialNo).toBe(0);
    expect(e.clients.every((s) => !s.packets.length)).toBe(true);
    expect(ChiefSQLState(e.session)).toEqual(sql);
  }
});
