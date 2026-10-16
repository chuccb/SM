import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CReceivedPacketBase } from "../Common/CReceivedPacketBase.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CUser } from "../Common/CUser.ts";
import {
  CProtocolError,
  CUnsupportedOperation,
} from "../Common/CProtocolError.ts";
import {
  CipherDegree,
  DynInfoLayout,
  GameStage,
  SpecialItemRule,
} from "../Common/OfficialValues.ts";
import type { SpecialItemUseSubmission } from "../FXGS/CDBMan.ts";
import {
  IsSpecialItemType,
  MakeSpecialItemRequest,
  MakeSpecialItemPacket,
} from "../FXGS/SpecialItemUse.ts";
import { CPeImage, OFFICIAL_SERVICES } from "../Tools/OfficialSource.ts";
import { Received } from "./helpers/Clients.ts";
import { UserInfo } from "./helpers/Accounts.ts";
import {
  GameLaunchFixture,
  DiscoverLaunchPeer,
  LaunchReadyPacket,
  LaunchItems,
} from "./helpers/GameLaunch.ts";
import { SendMoney, SubmitMoneyRoundClaims } from "./helpers/MoneyPickup.ts";
import { SendHouse } from "./helpers/HouseClaim.ts";
import {
  NativeSpecialEnvironment,
  SeedSpecialInventory,
  SpecialRequest,
  SendSpecial,
  SpecialReceiptCount,
  SpecialLive,
  EmptySpecialResult,
  type NativeSpecialFixture,
} from "./helpers/SpecialItemUse.ts";
import vectors from "./fixtures/special-item-use-vectors.json";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function create(counts: readonly number[] = [2, 1]) {
  const e = NativeSpecialEnvironment(undefined, counts);
  cleanup.push(e.close);
  SeedSpecialInventory(e);
  return e;
}
function noPackets(e: NativeSpecialFixture) {
  for (const p of e.clients) expect(p.packets).toEqual([]);
}
function raw(e: NativeSpecialFixture, body: string, peer = e.clients[0]!) {
  e.table.OnPacket(
    new CReceivedPacketBase(Buffer.from(body, "hex"), CipherDegree.CRC8),
    peer,
  );
}
function nice(e: NativeSpecialFixture, slot = 1) {
  return e.room.m_dynInfoCalculator
    .GetStateBytes()
    .readInt32LE((DynInfoLayout.Nice + slot) * 4);
}
function fault(e: NativeSpecialFixture) {
  e.session.db.exec(
    "CREATE TRIGGER TestSpecialFail BEFORE INSERT ON RuntimeSpecialItemUse BEGIN SELECT RAISE(FAIL,'fixture-special-write'); END",
  );
}
function repair(e: NativeSpecialFixture) {
  e.session.db.exec("DROP TRIGGER TestSpecialFail");
}
function noClockOrRandom(e: NativeSpecialFixture) {
  e.clock.GetCurrentTime = () => {
    throw new Error("special retry must not sample absolute clock");
  };
  e.clock.ElapsedTime = () => {
    throw new Error("special retry must not resample elapsed time");
  };
  e.random(() => {
    throw new Error("special item NEVER draws random");
  });
}
function wire(e: NativeSpecialFixture, slot = 1, index = 44, q = 1) {
  const sender = e.room.m_rgPlayer[slot]!.m_pClientSocket!;
  for (const p of e.clients) {
    if (p === sender) {
      expect(p.packets).toEqual([]);
      continue;
    }
    const body = p.Take(159);
    expect(body.Decode1()).toBe(slot);
    expect(body.Decode2()).toBe(0x80ff);
    expect(body.Decode2()).toBe(0xff80);
    expect(body.Decode1()).toBe(90);
    expect(body.Decode1()).toBe(index);
    expect(body.Decode1()).toBe(q);
    body.AssertEnd();
  }
  e.clear();
}
function freeze(p: SpecialItemUseSubmission) {
  return JSON.stringify({
    ...p,
    Packet: Buffer.from(p.Packet).toString("hex"),
  });
}
function store(
  e: NativeSpecialFixture,
  row: ReturnType<typeof SeedSpecialInventory>,
  amount = row.Amount,
) {
  e.session.db.exec("DELETE FROM FxUserInventory");
  e.session.db
    .query(
      "INSERT INTO FxUserInventory(SN,ID,ItemID,Slot,Amount,ExpireDate,Verbose,CreatedAt) VALUES(?,?,?,?,?,?,?,?)",
    )
    .run(
      row.SN,
      row.ID,
      row.ItemID,
      row.Slot,
      amount,
      row.ExpireDate,
      row.Verbose,
      row.CreatedAt,
    );
}

test("44 read-only PE anchors and independent archive parser bind all71 resource types; exactly20 rows qualify,29/30 are rejected despite existing resources", () => {
  const image = new CPeImage(OFFICIAL_SERVICES.FXGS);
  expect(vectors.OfficialPE.SHA256).toBe(image.sha256);
  expect(vectors.InstructionAnchors).toHaveLength(44);
  for (const a of vectors.InstructionAnchors)
    expect(image.read(a.VA, a.Bytes.length / 2).toString("hex")).toBe(a.Bytes);
  for (const a of vectors.ArchiveIdentity)
    expect(
      createHash("sha256").update(readFileSync(a.Path)).digest("hex"),
    ).toBe(a.SHA256);
  expect(LaunchItems.m_aItemAttr.map((r) => r.Type)).toEqual(
    vectors.ResourceTypes,
  );
  expect(vectors.ResourceTypes).toHaveLength(71);
  for (const row of vectors.TypePredicates)
    expect(IsSpecialItemType(row.Type)).toBe(row.Allowed);
  expect(
    LaunchItems.m_aItemAttr
      .filter((r) => IsSpecialItemType(r.Type))
      .map((r) => r.Index),
  ).toEqual([
    44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 59, 60, 61, 62, 63, 64, 65, 66, 69,
    70,
  ]);
  expect(IsSpecialItemType(29)).toBe(false);
  expect(IsSpecialItemType(30)).toBe(false);
  expect(SpecialItemRule.NoShopUseChannelType).toBe(108);
});
test("all48 independent201 images prove SN/Slot/AMOUNT/description/RAW little-endian double order, include live zero amounts and exclude ItemID", () => {
  expect(vectors.Inventory201).toHaveLength(48);
  for (const row of vectors.Inventory201) {
    const out = new CSendPacket(201).Encode1(row.Users.length);
    for (const [i, rows] of row.Users.entries()) {
      const u = new CUser(UserInfo(`InvUser${i}`), i + 1);
      u.m_aInventory = rows.map((r) => ({
        ...r,
        ID: u.GetName(),
        ItemID: 0xfedcba98,
        CreatedAt: 12345,
      }));
      const before = u.GetInventoryStateSnapshot();
      u.MakeUserInventoryPacket(out);
      expect(u.GetInventoryStateSnapshot()).toEqual(before);
    }
    expect(out.GetBuffer().toString("hex")).toBe(row.Response);
    const input = Received(out);
    expect(input.Decode1()).toBe(201);
    expect(input.Decode1()).toBe(row.Users.length);
    for (const rows of row.Users) {
      expect(input.Decode4()).toBe(rows.length);
      for (const r of rows) {
        expect(input.Decode4()).toBe(r.SN);
        expect(input.Decode1()).toBe(r.Slot);
        expect(input.Decode4()).toBe(r.Amount);
        expect(input.DecodeStr()).toBe(r.Verbose);
        expect(input.DecodeBuffer(8).readDoubleLE()).toBe(
          r.ExpireDate ? r.ExpireDate / 86400 + 25569 : 0,
        );
      }
    }
    input.AssertEnd();
  }
});
test("native getter is FIRST resident SN only; consumed zero rows/dirty intent stay live, reload resets intent and result clones do not invent inventories", () => {
  const e = create(),
    u = e.room.m_rgPlayer[1]!,
    row = u.m_aInventory[0]!,
    duplicate = { ...row, Amount: 99 };
  u.m_aInventory.push(duplicate);
  expect(u.GetUserInventory(row.SN)).toBe(row);
  expect(u.IsInventoryModified(row.SN)).toBe(0);
  u.ConsumeUserInventory(row.SN, 3);
  expect(u.GetUserInventory(row.SN)).toBe(row);
  expect(row.Amount).toBe(0);
  expect(duplicate.Amount).toBe(99);
  expect(u.IsInventoryModified(row.SN)).toBe(1);
  expect(u.m_aInventory).toHaveLength(2);
  expect(() => u.ConsumeUserInventory(row.SN, 1)).toThrow(CProtocolError);
  expect(() => u.ConsumeUserInventory(row.SN, 0)).toThrow(CProtocolError);
  expect(u.CloneForResultCalculation().m_aInventory).toEqual([]);
  const snapshot = u.GetInventoryStateSnapshot();
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot[0])).toBe(true);
  u.m_aInventory = [{ ...row }];
  expect(u.IsInventoryModified(row.SN)).toBe(0);
});
test("ALL5763 independent native case0 images exercise REAL106/discovery109/150 rooms,8 actors/4 sockets, 988 paid commits, zero-use relays and explicit modern atomic refusals", () => {
  const e = NativeSpecialEnvironment(undefined, [2, 2, 2, 2]);
  cleanup.push(e.close);
  const n = GameLaunchFixture([2, 1], 108);
  cleanup.push(n.close);
  n.table.OnPacket(Received(new CSendPacket(106)), n.clients[0]!);
  for (const [i, p] of n.clients.entries()) {
    DiscoverLaunchPeer(n.room, p, 45000 + i);
    n.table.OnPacket(Received(LaunchReadyPacket(n.room, p)), p);
  }
  n.clear();
  let paid = 0,
    clockCalls = 0;
  e.clock.GetCurrentTime = () => {
    throw new Error("no absolute clock");
  };
  e.clock.ElapsedTime = () => {
    clockCalls++;
    return 0xfffffff0;
  };
  e.random(() => {
    throw new Error("no special-item RNG");
  });
  n.clock.GetCurrentTime = () => {
    throw new Error("no absolute clock");
  };
  n.clock.ElapsedTime = () => {
    clockCalls++;
    return 0xfffffff0;
  };
  n.random(() => {
    throw new Error("no special-item RNG");
  });
  for (const r of vectors.Cases) {
    const f = r.ChannelType === 108 ? n : e,
      user = f.room.m_rgPlayer[r.Slot]!,
      sender = user.m_pClientSocket!,
      context = f.room.GetCurrentGameContext();
    for (let i = 0; i < f.room.m_rgPlayer.length; i++) {
      const u = f.room.m_rgPlayer[i];
      if (u) u.m_aInventory = [];
      f.room.m_aShopItemAttempted[i] = 0;
      f.room.m_dynInfoCalculator.SetNice(i, 0);
    }
    const stock = {
      SN: 0x12345678,
      ID: user.GetName(),
      ItemID: 0xfedcba98,
      Slot: 255,
      Amount: r.BeforeAmount,
      ExpireDate: 1,
      Verbose: "opaque-description",
      CreatedAt: 12345,
    };
    f.session.db.exec("DELETE FROM FxUserInventory");
    f.session.db
      .query(
        "INSERT INTO FxUserInventory(SN,ID,ItemID,Slot,Amount,ExpireDate,Verbose,CreatedAt) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        stock.SN,
        stock.ID,
        stock.ItemID,
        stock.Slot,
        Math.max(1, stock.Amount),
        stock.ExpireDate,
        stock.Verbose,
        stock.CreatedAt,
      );
    if (r.Resident) user.m_aInventory = [{ ...stock }];
    f.room.m_aPlayerState[r.Slot] = r.PlayerState;
    context.m_aPlayerStateTime[r.Slot] = 123;
    context.m_aGhostPosition[r.Slot] = { x: 17, y: 29 };
    const before = SpecialLive(f),
      calls = clockCalls,
      count = SpecialReceiptCount(f.db),
      input = new CReceivedPacketBase(
        Buffer.from(r.Request, "hex"),
        CipherDegree.CRC8,
      );
    if (r.ModernStatus === "rejected")
      expect(() => f.table.OnPacket(input, sender)).toThrow(CProtocolError);
    else f.table.OnPacket(input, sender);
    expect(clockCalls - calls).toBe(
      r.ModernStatus === "relayed" && r.NativeRefreshTime ? 1 : 0,
    );
    if (r.ModernStatus !== "relayed") {
      expect(SpecialLive(f)).toEqual(before);
      noPackets(f);
      expect(SpecialReceiptCount(f.db)).toBe(count);
      continue;
    }
    if (r.Quantity) {
      paid++;
      expect(user.GetUserInventory(stock.SN)!.Amount).toBe(r.NativeAmount);
      expect(user.IsInventoryModified(stock.SN)).toBe(1);
      expect(f.db.GetInventoryRecord(stock.SN)?.Amount ?? 0).toBe(
        r.NativeAmount,
      );
      expect(f.room.m_aShopItemAttempted[r.Slot]).toBe(1);
      expect(nice(f, r.Slot)).toBe(1);
      expect(SpecialReceiptCount(f.db)).toBe(count + 1);
    } else {
      expect(user.GetInventoryStateSnapshot()).toEqual(
        before.Inventories[r.Slot]!,
      );
      expect(f.room.m_aShopItemAttempted[r.Slot]).toBe(0);
      expect(nice(f, r.Slot)).toBe(0);
      expect(SpecialReceiptCount(f.db)).toBe(count);
    }
    expect(f.room.m_aPlayerState[r.Slot]).toBe(r.PlayerState);
    expect(context.m_aGhostPosition[r.Slot]).toEqual({ x: 17, y: 29 });
    expect(context.m_aPlayerStateTime[r.Slot]).toBe(
      r.NativeRefreshTime ? 0xfffffff0 : 123,
    );
    for (const peer of f.clients)
      expect(peer.packets.map((p) => p.m_pBlock.toString("hex"))).toEqual(
        peer === sender ? [] : [r.NativeResponse!],
      );
    const request = {
      Slot: r.Slot,
      X: r.X,
      Y: r.Y,
      Opaque: r.Opaque,
      ItemIndex: r.ItemIndex,
      Quantity: r.Quantity,
      ...(r.Quantity ? { InventorySN: r.InventorySN } : {}),
    };
    expect(MakeSpecialItemRequest(request).GetBuffer().toString("hex")).toBe(
      r.Request,
    );
    expect(MakeSpecialItemPacket(request).GetBuffer().toString("hex")).toBe(
      r.NativeResponse,
    );
    f.clear();
  }
  expect(paid).toBe(988);
  expect(e.room.GetSpecialItemUseState().Sequence).toBe(988);
  expect(SpecialReceiptCount(e.db)).toBe(988);
  expect(SpecialReceiptCount(n.db)).toBe(0);
}, 30000);
test("channel108 positive quantity returns BEFORE optional SN, resource lookup, flags, clocks or trailing-byte validation; zero quantity is NOT blocked", () => {
  const e = GameLaunchFixture([2, 1], 108);
  cleanup.push(e.close);
  e.table.OnPacket(Received(new CSendPacket(106)), e.clients[0]!);
  for (const [i, p] of e.clients.entries()) {
    DiscoverLaunchPeer(e.room, p, 46000 + i);
    e.table.OnPacket(Received(LaunchReadyPacket(e.room, p)), p);
  }
  e.clear();
  noClockOrRandom(e);
  const prefix = new CSendPacket(146)
      .Encode1(1)
      .Encode2(0x80ff)
      .Encode2(0xff80)
      .Encode1(90)
      .Encode1(255)
      .Encode1(255),
    before = SpecialLive(e);
  for (const extra of [
    Buffer.alloc(0),
    Buffer.from([1, 2, 3]),
    Buffer.alloc(20, 255),
  ]) {
    const p = new CReceivedPacketBase(
      Buffer.concat([prefix.GetBuffer(), extra]),
      CipherDegree.CRC8,
    );
    e.table.OnPacket(p, e.clients[0]!);
  }
  expect(SpecialLive(e)).toEqual(before);
  noPackets(e);
  expect(SpecialReceiptCount(e.db)).toBe(0);
  SendSpecial(e, 1, 44, 0);
  wire(e, 1, 44, 0);
});
test("quantity0 has NO inventory ownership/expiry proof, flags, Nice or SQL; Type22 refreshes state3 ONCE but never state/position/rebirth", () => {
  const e = create(),
    u = e.room.m_rgPlayer[1]!;
  u.m_aInventory = [];
  e.room.m_aShopItemAttempted[1] = 42;
  e.room.m_dynInfoCalculator.SetNice(1, -99);
  e.room.m_aPlayerState[1] = 3;
  const c = e.room.GetCurrentGameContext();
  c.m_aPlayerStateTime[1] = 123;
  c.m_aGhostPosition[1] = { x: 12345, y: 54321 };
  let calls = 0;
  e.clock.ElapsedTime = () => {
    calls++;
    return 0xfffffff0;
  };
  e.clock.GetCurrentTime = () => {
    throw new Error("no absolute time");
  };
  e.random(() => {
    throw new Error("no RNG");
  });
  SendSpecial(e, 1, 45, 0);
  wire(e, 1, 45, 0);
  expect(calls).toBe(1);
  expect(c.m_aPlayerStateTime[1]).toBe(0xfffffff0);
  expect(c.m_aGhostPosition[1]).toEqual({ x: 12345, y: 54321 });
  expect(e.room.m_aPlayerState[1]).toBe(3);
  expect(e.room.m_aShopItemAttempted[1]).toBe(42);
  expect(nice(e)).toBe(-99);
  expect(SpecialReceiptCount(e.db)).toBe(0);
  expect(e.room.GetSpecialItemUseState().Sequence).toBe(0);
  e.clock.ElapsedTime = () => {
    throw new Error("only state3/type22 may sample time");
  };
  for (const [index, state] of [
    [45, 0],
    [45, 4],
    [44, 3],
    [69, 3],
  ]) {
    e.room.m_aPlayerState[1] = state!;
    SendSpecial(e, 1, index!, 0);
    wire(e, 1, index!, 0);
  }
});
test("entire paid body/resource/SN/amount/group preflight is atomic: malformed/trailing,29/30, foreign actor, missing stock and underflow do not reproduce native item loss", () => {
  const e = create(),
    body = SpecialRequest().GetBuffer(),
    before = SpecialLive(e);
  noClockOrRandom(e);
  for (let length = 1; length < body.length; length++)
    expect(() => raw(e, body.subarray(0, length).toString("hex"))).toThrow(
      CProtocolError,
    );
  expect(() =>
    raw(e, Buffer.concat([body, Buffer.from([0])]).toString("hex")),
  ).toThrow(CProtocolError);
  for (const p of [
    SpecialRequest(2),
    SpecialRequest(8),
    SpecialRequest(15),
    SpecialRequest(1, 67),
    SpecialRequest(1, 68),
    SpecialRequest(1, 71),
    SpecialRequest(1, 255),
    SpecialRequest(1, 45, 4),
    SpecialRequest(1, 45, 1, 99),
  ])
    expect(() => e.table.OnPacket(Received(p), e.clients[0]!)).toThrow(
      CProtocolError,
    );
  expect(SpecialLive(e)).toEqual(before);
  expect(SpecialReceiptCount(e.db)).toBe(0);
  expect(e.room.IsSpecialItemUsePending()).toBe(false);
  noPackets(e);
});
test("waiting/Loading/Result/special modes and synthetic Running cannot grant this native launch generation", () => {
  const e = GameLaunchFixture();
  cleanup.push(e.close);
  expect(() =>
    e.table.OnPacket(Received(SpecialRequest(1, 44, 0)), e.clients[0]!),
  ).toThrow();
  e.table.OnPacket(Received(new CSendPacket(106)), e.clients[0]!);
  expect(() =>
    e.table.OnPacket(Received(SpecialRequest(1, 44, 0)), e.clients[0]!),
  ).toThrow();
  const f = GameLaunchFixture();
  cleanup.push(f.close);
  f.room.SetPlaying(true);
  f.room.m_nGameState = GameStage.Running;
  expect(() =>
    f.table.OnPacket(Received(SpecialRequest(1, 44, 0)), f.clients[0]!),
  ).toThrow(CUnsupportedOperation);
  const g = create();
  g.room.SendGameTypeMod();
  g.clear();
  expect(() => SendSpecial(g, 1, 44, 0)).toThrow(CUnsupportedOperation);
  expect(SpecialReceiptCount(g.db)).toBe(0);
});
test("actual SQL failure freezes inventory/flags/Nice/timer and ALL world/UDP/result/removal paths; driver retries PRE-CLOCK with one frozen Type22 time and no frame delta", () => {
  const e = create();
  e.room.m_aPlayerState[1] = 3;
  e.room.GetCurrentGameContext().m_aPlayerStateTime[1] = 123;
  e.time(12100);
  const before = SpecialLive(e),
    last = e.room.GetLastUpdateTime();
  fault(e);
  SendSpecial(e, 1, 45);
  expect(SpecialLive(e)).toEqual(before);
  noPackets(e);
  expect(e.room.GetSpecialItemUseState()).toEqual({
    Sequence: 0,
    Pending: true,
    Attempts: 1,
    Failure: "storage",
  });
  expect(e.table.GetPendingSpecialItemUseCount()).toBe(1);
  expect(SpecialReceiptCount(e.db)).toBe(0);
  for (const p of [
    SpecialRequest(1, 44),
    new CSendPacket(144).Encode1(1).Encode1(0).Encode1(25),
    new CSendPacket(161).Encode1(1).Encode1(0).Encode1(0),
    new CSendPacket(146).Encode1(0x61).Encode2(0).Encode2(0),
    new CSendPacket(160).Encode1(0),
    new CSendPacket(155).Encode1(1).Encode1(0).Encode1(0),
    new CSendPacket(156).Encode1(0),
    new CSendPacket(151).Encode1(0).Encode1(1),
  ])
    expect(() => e.table.OnPacket(Received(p), e.clients[0]!)).toThrow(
      CProtocolError,
    );
  expect(() => e.table.DestroyPlayer(e.clients[1]!)).toThrow(CProtocolError);
  expect(() => e.room.DeleteAllUser(e.clients[1]!)).toThrow(CProtocolError);
  expect(() => e.room.PrepareRoundStatistics()).toThrow(CProtocolError);
  expect(() => e.room.SendGameTypeNormal()).toThrow(CProtocolError);
  e.table.UpdateGameSessions();
  expect(e.notices).toEqual([]);
  expect(e.room.DeferHandleGameEnd()).toBe(false);
  expect(DiscoverLaunchPeer(e.room, e.clients[1]!)).toBe(false);
  expect(SpecialLive(e)).toEqual(before);
  noClockOrRandom(e);
  repair(e);
  e.room.Update();
  expect(e.room.GetLastUpdateTime()).toBe(last);
  expect(e.room.GetSpecialItemUseState()).toEqual({
    Sequence: 1,
    Pending: false,
    Attempts: 3,
    Failure: undefined,
  });
  expect(e.room.GetCurrentGameContext().m_aPlayerStateTime[1]).toBe(12000);
  expect(e.room.m_aPlayerState[1]).toBe(3);
  expect(e.room.m_rgPlayer[1]!.m_aInventory[0]!.Amount).toBe(2);
  expect(nice(e)).toBe(1);
  wire(e, 1, 45);
  expect(e.table.GetPendingSpecialItemUseCount()).toBe(0);
});
test("lost ACK after REAL COMMIT plus mutated SQL/caller buffers reuses exact frozen plan/159 once; completed identical client requests are NEW spends, not exactly-once TCP", () => {
  const e = create(),
    before = SpecialLive(e),
    original = e.db.CommitSpecialItemUse,
    inputs: string[] = [];
  e.db.CommitSpecialItemUse = function (p) {
    inputs.push(freeze(p));
    const result = original.call(this, p);
    if (inputs.length === 1) {
      p.Packet.fill(0);
      throw new Error("lost ACK AFTER actual root COMMIT");
    }
    return result;
  };
  const caller = SpecialRequest();
  e.table.OnPacket(Received(caller), e.clients[0]!);
  caller.m_pBlock.fill(0);
  expect(SpecialLive(e)).toEqual(before);
  expect(SpecialReceiptCount(e.db)).toBe(1);
  expect(e.db.GetInventoryRecord(0x12345678)!.Amount).toBe(2);
  noPackets(e);
  noClockOrRandom(e);
  SendSpecial(e);
  wire(e);
  expect(inputs).toHaveLength(2);
  expect(inputs[0]).toBe(inputs[1]);
  expect(e.room.m_rgPlayer[1]!.m_aInventory[0]!.Amount).toBe(2);
  expect(e.room.GetSpecialItemUseState().Sequence).toBe(1);
  SendSpecial(e);
  wire(e);
  SendSpecial(e);
  wire(e);
  const u = e.room.m_rgPlayer[1]!;
  expect(u.m_aInventory).toHaveLength(1);
  expect(u.GetUserInventory(0x12345678)!.Amount).toBe(0);
  expect(u.IsInventoryModified(0x12345678)).toBe(1);
  expect(e.db.GetInventoryRecord(0x12345678)).toBeUndefined();
  expect(SpecialReceiptCount(e.db)).toBe(3);
  expect(e.room.GetSpecialItemUseState().Sequence).toBe(3);
  expect(() => SendSpecial(e)).toThrow(CProtocolError);
  expect(SpecialReceiptCount(e.db)).toBe(3);
  expect(e.room.IsSpecialItemUsePending()).toBe(false);
  noPackets(e);
});
test("every SQL inventory CAS field freezes rather than rebases; only explicit restoration of the ORIGINAL stored snapshot permits the SAME plan", () => {
  for (const [field, value] of Object.entries({
    SN: 5,
    ID: "Bob",
    ItemID: 1,
    Slot: 0,
    Amount: 4,
    ExpireDate: 1,
    Verbose: "changed",
    CreatedAt: 0,
  })) {
    const e = create(),
      row = { ...e.room.m_rgPlayer[1]!.m_aInventory[0]! },
      before = SpecialLive(e);
    e.session.db.query(`UPDATE FxUserInventory SET ${field}=?`).run(value);
    SendSpecial(e);
    expect(e.room.GetSpecialItemUseState().Failure).toBe("conflict");
    expect(SpecialLive(e)).toEqual(before);
    expect(SpecialReceiptCount(e.db)).toBe(0);
    noPackets(e);
    noClockOrRandom(e);
    store(e, row);
    e.room.Update();
    wire(e);
    expect(e.db.GetInventoryRecord(row.SN)!.Amount).toBe(2);
    expect(SpecialReceiptCount(e.db)).toBe(1);
  }
});
test("old duplicate receipt is NOT proof of CURRENT stored After: amount/owner/metadata drift and reappearing exhausted SN block all live installation without respend", () => {
  for (const [field, value] of Object.entries({
    SN: 5,
    ID: "Bob",
    ItemID: 1,
    Slot: 0,
    Amount: 3,
    ExpireDate: 1,
    Verbose: "changed",
    CreatedAt: 0,
  })) {
    const e = create(),
      row = { ...e.room.m_rgPlayer[1]!.m_aInventory[0]! },
      before = SpecialLive(e),
      root = e.db.CommitSpecialItemUse;
    e.db.CommitSpecialItemUse = function (p) {
      const s = root.call(this, p);
      throw new Error(`lost ${s}`);
    };
    SendSpecial(e);
    e.db.CommitSpecialItemUse = root;
    e.session.db.query(`UPDATE FxUserInventory SET ${field}=?`).run(value);
    noClockOrRandom(e);
    e.room.Update();
    expect(e.room.GetSpecialItemUseState().Failure).toBe(
      "stored-state-changed",
    );
    expect(SpecialLive(e)).toEqual(before);
    expect(SpecialReceiptCount(e.db)).toBe(1);
    noPackets(e);
    store(e, row, 2);
    e.room.Update();
    wire(e);
    expect(SpecialReceiptCount(e.db)).toBe(1);
  }
  const e = create(),
    row = { ...e.room.m_rgPlayer[1]!.m_aInventory[0]! },
    root = e.db.CommitSpecialItemUse;
  e.db.CommitSpecialItemUse = function (p) {
    root.call(this, p);
    throw new Error("lost final-use ACK");
  };
  SendSpecial(e, 1, 44, 3);
  e.db.CommitSpecialItemUse = root;
  expect(e.db.GetInventoryRecord(row.SN)).toBeUndefined();
  store(e, row);
  noClockOrRandom(e);
  e.room.Update();
  expect(e.room.GetSpecialItemUseState().Failure).toBe("stored-state-changed");
  expect(e.room.m_rgPlayer[1]!.m_aInventory[0]!.Amount).toBe(3);
  noPackets(e);
  e.session.db.exec("DELETE FROM FxUserInventory");
  e.room.Update();
  wire(e, 1, 44, 3);
  expect(e.room.m_rgPlayer[1]!.m_aInventory[0]!.Amount).toBe(0);
  expect(SpecialReceiptCount(e.db)).toBe(1);
});
test("frozen live inventory values, DIRTY intent and original array/row identities (including OTHER users) are checked before SQL and before installation", () => {
  for (const mutation of ["amount", "array", "row", "dirty", "other"]) {
    const e = create(),
      u = e.room.m_rgPlayer[1]!,
      container = u.m_aInventory,
      row = container[0]!;
    fault(e);
    SendSpecial(e);
    repair(e);
    const root = e.db.CommitSpecialItemUse;
    let calls = 0;
    e.db.CommitSpecialItemUse = function (p) {
      calls++;
      return root.call(this, p);
    };
    const other = e.room.m_rgPlayer[2]!,
      otherContainer = other.m_aInventory;
    if (mutation === "amount") row.Amount++;
    if (mutation === "array") u.m_aInventory = [row];
    if (mutation === "row") container[0] = { ...row };
    if (mutation === "dirty") {
      u.ConsumeUserInventory(row.SN, 1);
      row.Amount++;
    }
    if (mutation === "other") other.m_aInventory = [];
    const before = SpecialLive(e);
    noClockOrRandom(e);
    e.room.Update();
    expect(e.room.GetSpecialItemUseState().Failure).toBe("state-changed");
    expect(calls).toBe(0);
    expect(SpecialLive(e)).toEqual(before);
    noPackets(e);
    row.Amount = 3;
    container[0] = row;
    u.m_aInventory = container;
    other.m_aInventory = otherContainer;
    e.room.Update();
    wire(e);
    expect(calls).toBe(1);
  }
});
test("SQL callback live tampering AFTER root commit is caught before even one flag/inventory/timer install and never repays", () => {
  const e = create(),
    u = e.room.m_rgPlayer[1]!,
    row = u.m_aInventory[0]!,
    root = e.db.CommitSpecialItemUse;
  e.db.CommitSpecialItemUse = function (p) {
    const status = root.call(this, p);
    row.Amount = 99;
    return status;
  };
  SendSpecial(e);
  expect(e.room.GetSpecialItemUseState().Failure).toBe("state-changed");
  expect(row.Amount).toBe(99);
  expect(nice(e)).toBe(0);
  expect(e.room.m_aShopItemAttempted[1]).toBe(0);
  expect(e.db.GetInventoryRecord(row.SN)!.Amount).toBe(2);
  expect(SpecialReceiptCount(e.db)).toBe(1);
  noPackets(e);
  e.db.CommitSpecialItemUse = root;
  row.Amount = 3;
  noClockOrRandom(e);
  e.room.Update();
  wire(e);
  expect(row.Amount).toBe(2);
  expect(SpecialReceiptCount(e.db)).toBe(1);
});
test("truthful exact receipt/root ownership are REQUIRED: success strings, hidden readback, unknown statuses and enclosing savepoints cannot publish159", () => {
  for (const kind of ["fake", "unknown", "confirm", "read", "outer"]) {
    const e = create(),
      before = SpecialLive(e),
      root = e.db.CommitSpecialItemUse,
      confirm = e.db.ConfirmSpecialItemUse,
      read = e.db.GetInventoryRecord;
    if (kind === "fake") e.db.CommitSpecialItemUse = () => "committed";
    if (kind === "unknown")
      e.db.CommitSpecialItemUse = () => "invalid" as never;
    if (kind === "confirm") e.db.ConfirmSpecialItemUse = () => false;
    if (kind === "read")
      e.db.GetInventoryRecord = () => {
        throw new Error("fixture unavailable readback");
      };
    if (kind === "outer") e.session.db.transaction(() => SendSpecial(e))();
    else SendSpecial(e);
    expect(e.room.GetSpecialItemUseState().Failure).toBe("storage");
    expect(SpecialLive(e)).toEqual(before);
    noPackets(e);
    e.db.CommitSpecialItemUse = root;
    e.db.ConfirmSpecialItemUse = confirm;
    e.db.GetInventoryRecord = read;
    noClockOrRandom(e);
    e.room.Update();
    wire(e);
    expect(SpecialReceiptCount(e.db)).toBe(1);
    expect(e.db.GetInventoryRecord(0x12345678)!.Amount).toBe(2);
  }
});
test("a late adapter SQL transaction cannot confirm an uncommitted After even when the root receipt exists", () => {
  const e = create(),
    before = SpecialLive(e),
    root = e.db.CommitSpecialItemUse;
  e.db.CommitSpecialItemUse = function (p) {
    const status = root.call(this, p);
    e.session.db.exec("BEGIN IMMEDIATE");
    return status;
  };
  try {
    SendSpecial(e);
    expect(e.room.GetSpecialItemUseState().Failure).toBe("storage");
    expect(SpecialLive(e)).toEqual(before);
    noPackets(e);
  } finally {
    e.session.db.exec("ROLLBACK");
  }
  e.db.CommitSpecialItemUse = root;
  noClockOrRandom(e);
  e.room.Update();
  wire(e);
  expect(SpecialReceiptCount(e.db)).toBe(1);
});
test("durable external closure or vanished account after lost ACK does not authorize old inventory/live159, even though exact duplicate lookup still exists", () => {
  for (const action of ["close", "account"]) {
    const e = create(),
      before = SpecialLive(e),
      root = e.db.CommitSpecialItemUse;
    let captured: SpecialItemUseSubmission | undefined;
    e.db.CommitSpecialItemUse = function (p) {
      captured = p;
      root.call(this, p);
      throw new Error("lost ACK");
    };
    SendSpecial(e);
    e.db.CommitSpecialItemUse = root;
    if (action === "close")
      e.db.CommitGameResult(EmptySpecialResult(captured!));
    else
      e.session.db
        .query("DELETE FROM FxUserAccount WHERE ID=?")
        .run(captured!.Before.ID);
    noClockOrRandom(e);
    e.room.Update();
    expect(e.room.GetSpecialItemUseState().Failure).toBe(
      "stored-state-changed",
    );
    expect(SpecialLive(e)).toEqual(before);
    expect(SpecialReceiptCount(e.db)).toBe(1);
    noPackets(e);
  }
});
test("terminal actor detach, closed OTHER peer and stale local secondary are not offline consumption recipients at intake OR retry", () => {
  for (const mutate of [
    (e: NativeSpecialFixture) => e.clients[1]!.Close(),
    (e: NativeSpecialFixture) => e.room.m_rgPlayer[1]!.SetFree(),
    (e: NativeSpecialFixture) => {
      e.room.m_rgPlayer[1]!.m_nSessionSerialNo++;
    },
  ]) {
    const e = create();
    mutate(e);
    const before = SpecialLive(e);
    expect(() => SendSpecial(e)).toThrow(CProtocolError);
    expect(SpecialLive(e)).toEqual(before);
    expect(SpecialReceiptCount(e.db)).toBe(0);
    const f = create();
    fault(f);
    SendSpecial(f);
    repair(f);
    mutate(f);
    const frozen = SpecialLive(f);
    noClockOrRandom(f);
    f.room.Update();
    expect(f.room.GetSpecialItemUseState().Failure).toBe("state-changed");
    expect(SpecialLive(f)).toEqual(frozen);
    expect(SpecialReceiptCount(f.db)).toBe(0);
    noPackets(f);
  }
});
test("Type22 clock and SQL callbacks cannot reenter gameplay/driver/removal or change source during detached calculation; thrown clock leaves no frozen plan or SQL", () => {
  const e = create();
  e.room.m_aPlayerState[1] = 3;
  const before = SpecialLive(e);
  e.clock.ElapsedTime = () => {
    expect(() => SendSpecial(e)).toThrow(CProtocolError);
    expect(() => e.table.DestroyPlayer(e.clients[1]!)).toThrow(CProtocolError);
    e.room.Update();
    throw new Error("fixture clock failure");
  };
  expect(() => SendSpecial(e, 1, 45)).toThrow("fixture clock failure");
  expect(SpecialLive(e)).toEqual(before);
  expect(e.room.IsSpecialItemUsePending()).toBe(false);
  expect(SpecialReceiptCount(e.db)).toBe(0);
  noPackets(e);
  e.clock.ElapsedTime = () => {
    e.room.m_rgPlayer[1]!.m_aInventory[0]!.Verbose = "changed during clock";
    return 7;
  };
  expect(() => SendSpecial(e, 1, 45)).toThrow("source changed");
  expect(e.room.IsSpecialItemUsePending()).toBe(false);
  expect(SpecialReceiptCount(e.db)).toBe(0);
});
test("publication callbacks observe COMPLETE durable inventory/dirty/flags/Nice/time/key; whole sender socket excluded, first-recipient failure cannot corrupt later159 or replay a spend", () => {
  const e = create([2, 1, 1]),
    first = e.clients[1]!,
    original = first.SendPacket;
  e.room.m_aPlayerState[1] = 3;
  e.time(12345);
  let callbacks = 0,
    failure: unknown;
  const root = e.db.CommitSpecialItemUse;
  e.db.CommitSpecialItemUse = function (p) {
    expect(() => SendSpecial(e)).toThrow(CProtocolError);
    e.room.Update();
    return root.call(this, p);
  };
  first.SendPacket = function (p) {
    callbacks++;
    try {
      expect(SpecialReceiptCount(e.db)).toBe(1);
      const u = e.room.m_rgPlayer[1]!;
      expect(u.m_aInventory[0]!.Amount).toBe(2);
      expect(u.IsInventoryModified(0x12345678)).toBe(1);
      expect(e.room.m_aShopItemAttempted[1]).toBe(1);
      expect(nice(e)).toBe(1);
      expect(e.room.GetCurrentGameContext().m_aPlayerStateTime[1]).toBe(12245);
      expect(e.room.GetSpecialItemUseState().Sequence).toBe(1);
      expect(e.room.IsSpecialItemUsePending()).toBe(false);
      expect(() => SendSpecial(e)).toThrow(CProtocolError);
      expect(() => SendMoney(e)).toThrow(CProtocolError);
      expect(() => SendHouse(e)).toThrow(CProtocolError);
      expect(() => e.table.DestroyPlayer(e.clients[2]!)).toThrow(
        CProtocolError,
      );
      const before = SpecialLive(e);
      e.room.Update();
      expect(SpecialLive(e)).toEqual(before);
    } catch (error) {
      failure = error;
    }
    p.m_pBlock.fill(0);
    throw new Error("fixture first detached recipient failure");
  };
  try {
    SendSpecial(e, 1, 45);
  } finally {
    first.SendPacket = original;
  }
  expect(callbacks).toBe(1);
  expect(failure).toBeUndefined();
  expect(e.clients[0]!.packets).toEqual([]);
  expect(first.packets).toEqual([]);
  const later = e.clients[2]!.Take(159);
  expect(later.Decode1()).toBe(1);
  expect(later.Decode2()).toBe(0x80ff);
  expect(later.Decode2()).toBe(0xff80);
  expect([later.Decode1(), later.Decode1(), later.Decode1()]).toEqual([
    90, 45, 1,
  ]);
  later.AssertEnd();
  e.clear();
  e.room.Update();
  noPackets(e);
  expect(SpecialReceiptCount(e.db)).toBe(1);
  expect(e.room.GetPacketPublicationFailureCount()).toBe(1);
});
test("existing money/house pending plans also fingerprint inventories; all money/house/result freezes reject new special use before clocks/consumption", () => {
  for (const kind of ["money", "house", "result"]) {
    const e = create(),
      row = e.room.m_rgPlayer[1]!.m_aInventory[0]!;
    const table =
      kind === "money"
        ? "RuntimeMoneyPickup"
        : kind === "house"
          ? "RuntimeHouseClaim"
          : "RuntimeGameResult";
    e.session.db.exec(
      `CREATE TRIGGER TestOtherFail BEFORE INSERT ON ${table} BEGIN SELECT RAISE(FAIL,'fixture-other'); END`,
    );
    if (kind === "money") SendMoney(e);
    else if (kind === "house") SendHouse(e);
    else {
      e.time(20100);
      SubmitMoneyRoundClaims(e);
      e.clear();
      expect(() => e.room.UpdateResultLifecycle()).toThrow("fixture-other");
    }
    const before = SpecialLive(e);
    noClockOrRandom(e);
    expect(() => SendSpecial(e)).toThrow(CProtocolError);
    expect(SpecialLive(e)).toEqual(before);
    expect(SpecialReceiptCount(e.db)).toBe(0);
    e.session.db.exec("DROP TRIGGER TestOtherFail");
    if (kind !== "result") {
      row.Amount = 99;
      e.room.Update();
      expect(
        (kind === "money"
          ? e.room.GetMoneyPickupState()
          : e.room.GetHouseClaimState()
        ).Failure,
      ).toBe("state-changed");
      row.Amount = 3;
      e.room.Update();
      expect(e.room.IsGameplayCommitPending()).toBe(false);
    }
  }
});
test("ordinal exhaustion rejects paid use BEFORE clock/SQL/pending capture while quantity0 still relays; public diagnostics are detached/bounded and contain no inventory ID", () => {
  const e = create();
  (
    e.room as unknown as { m_resultRound: { SpecialSequence: number } }
  ).m_resultRound.SpecialSequence = 0xffffffff;
  noClockOrRandom(e);
  expect(() => SendSpecial(e)).toThrow("sequence exhausted");
  expect(e.room.IsSpecialItemUsePending()).toBe(false);
  expect(SpecialReceiptCount(e.db)).toBe(0);
  SendSpecial(e, 1, 44, 0);
  wire(e, 1, 44, 0);
  const state = e.room.GetSpecialItemUseState();
  expect(Object.keys(state).sort()).toEqual([
    "Attempts",
    "Failure",
    "Pending",
    "Sequence",
  ]);
  (state as { Sequence: number }).Sequence = 0;
  expect(e.room.GetSpecialItemUseState().Sequence).toBe(0xffffffff);
});
test("163 settlement and164 retain inventory/dirty, release binding; NEXT genuine106 clears Shop/Nice and new150 creates a NEW UUID/ordinal1 without restoring consumed stock", () => {
  const e = create(),
    u = e.room.m_rgPlayer[1]!,
    first = e.room.GetResultRoundID()!;
  SendSpecial(e);
  wire(e);
  expect(u.m_aInventory[0]!.Amount).toBe(2);
  e.time(20100);
  SubmitMoneyRoundClaims(e);
  e.room.UpdateResultLifecycle();
  expect(e.room.m_nGameState).toBe(GameStage.Result);
  expect(() => SendSpecial(e, 1, 44, 0)).toThrow(CProtocolError);
  expect(e.db.GetGameResultReceipt(first)).toBeDefined();
  e.clear();
  e.time(28101);
  expect(e.room.DeferReturnPrepareStage()).toBe(true);
  expect(e.room.m_nGameState).toBe(GameStage.Loading);
  expect(u.m_aInventory[0]!.Amount).toBe(2);
  expect(u.IsInventoryModified(0x12345678)).toBe(1);
  expect(e.room.GetSpecialItemUseState().Sequence).toBe(0);
  expect(e.room.GetResultRoundID()).toBeUndefined();
  expect(nice(e)).toBe(1);
  for (const p of e.clients.slice(1))
    e.table.OnPacket(Received(new CSendPacket(96).Encode1(1)), p);
  e.table.OnPacket(Received(new CSendPacket(106)), e.clients[0]!);
  expect(e.room.m_nGameState).toBe(GameStage.Loading);
  expect(e.room.m_aShopItemAttempted[1]).toBe(0);
  expect(nice(e)).toBe(0);
  expect(u.m_aInventory[0]!.Amount).toBe(2);
  for (const p of e.clients)
    e.table.OnPacket(Received(LaunchReadyPacket(e.room, p)), p);
  const second = e.room.GetResultRoundID()!;
  expect(second).not.toBe(first);
  expect(e.room.GetSpecialItemUseState().Sequence).toBe(0);
  e.clear();
  SendSpecial(e, 1, 44, 2);
  wire(e, 1, 44, 2);
  expect(e.room.GetSpecialItemUseState().Sequence).toBe(1);
  expect(u.m_aInventory[0]!.Amount).toBe(0);
  expect(e.db.GetInventoryRecord(0x12345678)).toBeUndefined();
  expect(SpecialReceiptCount(e.db)).toBe(2);
  expect(e.db.GetSpecialItemUseReceipt(second, 1)).toBeDefined();
});

test("frozen resource ROW identity and ALL FOUR clock markers detect same-Type reload/pause drift without clocks, and free Type22 rejects a reload during its one sample", () => {
  const e = create(),
    resource = LaunchItems.m_aItemAttr[44]!;
  fault(e);
  SendSpecial(e);
  repair(e);
  noClockOrRandom(e);
  try {
    LaunchItems.m_aItemAttr[44] = Object.freeze({ ...resource });
    e.room.Update();
    expect(e.room.GetSpecialItemUseState().Failure).toBe("state-changed");
    expect(SpecialReceiptCount(e.db)).toBe(0);
    noPackets(e);
  } finally {
    LaunchItems.m_aItemAttr[44] = resource;
  }
  e.room.Update();
  wire(e);
  expect(SpecialReceiptCount(e.db)).toBe(1);
  const f = create(),
    clockBefore = f.clock.GetStateSnapshot();
  fault(f);
  SendSpecial(f);
  repair(f);
  f.time(500);
  f.clock.SuspendGame();
  expect(f.clock.GetStateSnapshot()).toEqual({
    ...clockBefore,
    Suspended: 500,
  });
  noClockOrRandom(f);
  f.room.Update();
  expect(f.room.GetSpecialItemUseState().Failure).toBe("state-changed");
  expect(SpecialReceiptCount(f.db)).toBe(0);
  noPackets(f);
  f.clock.ResumeGame();
  expect(f.clock.GetStateSnapshot()).toEqual(clockBefore);
  f.room.Update();
  wire(f);
  expect(SpecialReceiptCount(f.db)).toBe(1);
  const g = create(),
    oxygen = LaunchItems.m_aItemAttr[45]!;
  g.room.m_aPlayerState[1] = 3;
  g.clock.ElapsedTime = () => {
    LaunchItems.m_aItemAttr[45] = Object.freeze({ ...oxygen });
    return 77;
  };
  try {
    expect(() => SendSpecial(g, 1, 45, 0)).toThrow("source changed");
    expect(g.room.IsSpecialItemUsePending()).toBe(false);
    expect(g.room.GetCurrentGameContext().m_aPlayerStateTime[1]).toBe(0);
    expect(SpecialReceiptCount(g.db)).toBe(0);
    noPackets(g);
  } finally {
    LaunchItems.m_aItemAttr[45] = oxygen;
  }
});
