import { afterEach, expect, test } from "bun:test";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CReceivedPacketBase } from "../Common/CReceivedPacketBase.ts";
import { CTextCodec } from "../Common/CTextCodec.ts";
import { CUser } from "../Common/CUser.ts";
import {
  CProtocolError,
  CUnsupportedOperation,
} from "../Common/CProtocolError.ts";
import {
  GameStage,
  GamePlayerState,
  UserDynamicRule,
} from "../Common/OfficialValues.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";
import { EventItemAnnouncement } from "../Common/Protocol/OfficialMessages.ts";
import { CItemAttr } from "../FXGS/CItemAttr.ts";
import { CPeImage, OFFICIAL_SERVICES } from "../Tools/OfficialSource.ts";
import { UserInfo } from "./helpers/Accounts.ts";
import {
  DiscoverLaunchPeer,
  GameLaunchFixture,
  LaunchItems,
  LaunchReadyPacket,
} from "./helpers/GameLaunch.ts";
import { Received } from "./helpers/Clients.ts";
import vectors from "./fixtures/item-pickup-vectors.json";

const names = ["Alice", "Partner", "Bob"] as const;
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function create(start = true, items?: CItemAttr) {
  const e = GameLaunchFixture([2, 1], undefined, () => 1, 100, undefined, {
    UserNames: names,
    ...(items ? { Items: items } : {}),
  });
  cleanup.push(e.close);
  if (start) {
    loading(e);
    running(e);
  }
  return e;
}
type Environment = ReturnType<typeof GameLaunchFixture>;
function loading(e: Environment) {
  e.table.OnPacket(Received(new CSendPacket(106)), e.clients[0]!);
  expect(e.room.IsLoadingGame()).toBe(true);
  e.clear();
}
function running(e: Environment) {
  for (const [i, peer] of e.clients.entries()) {
    DiscoverLaunchPeer(e.room, peer, 42000 + i);
    e.table.OnPacket(Received(LaunchReadyPacket(e.room, peer)), peer);
  }
  expect(e.room.m_nGameState).toBe(GameStage.Running);
  expect(e.room.GetGameLaunchState().NativeLaunch).toBe(true);
  expect(e.room.GetResultRoundID()).toBeDefined();
  e.clear();
}
function sourcePacket(hex: string) {
  return new CReceivedPacketBase(Buffer.from(hex, "hex"), 1);
}
function send(e: Environment, packet: CSendPacket, sender = 0) {
  e.table.OnPacket(Received(packet), e.clients[sender]!);
}
function sendSource(e: Environment, hex: string, slot: number) {
  e.table.OnPacket(sourcePacket(hex), e.clients[slot < 2 ? 0 : 1]!);
}
/** Test cursor ONLY: synthetic0 prefix is consumed before a trusted direct call.
 * It is NOT a claimed/recovered client opcode or network dispatch route. */
function throwCursor(bodyHex: string) {
  const p = sourcePacket("5a" + bodyHex);
  expect(p.Decode1()).toBe(0);
  return p;
}
function throwFields(e: Environment, fields: readonly number[], sender = 0) {
  const p = new CSendPacket(0);
  for (const field of fields) p.Encode1(field);
  const input = Received(p);
  input.Decode1();
  e.room.OnItemThrow(input, e.clients[sender]!);
}
function packets(e: Environment, expected?: string | null) {
  for (const peer of e.clients)
    expect(peer.packets.map((p) => p.m_pBlock.toString("hex"))).toEqual(
      expected ? [expected] : [],
    );
  e.clear();
}
function wallets(e: Environment) {
  return e.room.m_rgPlayer.map(
    (user) =>
      user && {
        Live: user.GetDynamicInfoSnapshot(),
        Stored: e.db.GetUserInfo(user.GetName()),
        Inventory: structuredClone(user.m_aInventory),
      },
  );
}
function snapshot(e: Environment) {
  const ctx = e.room.GetCurrentGameContext();
  return {
    Launch: e.room.GetGameLaunchState(),
    Clock: [
      e.clock.GetStartGameTime(),
      e.clock.GetEndGameTime(),
      e.clock.m_dwTimeStopped,
    ],
    Boxes: [...ctx.m_aBoxItemState],
    Obstacles: [...ctx.m_aObstacleState],
    Bombs: structuredClone(ctx.m_aBomb),
    NextBomb: ctx.m_nNextBombSerialNo,
    NextBox: ctx.m_nNextBoxItem,
    House: [...ctx.m_aHouseState],
    HouseCount: [...ctx.m_aHouseCount],
    Bula: [...ctx.m_aBulaState],
    Timers: [...ctx.m_aPlayerStateTime],
    Positions: structuredClone(ctx.m_aGhostPosition),
    PlayerStates: [...e.room.m_aPlayerState],
    Statistics: e.room.m_dynInfoCalculator.GetStateBytes().toString("hex"),
    Ghosts: [
      e.room.m_nGhostCount,
      ...e.room.m_anSlotGhost,
      ...e.room.m_anGhostSlot,
    ],
    Sync: e.room.m_syncGameObjMan.GetObjectCount(),
    UUID: e.room.GetResultRoundID(),
    Dirty: e.room.m_nModified,
    LastUpdate: e.room.GetLastUpdateTime(),
    Users: wallets(e),
    Receipts: e.session.db
      .query<{ n: number }, []>("SELECT count(*) AS n FROM RuntimeGameResult")
      .get()!.n,
  };
}
function noExtraServices(e: Environment) {
  e.random(() => {
    throw new Error("Nonmoney pickup/event/throw MUST NOT draw random");
  });
  e.clock.GetCurrentTime = () => {
    throw new Error("Pickup/event/throw MUST NOT sample absolute time");
  };
  e.clock.ElapsedTime = () => {
    throw new Error("Pickup/event/throw MUST NOT sample elapsed time");
  };
}
function actions(e: Environment) {
  return [
    () => send(e, new CSendPacket(144).Encode1(0).Encode1(0).Encode1(0)),
    () => send(e, new CSendPacket(145).Encode1(0).Encode1(0)),
    // Even the native invalid-self early return cannot bypass modern phase/group checks.
    () => send(e, new CSendPacket(149).Encode1(255)),
    () => throwFields(e, [0, 0, 0, 0, 0, 0]),
  ];
}
function resultClaims(e: Environment) {
  send(e, new CSendPacket(146).Encode1(0x60).Encode2(0).Encode2(0));
  send(e, new CSendPacket(146).Encode1(0x61).Encode2(0).Encode2(0));
  send(
    e,
    new CSendPacket(146)
      .Encode1(0x42)
      .Encode2(0)
      .Encode2(0)
      .Encode1(255)
      .Encode1(0),
    1,
  );
  e.clear();
}

test("independent pickup models match34 original PE anchors, FULL91-byte CP949 CString and native153 DEFAULT; NOT original execution/client proof", () => {
  const pe = new CPeImage(OFFICIAL_SERVICES.FXGS);
  expect(pe.sha256).toBe(vectors.OfficialPE.SHA256);
  expect(vectors.InstructionAnchors).toHaveLength(34);
  for (const a of vectors.InstructionAnchors)
    expect(pe.read(a.VA, a.Bytes.length / 2).toString("hex")).toBe(a.Bytes);
  const suffix = Buffer.from(EventItemAnnouncement.SuffixHex, "hex");
  expect(suffix).toHaveLength(88);
  expect(pe.read(EventItemAnnouncement.TemplateVA, 91)).toEqual(
    Buffer.concat([Buffer.from("%s"), suffix, Buffer.from([0])]),
  );
  expect(
    new CTextCodec("cp949").Decode(Buffer.concat([Buffer.from("%s"), suffix])),
  ).toBe(
    "%s님께서 이벤트 아이템을 획득하셨습니다! 축하합니다!\n자세한 내용은 홈페이지를 참고하세요~\n",
  );
  expect(() => new CTextCodec("big5").Decode(suffix)).toThrow(CProtocolError);
  const selector = pe.read(0x421661 + 153 - 96, 1)[0]!;
  expect(selector).toBe(38);
  expect(pe.read(0x4215c5 + selector * 4, 4).readUInt32LE()).toBe(0x4215b4);
  expect(
    Object.values(vectors)
      .filter(Array.isArray)
      .reduce((n, a) => n + a.length, 0) - 34,
  ).toBe(8999);
});
test("71 real resource rows have exactly money25..32 and signed deltas; NOT FXSS shop costs or automatic event rewards", () => {
  expect(LaunchItems.GetItemCount()).toBe(71);
  const cash = LaunchItems.m_aItemAttr.filter((row) => row.Type === 99);
  expect(cash.map((row) => row.Index)).toEqual([
    25, 26, 27, 28, 29, 30, 31, 32,
  ]);
  expect(cash.map((row) => row.Parameters[0])).toEqual([
    10, 20, 50, 100, 200, 500, 5000, -1000,
  ]);
  expect(LaunchItems.GetItemAttr(31).Name).toBe("LucciPocket0");
  expect(LaunchItems.GetItemAttr(32).Name).toBe("LucciPocket1");
  expect(LaunchItems.GetItemAttr(33).Type).toBe(98);
});
test("1500 independent body images cover ALL250 boxes, primary/secondary/nonchief actors and resource endpoints: exact156, one flag, no player/DB/timer/RNG effects", () => {
  const e = create(),
    ctx = e.room.GetCurrentGameContext(),
    before = snapshot(e);
  noExtraServices(e);
  expect(vectors.BoxClaims).toHaveLength(1500);
  expect(e.room.IsChief(e.clients[1]!)).toBe(false);
  for (const row of vectors.BoxClaims) {
    ctx.m_aBoxItemState.fill(-777);
    ctx.m_aBoxItemState[row.Box] = row.State;
    sendSource(e, row.Request, row.Slot);
    expect([...ctx.m_aBoxItemState]).toEqual(
      Array(250).fill(-777).with(row.Box, 1),
    );
    packets(e, row.Response);
  }
  expect({ ...snapshot(e), Boxes: before.Boxes }).toEqual(before);
});
test("1278 independent item/state images: actual71-row bounds, ALL nonzero states suppress,24 unclaimed money requests commit wallet+receipt before exact156", () => {
  const e = create(),
    ctx = e.room.GetCurrentGameContext(),
    before = snapshot(e),
    expectedMoney = [0, 0, 0];
  noExtraServices(e);
  expect(vectors.ItemClaims).toHaveLength(1278);
  expect(
    vectors.ItemClaims.filter((r) => r.NativeMoney && r.Claimed),
  ).toHaveLength(24);
  for (const row of vectors.ItemClaims) {
    ctx.m_aBoxItemState.fill(0); // matrix fixture reset, NOT a new production round
    ctx.m_aBoxItemState[row.Box] = row.State;
    sendSource(e, row.Request, row.Slot);
    if (row.NativeMoney && row.Claimed)
      expectedMoney[row.Slot] = Math.max(
        0,
        expectedMoney[row.Slot]! +
          LaunchItems.GetItemAttr(row.Item).Parameters[0]!,
      );
    expect(ctx.m_aBoxItemState[row.Box]).toBe(row.Claimed ? 1 : row.State);
    packets(e, row.Response);
    expect([...ctx.m_aBoxItemState]).toEqual(
      Array(250)
        .fill(0)
        .with(row.Box, row.Claimed ? 1 : row.State),
    );
    for (const [slot, amount] of expectedMoney.entries()) {
      expect(e.room.m_rgPlayer[slot]!.m_userInfo.Money).toBe(amount);
      expect(e.db.GetUserInfo(names[slot]!)!.Money).toBe(amount);
    }
  }
  expect(expectedMoney).toEqual([4880, 4880, 4880]);
  expect(e.room.GetMoneyPickupState()).toEqual({
    Sequence: 24,
    Pending: false,
    Attempts: 24,
    Failure: undefined,
  });
  expect(
    e.session.db.query("SELECT count(*) AS n FROM RuntimeMoneyPickup").get(),
  ).toEqual({ n: 24 });
  const after = snapshot(e);
  expect({ ...after, Boxes: before.Boxes, Users: before.Users }).toEqual(
    before,
  );
  for (let slot = 0; slot < 3; slot++)
    expect(after.Users[slot]!.Live).toEqual({
      ...before.Users[slot]!.Live,
      Dynamic: { ...before.Users[slot]!.Live.Dynamic, Money: 4880 },
      DynamicModified: 1,
    });
});
test("1536 independent obstacle images cover ALL256 packed bytes/states:207 valid positions,49 rejected, low-nibble15 aliases preserved in EXACT157", () => {
  const e = create(),
    ctx = e.room.GetCurrentGameContext(),
    before = snapshot(e);
  noExtraServices(e);
  expect(vectors.Obstacles).toHaveLength(1536);
  expect(
    new Set(vectors.Obstacles.filter((r) => r.Valid).map((r) => r.Position))
      .size,
  ).toBe(207);
  expect(
    new Set(vectors.Obstacles.filter((r) => !r.Valid).map((r) => r.Position))
      .size,
  ).toBe(49);
  for (const row of vectors.Obstacles) {
    ctx.m_aObstacleState.fill(-919);
    if (row.Valid) ctx.m_aObstacleState[row.Index] = row.State;
    if (row.Valid) sendSource(e, row.Request, row.Slot);
    else
      expect(() => sendSource(e, row.Request, row.Slot)).toThrow(
        CProtocolError,
      );
    expect([...ctx.m_aObstacleState]).toEqual(
      row.Valid
        ? Array(195)
            .fill(-919)
            .with(row.Index, row.Claimed ? 1 : row.State)
        : Array(195).fill(-919),
    );
    packets(e, row.Response);
  }
  expect({ ...snapshot(e), Obstacles: before.Obstacles }).toEqual(before);
});
test("shared-room claims are first-wins, not per-player; twelve alias pairs share one flag; native148 clears a claim and original packed157 is retained", () => {
  const e = create(),
    ctx = e.room.GetCurrentGameContext();
  send(e, new CSendPacket(144).Encode1(1).Encode1(249).Encode1(70));
  for (const p of e.clients)
    expect([p.Take(156).Decode1(), ctx.m_aBoxItemState[249]]).toEqual([1, 1]);
  e.clear();
  send(e, new CSendPacket(144).Encode1(2).Encode1(249).Encode1(0), 1);
  send(e, new CSendPacket(144).Encode1(2).Encode1(249).Encode1(25), 1); // already claimed money is a NOOP, not an award/error
  packets(e);
  for (let row = 0; row < 12; row++) {
    const alias = (row << 4) | 15,
      canonical = (row + 1) << 4,
      index = (row + 1) * 15;
    send(e, new CSendPacket(145).Encode1(2).Encode1(alias), 1);
    for (const peer of e.clients) {
      const p = peer.Take(157);
      expect([p.Decode1(), p.Decode1()]).toEqual([2, alias]);
      p.AssertEnd();
    }
    expect(ctx.m_aObstacleState[index]).toBe(1);
    e.clear();
    send(e, new CSendPacket(145).Encode1(1).Encode1(canonical));
    packets(e);
    send(e, new CSendPacket(148).Encode1(255).Encode1(canonical));
    expect(ctx.m_aObstacleState[index]).toBe(0);
    expect(e.clients[0]!.packets).toEqual([]);
    expect(e.clients[1]!.packets.map((p) => p.m_nPacketType)).toEqual([161]);
    e.clear();
    send(e, new CSendPacket(145).Encode1(1).Encode1(canonical));
    for (const peer of e.clients) {
      const p = peer.Take(157);
      expect([p.Decode1(), p.Decode1()]).toEqual([1, canonical]);
      p.AssertEnd();
    }
    e.clear();
  }
});
test("native pickup does NOT add an alive/dead/color/distance/spawned-item predicate or apply resource parameters to server player attributes", () => {
  const e = create(),
    ctx = e.room.GetCurrentGameContext();
  e.room.m_aPlayerState[1] = GamePlayerState.Inactive;
  e.room.m_aPlayerState[2] = GamePlayerState.Excluded4;
  const before = snapshot(e);
  noExtraServices(e);
  send(e, new CSendPacket(144).Encode1(1).Encode1(249).Encode1(33));
  expect(e.clients[0]!.Take(156).remaining).toBe(3); // Alphabet Type98, no automatic30/inventory grant
  expect(e.clients[1]!.Take(156).remaining).toBe(3);
  e.clear();
  send(e, new CSendPacket(145).Encode1(2).Encode1(0xce), 1);
  expect(ctx.m_aObstacleState[194]).toBe(1);
  expect(e.clients.every((p) => p.packets.length === 1)).toBe(true);
  e.clear();
  expect({
    ...snapshot(e),
    Boxes: before.Boxes,
    Obstacles: before.Obstacles,
  }).toEqual(before);
});
test("18 independent149 images use SOCKET-LOCAL self0/1: EXACT30 = username+88 raw CP949 bytes, never the log-only label, reward, inventory or money", () => {
  const e = create(),
    before = snapshot(e);
  noExtraServices(e);
  expect(vectors.Events).toHaveLength(18);
  for (const row of vectors.Events) {
    e.table.OnPacket(sourcePacket(row.Request), e.clients[row.Socket]!);
    packets(e, row.Response);
  }
  expect(snapshot(e)).toEqual(before);
});
test("509 invalid local-self images return BEFORE even string-length decoding; modern valid room/group/phase guard still applies", () => {
  const e = create(),
    before = snapshot(e);
  noExtraServices(e);
  expect(vectors.InvalidEvents).toHaveLength(509);
  for (const row of vectors.InvalidEvents) {
    const p = sourcePacket(row.Request);
    e.table.OnPacket(p, e.clients[row.Socket]!);
    expect(p.remaining).toBe(0);
    packets(e);
  }
  // Bob's room slot2 is NOT his local self0, and may not announce another user.
  send(e, new CSendPacket(149).Encode1(2).EncodeStr(Buffer.alloc(2048, 0)), 1);
  packets(e);
  expect(snapshot(e)).toEqual(before);
});
test("valid149 self enforces bounded/full/valid legacy label BEFORE publication; invalid-self native early NOOP is not turned into string validation", () => {
  const e = create(),
    before = snapshot(e);
  expect(RuntimePolicy.MaxEventItemNameBytes).toBe(1024);
  const bad = [
    new CSendPacket(149),
    new CSendPacket(149).Encode1(0),
    new CSendPacket(149)
      .Encode1(0)
      .Encode2(2)
      .EncodeBuffer(Buffer.from([65])),
    new CSendPacket(149).Encode1(0).EncodeStr(Buffer.alloc(1025, 65)),
    new CSendPacket(149).Encode1(0).EncodeStr(Buffer.from([0])),
    new CSendPacket(149).Encode1(0).EncodeStr(Buffer.from([0x81])),
    new CSendPacket(149).Encode1(0).EncodeStr("label").Encode1(0),
  ];
  for (const p of bad) {
    expect(() => send(e, p)).toThrow(CProtocolError);
    packets(e);
    expect(snapshot(e)).toEqual(before);
  }
  const p = new CSendPacket(149)
    .Encode1(2)
    .Encode2(0xffff)
    .EncodeBuffer(Buffer.from([0, 0x81]));
  send(e, p);
  packets(e);
  expect(snapshot(e)).toEqual(before);
});
test("3072 independent TRUSTED throw-kernel images preserve high nibble/ALL256 opaque-byte values and reset ONLY one box; no invented request opcode", () => {
  const e = create(),
    ctx = e.room.GetCurrentGameContext(),
    before = snapshot(e);
  noExtraServices(e);
  expect(vectors.Throws).toHaveLength(3072);
  for (const row of vectors.Throws) {
    ctx.m_aBoxItemState.fill(-333);
    ctx.m_aBoxItemState[row.Box] = row.State;
    e.room.OnItemThrow(throwCursor(row.Body), e.clients[row.Slot < 2 ? 0 : 1]!);
    expect([...ctx.m_aBoxItemState]).toEqual(
      Array(250).fill(-333).with(row.Box, 0),
    );
    packets(e, row.Response);
  }
  expect({ ...snapshot(e), Boxes: before.Boxes }).toEqual(before);
});
test("146 malformed trusted-throw vectors reject250..255 boxes and masked actors8..15 before ANY flag/output effect; native unsafe/noop diagnostics are not emulated", () => {
  const e = create(),
    before = snapshot(e);
  noExtraServices(e);
  expect(vectors.InvalidThrows).toHaveLength(146);
  for (const row of vectors.InvalidThrows) {
    expect(() =>
      e.room.OnItemThrow(
        throwCursor(row.Body),
        e.clients[row.Slot < 2 ? 0 : 1]!,
      ),
    ).toThrow(CProtocolError);
    packets(e);
    expect(snapshot(e)).toEqual(before);
  }
  for (let length = 0; length < 6; length++) {
    expect(() => throwFields(e, Array(length).fill(0))).toThrow(CProtocolError);
    packets(e);
  }
  expect(() => throwFields(e, Array(7).fill(0))).toThrow(CProtocolError);
  packets(e);
});
test("153 really is native dispatch DEFAULT and remains unavailable on our network dispatcher; proven throw172 kernel does NOT invent153 routing", () => {
  const e = create(),
    before = snapshot(e);
  expect(() =>
    send(e, new CSendPacket(153).EncodeBuffer(Buffer.alloc(6))),
  ).toThrow(CUnsupportedOperation);
  packets(e);
  expect(snapshot(e)).toEqual(before);
  throwFields(e, [0xf1, 249, 255, 128, 0, 1]);
  for (const peer of e.clients) {
    const p = peer.Take(172);
    expect(Array.from({ length: 6 }, () => p.Decode1())).toEqual([
      0xf1, 249, 255, 128, 0, 1,
    ]);
    p.AssertEnd();
  }
});
test("a genuine EIGHT-slot native round preserves room actors0..7 versus each socket's local0/1 and deduplicates each whole-room156/157/30 publication", () => {
  const e = GameLaunchFixture([2, 2, 2, 2]);
  cleanup.push(e.close);
  loading(e);
  running(e);
  for (let slot = 0; slot < 8; slot++) {
    const sender = slot >>> 1;
    send(
      e,
      new CSendPacket(144).Encode1(slot).Encode1(slot).Encode1(0),
      sender,
    );
    for (const peer of e.clients) {
      const p = peer.Take(156);
      expect([p.Decode1(), p.Decode1(), p.Decode1()]).toEqual([slot, slot, 0]);
      p.AssertEnd();
      expect(peer.packets).toEqual([]);
    }
    send(e, new CSendPacket(145).Encode1(slot).Encode1(0xc0 + slot), sender);
    for (const peer of e.clients) {
      const p = peer.Take(157);
      expect([p.Decode1(), p.Decode1()]).toEqual([slot, 0xc0 + slot]);
      p.AssertEnd();
      expect(peer.packets).toEqual([]);
    }
    send(e, new CSendPacket(149).Encode1(slot & 1).EncodeStr("label"), sender);
    const expected = Buffer.concat([
      Buffer.from(e.room.m_rgPlayer[slot]!.GetName(), "ascii"),
      Buffer.from(EventItemAnnouncement.SuffixHex, "hex"),
    ]);
    for (const peer of e.clients) {
      const p = peer.Take(30);
      expect(p.DecodeStrBytes()).toEqual(expected);
      p.AssertEnd();
      expect(peer.packets).toEqual([]);
    }
  }
});
test("144/145 preflight rejects truncated/trailing bodies, ALL invalid item/box bytes, cross-socket/empty/out-of-range room actors before any partial claim", () => {
  const e = create(),
    before = snapshot(e);
  noExtraServices(e);
  const bad: CSendPacket[] = [];
  for (let length = 0; length < 3; length++)
    bad.push(new CSendPacket(144).EncodeBuffer(Buffer.alloc(length, 0x5a)));
  bad.push(new CSendPacket(144).Encode1(0).Encode1(0).Encode1(0).Encode1(0));
  for (let length = 0; length < 2; length++)
    bad.push(new CSendPacket(145).EncodeBuffer(Buffer.alloc(length, 0x5a)));
  bad.push(new CSendPacket(145).Encode1(0).Encode1(0).Encode1(0));
  for (let box = 250; box < 256; box++)
    bad.push(new CSendPacket(144).Encode1(0).Encode1(box).Encode1(0));
  for (let item = 71; item < 256; item++)
    bad.push(new CSendPacket(144).Encode1(0).Encode1(0).Encode1(item));
  for (let actor = 2; actor < 256; actor++) {
    bad.push(new CSendPacket(144).Encode1(actor).Encode1(0).Encode1(0));
    bad.push(new CSendPacket(145).Encode1(actor).Encode1(0));
  }
  for (const p of bad) {
    expect(() => send(e, p)).toThrow(CProtocolError);
    packets(e);
  }
  for (const actor of [0, 1]) {
    expect(() =>
      send(e, new CSendPacket(144).Encode1(actor).Encode1(0).Encode1(0), 1),
    ).toThrow(CProtocolError);
    expect(() =>
      send(e, new CSendPacket(145).Encode1(actor).Encode1(0), 1),
    ).toThrow(CProtocolError);
    expect(() => throwFields(e, [actor, 0, 0, 0, 0, 0], 1)).toThrow(
      CProtocolError,
    );
    packets(e);
  }
  // Unlike the aircraft early throttle, a claimed box does not bypass full
  // body/resource validation; native item-count check precedes the flag read.
  const ctx = e.room.GetCurrentGameContext();
  ctx.m_aBoxItemState[0] = 1;
  for (const p of [
    new CSendPacket(144).Encode1(0).Encode1(0),
    new CSendPacket(144).Encode1(0).Encode1(0).Encode1(71),
  ]) {
    expect(() => send(e, p)).toThrow(CProtocolError);
    expect(ctx.m_aBoxItemState[0]).toBe(1);
    packets(e);
  }
  ctx.m_aBoxItemState[0] = 0;
  expect(snapshot(e)).toEqual(before);
});
test("ALL four paths validate the WHOLE socket group, even invalid-self149 or an otherwise legitimate primary actor; stale SECOND local tuple/owner/slot and free user fail closed", () => {
  const e = create(),
    second = e.clients[0]!.m_aUser[1]!;
  const mutations = [
    () => {
      const old = second.m_nSessionSerialNo;
      second.m_nSessionSerialNo++;
      return () => {
        second.m_nSessionSerialNo = old;
      };
    },
    () => {
      const old = second.m_nSessionIdx;
      second.m_nSessionIdx++;
      return () => {
        second.m_nSessionIdx = old;
      };
    },
    () => {
      const old = second.m_nSlotIdx;
      second.m_nSlotIdx = 7;
      return () => {
        second.m_nSlotIdx = old;
      };
    },
    () => {
      const old = second.m_pClientSocket;
      second.m_pClientSocket = e.clients[1]!;
      return () => {
        second.m_pClientSocket = old;
      };
    },
  ];
  for (const change of mutations) {
    const restore = change(),
      before = snapshot(e);
    try {
      for (const action of actions(e)) {
        expect(action).toThrow(CProtocolError);
        packets(e);
      }
      expect(snapshot(e)).toEqual(before);
    } finally {
      restore();
    }
  }
  second.SetFree();
  const before = snapshot(e);
  for (const action of actions(e)) {
    expect(action).toThrow(CProtocolError);
    packets(e);
  }
  expect(snapshot(e)).toEqual(before);
});
test("waiting/Loading/fabricated Running/trusted-result-only bindings/Mod cannot bypass modern native-generation scope; guard differs deliberately from native ungated handlers", () => {
  const reject = (e: Environment) => {
    const before = snapshot(e);
    for (const action of actions(e)) {
      expect(action).toThrow();
      packets(e);
    }
    expect(snapshot(e)).toEqual(before);
  };
  const waiting = create(false);
  reject(waiting);
  waiting.room.m_bPlaying = true;
  waiting.room.m_nGameState = GameStage.Running;
  reject(waiting);
  waiting.room.PrepareRoundStatistics();
  waiting.clock.StartGame();
  waiting.room.BeginResultLifecycle();
  reject(waiting);
  const load = create(false);
  loading(load);
  reject(load);
  const mod = create();
  mod.room.SendGameTypeMod();
  mod.clear();
  reject(mod);
});
test("frozen pending SQLite result refuses ALL four item paths without altering receipt/baseline/claims/wallet or releasing the frozen decision", () => {
  const e = create();
  resultClaims(e);
  e.db.CommitGameResult = () => "conflict";
  e.time(101);
  e.table.UpdateGameSessions();
  e.clear();
  expect(e.table.GetPendingResultCount()).toBe(1);
  const before = snapshot(e);
  for (const action of actions(e)) {
    expect(action).toThrow(CProtocolError);
    packets(e);
  }
  expect(snapshot(e)).toEqual(before);
  expect(e.table.GetPendingResultCount()).toBe(1);
});
test("publication callbacks see committed claims/resets and cannot reenter item/airplane/ghost/removal/mode/result transitions; failed sends do NOT replay claimed156/157, stateless30/172 remain repeatable", () => {
  for (const type of [156, 157, 30, 172]) {
    const e = create(),
      ctx = e.room.GetCurrentGameContext(),
      first = e.clients[0]!,
      original = first.SendPacket;
    const perform = () => {
      if (type === 156)
        send(e, new CSendPacket(144).Encode1(0).Encode1(9).Encode1(0));
      else if (type === 157)
        send(e, new CSendPacket(145).Encode1(0).Encode1(9));
      else if (type === 30)
        send(e, new CSendPacket(149).Encode1(0).EncodeStr("label"));
      else throwFields(e, [0xf0, 9, 255, 128, 0, 1]);
    };
    ctx.m_aBoxItemState[9] = type === 172 ? 1 : 0;
    let observed = 0;
    first.SendPacket = function (p) {
      if (p.m_nPacketType === type) {
        observed++;
        if (type === 156) expect(ctx.m_aBoxItemState[9]).toBe(1);
        if (type === 157) expect(ctx.m_aObstacleState[9]).toBe(1);
        if (type === 172) expect(ctx.m_aBoxItemState[9]).toBe(0);
        for (const action of actions(e)) expect(action).toThrow(CProtocolError);
        expect(() => send(e, new CSendPacket(156).Encode1(0), 1)).toThrow();
        expect(() =>
          send(e, new CSendPacket(151).Encode1(0).Encode1(2), 1),
        ).toThrow();
        expect(() => e.table.DestroyPlayer(e.clients[1]!)).toThrow();
        expect(() => e.room.PrepareRoundStatistics()).toThrow();
        expect(() => e.room.SendGameTypeMod()).toThrow();
        expect(() => e.room.BeginResultLifecycle()).toThrow();
        expect(e.room.DeferHandleGameEnd()).toBe(false);
        throw new Error("test-only item publication failure");
      }
      original.call(this, p);
    };
    try {
      perform();
    } finally {
      first.SendPacket = original;
    }
    expect(observed).toBe(1);
    expect(first.packets).toEqual([]);
    expect(e.clients[1]!.packets.map((p) => p.m_nPacketType)).toEqual([type]);
    expect(e.room.GetPacketPublicationFailureCount()).toBe(1);
    e.clear();
    perform();
    for (const peer of e.clients)
      expect(peer.packets.map((p) => p.m_nPacketType)).toEqual(
        type === 156 || type === 157 ? [] : [type],
      );
  }
});
test("164 retains claim arrays; the NEXT real106/LaunchGameStage context Init clears them already in Loading, before150; no fake Running or UUID bypass", () => {
  const e = create(),
    ctx = e.room.GetCurrentGameContext(),
    key = e.room.GetResultRoundID()!;
  send(e, new CSendPacket(144).Encode1(1).Encode1(249).Encode1(70));
  e.clear();
  send(e, new CSendPacket(145).Encode1(2).Encode1(0xf), 1);
  e.clear();
  resultClaims(e);
  e.time(101);
  e.table.UpdateGameSessions();
  e.clear();
  expect(e.room.m_nGameState).toBe(GameStage.Result);
  expect(e.db.GetGameResultReceipt(key)).toBeDefined();
  expect([ctx.m_aBoxItemState[249], ctx.m_aObstacleState[15]]).toEqual([1, 1]);
  e.time(8102);
  e.table.UpdateGameSessions();
  e.clear();
  expect(e.room.m_bPlaying).toBe(false);
  expect([ctx.m_aBoxItemState[249], ctx.m_aObstacleState[15]]).toEqual([1, 1]);
  send(e, new CSendPacket(96).Encode1(1), 1);
  e.clear();
  loading(e);
  expect([...ctx.m_aBoxItemState]).toEqual(Array(250).fill(0));
  expect([...ctx.m_aObstacleState]).toEqual(Array(195).fill(0));
  expect(() =>
    send(e, new CSendPacket(144).Encode1(0).Encode1(249).Encode1(0)),
  ).toThrow(CProtocolError);
  packets(e);
  running(e);
  expect(e.room.GetResultRoundID()).not.toBe(key);
  send(e, new CSendPacket(144).Encode1(0).Encode1(249).Encode1(0));
  expect(ctx.m_aBoxItemState[249]).toBe(1);
  for (const peer of e.clients)
    expect(peer.packets.map((p) => p.m_nPacketType)).toEqual([156]);
  for (const name of names) expect(e.db.GetUserInfo(name)!.Money).toBe(0);
});
test("130 independent CUser::IncDecMoney images: signed32 ADD/wrap BEFORE [0,1,000,000] clamp, always dynamic-dirty, no level/simple-info/game-counter/other-dynamic effects", () => {
  expect(vectors.MoneyKernel).toHaveLength(130);
  expect(UserDynamicRule.MaximumMoney).toBe(1_000_000);
  for (const row of vectors.MoneyKernel) {
    const user = new CUser(
      UserInfo("Money", {
        Money: row.Before,
        Exp: 200,
        Win: 3,
        Draw: 4,
        Lose: 5,
      }),
      1,
    );
    user.SetFakeLevel(7);
    user.SetLevelIcon(1, 123);
    user.SetSimpleInfoModified(9);
    user.IncGame();
    const before = user.GetDynamicInfoSnapshot();
    expect(user.IncDecMoney(row.Delta)).toBeUndefined();
    expect(user.GetDynamicInfoSnapshot()).toEqual({
      ...before,
      Dynamic: { ...before.Dynamic, Money: row.After },
      DynamicModified: 1,
    });
  }
});
test("IncDecMoney modern input checks reject non-int32 delta/current values BEFORE dirtying or changing anything; arithmetic kernel does NOT write SQL", () => {
  const invalid = [NaN, Infinity, -Infinity, 0.5, 2147483648, -2147483649];
  for (const value of invalid) {
    const user = new CUser(UserInfo("Money", { Money: 123 }), 1),
      before = user.GetDynamicInfoSnapshot();
    expect(() => user.IncDecMoney(value)).toThrow(CProtocolError);
    expect(user.GetDynamicInfoSnapshot()).toEqual(before);
    user.m_userInfo.Money = value;
    const bad = user.GetDynamicInfoSnapshot();
    expect(() => user.IncDecMoney(0)).toThrow(CProtocolError);
    expect(user.GetDynamicInfoSnapshot()).toEqual(bad);
  }
});
test("800 independent real-resource money previews: authencode BYTE1 ONLY, rand parity/no-draw branch, signed negative pockets, saturation/wrap, EXACT4-byte156; never committed/sent", () => {
  const e = create(false),
    ctx = e.room.GetCurrentGameContext(),
    base = snapshot(e);
  expect(vectors.MoneyPreviews).toHaveLength(800);
  for (const row of vectors.MoneyPreviews) {
    const user = e.room.m_rgPlayer[row.Slot]!;
    user.m_userInfo.Money = row.Before;
    user.SetAuthenCode(row.Authencode);
    user.m_userInfo.Gender = (row.Authencode + 1) & 255;
    user.m_userInfo.Authority = 23;
    const live = user.GetDynamicInfoSnapshot();
    let draws = 0;
    const preview = e.room.MakeMoneyPickupPreview(
      row.Slot,
      row.Box,
      row.Item,
      () => {
        draws++;
        return row.Draw;
      },
    );
    expect(draws).toBe(row.RandomDraws);
    expect(preview.Multiplier).toBe(row.Multiplier);
    expect(preview.Delta).toBe(row.Delta);
    expect(preview.DiagnosticAmountExceeded).toBe(row.DiagnosticAmountExceeded);
    expect(preview.Before).toEqual(live);
    expect(preview.After).toEqual({
      ...live,
      Dynamic: { ...live.Dynamic, Money: row.After },
      DynamicModified: 1,
    });
    expect(preview.Packet.GetBuffer().toString("hex")).toBe(row.Response);
    expect(user.GetDynamicInfoSnapshot()).toEqual(live);
    expect(Object.isFrozen(preview)).toBe(true);
    expect(Object.isFrozen(preview.After.Dynamic)).toBe(true);
    packets(e);
  }
  expect(ctx.m_aBoxItemState.every((v) => v === 0)).toBe(true);
  expect({ ...snapshot(e), Users: base.Users }).toEqual(base);
  for (const name of names) expect(e.db.GetUserInfo(name)!.Money).toBe(0);
});
test("10 synthetic resource previews preserve native diagnostic-only >10000 and signed32 IMUL before money ADD/clamp; not a fabricated10000 reward cap", () => {
  const items = new CItemAttr();
  for (const row of vectors.SyntheticMoneyPreviews) {
    if (items.m_aItemAttr[row.Item]) continue;
    items.m_aItemAttr.push(
      Object.freeze({
        Index: row.Item,
        Name: `Synthetic${row.Item}`,
        ImageName: "",
        ProbabilityWeight: 1,
        Opaque136: 0,
        Type: 99,
        Parameters: Object.freeze([row.Amount, 0, 0, 0, 0]),
      }),
    );
  }
  const e = create(false, items),
    before = snapshot(e);
  expect(vectors.SyntheticMoneyPreviews).toHaveLength(10);
  for (const row of vectors.SyntheticMoneyPreviews) {
    const user = e.room.m_rgPlayer[row.Slot]!;
    user.m_userInfo.Money = row.Before;
    user.SetAuthenCode(row.Authencode);
    const live = user.GetDynamicInfoSnapshot();
    const p = e.room.MakeMoneyPickupPreview(
      row.Slot,
      row.Box,
      row.Item,
      () => row.Draw,
    );
    expect(p.Delta).toBe(row.Delta);
    expect(p.After.Dynamic.Money).toBe(row.After);
    expect(p.DiagnosticAmountExceeded).toBe(row.DiagnosticAmountExceeded);
    expect(p.Packet.GetBuffer().toString("hex")).toBe(row.Response);
    expect(user.GetDynamicInfoSnapshot()).toEqual(live);
    packets(e);
  }
  expect({ ...snapshot(e), Users: before.Users }).toEqual(before);
});
test("money preview is detached/explicit, validates slot/box/resource/type/random, uses existing injected15-bit source only for auth1; invalid network RNG refuses before claim; valid auth1 money persists exactly once", () => {
  const e = create(),
    user = e.room.m_rgPlayer[0]!;
  const before = snapshot(e);
  let draws = 0;
  const rng = () => {
    draws++;
    return 1;
  };
  for (const [slot, box, item] of [
    [-1, 0, 25],
    [8, 0, 25],
    [3, 0, 25],
    [0, -1, 25],
    [0, 250, 25],
    [0, 0, 71],
    [0, 0, -1],
    [0, 0, 0],
  ])
    expect(() =>
      e.room.MakeMoneyPickupPreview(slot!, box!, item!, rng),
    ).toThrow(CProtocolError);
  expect(draws).toBe(0);
  expect(snapshot(e)).toEqual(before);
  user.SetAuthenCode(257); // native stores/reads BYTE, 257 becomes1
  for (const value of [NaN, Infinity, -1, 0.5, 32768])
    expect(() => e.room.MakeMoneyPickupPreview(0, 0, 25, () => value)).toThrow(
      CProtocolError,
    );
  e.random(() => {
    draws++;
    return 32767;
  });
  expect(e.room.MakeMoneyPickupPreview(0, 0, 25).Multiplier).toBe(2);
  expect(draws).toBe(1);
  const afterAuth = snapshot(e);
  e.random(() => 32768);
  for (const item of [25, 31, 32]) {
    expect(() =>
      send(e, new CSendPacket(144).Encode1(0).Encode1(0).Encode1(item)),
    ).toThrow(CProtocolError);
    packets(e);
    expect(snapshot(e)).toEqual(afterAuth);
    expect(e.room.IsMoneyPickupPending()).toBe(false);
  }
  e.random(() => {
    draws++;
    return 32767;
  });
  send(e, new CSendPacket(144).Encode1(0).Encode1(0).Encode1(25));
  for (const peer of e.clients) {
    const p = peer.Take(156);
    expect([p.Decode1(), p.Decode1(), p.Decode1(), p.Decode1()]).toEqual([
      0, 0, 25, 2,
    ]);
    p.AssertEnd();
  }
  expect(draws).toBe(2);
  expect(user.m_userInfo.Money).toBe(20);
  expect(e.db.GetUserInfo("Alice")!.Money).toBe(20);
  e.clear();
  send(e, new CSendPacket(144).Encode1(0).Encode1(0).Encode1(31));
  packets(e);
  expect(draws).toBe(2);
  expect(e.room.GetMoneyPickupState().Sequence).toBe(1);
});
