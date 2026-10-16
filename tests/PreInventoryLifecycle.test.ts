import { afterEach, expect, test } from "bun:test";
import type { CUser } from "../Common/CUser.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CTextCodec } from "../Common/CTextCodec.ts";
import { ServerType } from "../Common/OfficialValues.ts";
import { CUserItemMan } from "../FXGS/CUserItemMan.ts";
import { PlanInitPreInventory } from "../FXGS/PreInventory.ts";
import { PreObservation, PreRow, PreState } from "./helpers/PreInventory.ts";
import { ChannelFixture } from "./helpers/Channel.ts";
import { MemoryClient } from "./helpers/Clients.ts";
import { UserInfo } from "./helpers/Accounts.ts";
import {
  NativeMoneyEnvironment,
  MoneyReceiptCount,
  SendMoney,
  SubmitMoneyRoundClaims,
  type NativeMoneyFixture,
} from "./helpers/MoneyPickup.ts";
import { SendHouse, HouseReceiptCount } from "./helpers/HouseClaim.ts";
import {
  SendSpecial,
  SeedSpecialInventory,
  SpecialLive,
  SpecialReceiptCount,
} from "./helpers/SpecialItemUse.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const preABA: readonly ((u: CUser) => void)[] = [
  (u) => u.InstallPreInventory(u.CapturePreInventory().Rows),
  (u) => {
    const rows = u.CapturePreInventory().Rows;
    u.InstallPreInventory([]);
    u.InstallPreInventory(rows);
  },
  (u) => {
    const rows = u.CapturePreInventory().Rows;
    u.InstallPreInventory([PreRow({ Amount: 777 })]);
    u.InstallPreInventory(rows);
  },
];
function drift(u: CUser, change = preABA[0]!) {
  const pre = u.CapturePreInventory(),
    dynamic = u.GetDynamicInfoSnapshot(),
    owned = u.GetInventoryStateSnapshot(),
    generation = u.GetUserInventoryGeneration();
  change(u);
  expect(u.CapturePreInventory().Rows).toEqual(pre.Rows);
  expect(u.GetPreInventoryGeneration()).toBeGreaterThan(pre.Revision);
  expect(u.GetDynamicInfoSnapshot()).toEqual(dynamic);
  expect(u.GetInventoryStateSnapshot()).toEqual(owned);
  expect(u.GetUserInventoryGeneration()).toEqual(generation);
}
function game() {
  const e = NativeMoneyEnvironment();
  cleanup.push(e.close);
  e.room.m_rgPlayer[1]!.InstallPreInventory([PreRow()]);
  e.room.m_rgPlayer[2]!.InstallPreInventory([PreRow({ SN: 32 })]);
  return e;
}
function noPackets(e: NativeMoneyFixture) {
  for (const p of e.clients) expect(p.packets).toEqual([]);
}
function noClockRandom(e: NativeMoneyFixture) {
  e.clock.GetCurrentTime = () => {
    throw new Error("pre-generation fence MUST precede clock");
  };
  e.clock.ElapsedTime = () => {
    throw new Error("pre-generation fence MUST precede elapsed time");
  };
  e.random(() => {
    throw new Error("pre-generation fence MUST precede random");
  });
}
function resultCount(e: NativeMoneyFixture) {
  return e.session.db
    .query<{ n: number }, []>("SELECT count(*) AS n FROM RuntimeGameResult")
    .get()!.n;
}
function transfer() {
  let clockHook: (() => void) | undefined;
  const c = ChannelFixture(() => {
      clockHook?.();
      return 1800000000000;
    }),
    source = new MemoryClient(),
    target = new MemoryClient();
  cleanup.push(
    () => source.Close(),
    () => target.Close(),
  );
  const users = c.ls.RegisterConnection(source, [
    UserInfo("NativeA"),
    UserInfo("NativeB"),
  ]);
  users.forEach((u) => u.InstallPreInventory([PreRow()]));
  const ids = users.map((u) => ({
    ID: u.GetName(),
    GlobalSerialNo: u.GetGlobalSerialNo(),
    GuildSn: u.m_userInfo.GuildSn,
  }));
  expect(c.ls.RequestConnection(source, ServerType.FXGame, 0).result).toBe(1);
  return {
    ...c,
    source,
    target,
    users,
    ids,
    pending: users[0]!.m_pendingConnection!,
    setHook(hook: () => void) {
      clockHook = hook;
    },
    authorize: () => c.gs.AuthorizeConnection(target, ids),
  };
}

test("pre projection/trusted install/207 are read-side ONLY: native pre SN colliding with legacy pre/owned SN cannot grant, remove or migrate any SQLite data/receipt", () => {
  const e = game(),
    u = e.room.m_rgPlayer[1]!;
  e.session.db.exec(
    "INSERT INTO FxItem(SN,Category,strAttr,nAttr1,nAttr2,nAttr3,strName) VALUES(7,100,'catalog',0,0,0,'money'),(8,101,'catalog',0,0,0,'exp'),(9,9,'catalog',0,0,0,'premium'); INSERT INTO FxUserInventory(SN,ID,ItemID,Amount) VALUES(31,'Partner',7,3); INSERT INTO FxPreInventory(SN,ID,ItemID,Amount,Verbose) VALUES(31,'Partner',7,3,'legacy pre')",
  );
  const manager = new CUserItemMan(e.db),
    dynamic = u.GetDynamicInfoSnapshot(),
    owned = u.GetInventoryStateSnapshot(),
    account = e.db.GetUserInfo("Partner"),
    oldPre = e.session.db.query("SELECT * FROM FxPreInventory").all(),
    oldOwned = e.db.GetInventoryRecord(31),
    changes = () =>
      e.session.db
        .query<{ n: number }, []>("SELECT total_changes() AS n")
        .get()!.n,
    before = changes();
  const plan = PlanInitPreInventory(
    [
      PreObservation({ ItemSn: 7, Amount: 100000 }),
      PreObservation({ ItemSn: 8, Amount: 100000 }),
      PreObservation({ ItemSn: 9 }),
    ],
    manager.CaptureSnapshot(),
    PreState({
      ID: u.GetName(),
      GlobalSerialNo: u.GetGlobalSerialNo(),
      Money: u.m_userInfo.Money,
      Exp: u.GetExp(),
      Level: u.GetLevel(),
      Authencode: u.GetAuthencode(),
    }),
  );
  expect(plan.After.Money).toBe(100000);
  expect(plan.After.Exp).toBe(100000);
  expect(
    plan.Events.filter((event) => event.Kind === "SendAuthenCode"),
  ).toHaveLength(1);
  u.InstallPreInventory(plan.Rows);
  const p = new CSendPacket(207).Encode1(1);
  u.MakePreInventoryPacket(p, manager.CaptureSnapshot());
  expect(u.GetPreInventoryCount()).toBe(3);
  expect(u.GetDynamicInfoSnapshot()).toEqual(dynamic);
  expect(u.GetInventoryStateSnapshot()).toEqual(owned);
  expect(e.db.GetUserInfo("Partner")).toEqual(account);
  expect(e.session.db.query("SELECT * FROM FxPreInventory").all()).toEqual(
    oldPre,
  );
  expect(e.db.GetInventoryRecord(31)).toEqual(oldOwned);
  expect(changes()).toBe(before);
  expect([
    MoneyReceiptCount(e.db),
    HouseReceiptCount(e.db),
    SpecialReceiptCount(e.db),
    resultCount(e),
  ]).toEqual([0, 0, 0, 0]);
  expect(e.session.db.query("PRAGMA user_version").get()).toEqual({
    user_version: 6,
  });
  noPackets(e);
});

test("Center WHOLE-group authorization fences pre-only identical reinstall and empty/changed/pre ABA on SECOND local, without detaching or consuming anyone", () => {
  for (const change of preABA) {
    const c = transfer(),
      lease = c.authorize();
    drift(c.users[1]!, change);
    expect(() => c.gs.CheckConnectionAuthorization(c.target, lease)).toThrow(
      "changed",
    );
    // Check revoked the issued lease; reuse is stale, not another live check.
    expect(() => c.gs.ConfirmAuthorizedConnection(c.target, lease)).toThrow(
      "Stale",
    );
    expect(c.source.m_aUser).toEqual(c.users);
    expect(c.target.m_aUser).toEqual([]);
    expect(
      c.users.every(
        (u) =>
          u.m_pendingConnection === c.pending && u.m_pClientSocket === c.source,
      ),
    ).toBe(true);
    expect(c.gs.ReleaseConnectionAuthorization(c.target, lease)).toBe(false);
    // A NEW identity lease can observe the new read-side generation. It does
    // NOT authorize replaying the projection's financial / SQL prefix effects.
    const next = c.authorize();
    expect(c.gs.ConfirmAuthorizedConnection(c.target, next)).toEqual(c.users);
  }
});

test("pre-only replacement INSIDE a Center clock callback is rechecked before consuming the lease", () => {
  const c = transfer(),
    lease = c.authorize();
  let called = false;
  c.setHook(() => {
    if (!called) {
      called = true;
      drift(c.users[0]!);
    }
  });
  expect(() => c.gs.ConfirmAuthorizedConnection(c.target, lease)).toThrow(
    "changed",
  );
  expect(called).toBe(true);
  expect(c.source.m_aUser).toEqual(c.users);
  expect(c.target.m_aUser).toEqual([]);
});

test("rejected pre install does NOT silently bump its generation or invalidate a valid identity lease", () => {
  const c = transfer(),
    lease = c.authorize(),
    before = c.users[1]!.CapturePreInventory();
  expect(() =>
    c.users[1]!.InstallPreInventory([PreRow({ Type: 256 })]),
  ).toThrow();
  expect(c.users[1]!.CapturePreInventory()).toEqual(before);
  expect(c.gs.ConfirmAuthorizedConnection(c.target, lease)).toEqual(c.users);
});

test("pending MONEY pre-only ABA stays frozen BEFORE storage/clock/random, with zero receipts/live After/156 and no financial rebase", () => {
  for (const change of preABA) {
    const e = game();
    e.session.db.exec(
      "CREATE TRIGGER PreMoneyFail BEFORE INSERT ON RuntimeMoneyPickup BEGIN SELECT RAISE(FAIL,'fixture'); END",
    );
    SendMoney(e);
    expect(e.room.GetMoneyPickupState().Failure).toBe("storage");
    e.session.db.exec("DROP TRIGGER PreMoneyFail");
    drift(e.room.m_rgPlayer[1]!, change);
    const before = SpecialLive(e);
    e.db.CommitMoneyPickup = () => {
      throw new Error("MUST NOT retry money storage after pre ABA");
    };
    noClockRandom(e);
    e.room.Update();
    expect(e.room.GetMoneyPickupState().Failure).toBe("state-changed");
    expect(e.room.GetMoneyPickupState().Pending).toBe(true);
    expect(SpecialLive(e)).toEqual(before);
    expect(MoneyReceiptCount(e.db)).toBe(0);
    noPackets(e);
  }
});

test("pending HOUSE fences pre-only drift of an unrelated room occupant, not just the claiming wallet", () => {
  const e = game();
  e.session.db.exec(
    "CREATE TRIGGER PreHouseFail BEFORE INSERT ON RuntimeHouseClaim BEGIN SELECT RAISE(FAIL,'fixture'); END",
  );
  SendHouse(e);
  expect(e.room.GetHouseClaimState().Failure).toBe("storage");
  e.session.db.exec("DROP TRIGGER PreHouseFail");
  drift(e.room.m_rgPlayer[2]!);
  const before = SpecialLive(e);
  e.db.CommitHouseClaim = () => {
    throw new Error("MUST NOT retry house storage after pre drift");
  };
  noClockRandom(e);
  e.room.Update();
  expect(e.room.GetHouseClaimState().Failure).toBe("state-changed");
  expect(SpecialLive(e)).toEqual(before);
  expect(HouseReceiptCount(e.db)).toBe(0);
  noPackets(e);
});

test("pending LEGACY paid use fences unrelated pre-only drift WITHOUT treating pre SN/ItemSn/StockSn as owned authorization", () => {
  const e = game(),
    stock = SeedSpecialInventory(e);
  e.session.db.exec(
    "CREATE TRIGGER PrePaidFail BEFORE INSERT ON RuntimeSpecialItemUse BEGIN SELECT RAISE(FAIL,'fixture'); END",
  );
  SendSpecial(e, 1, 44, 1, stock.SN);
  expect(e.room.GetSpecialItemUseState().Failure).toBe("storage");
  e.session.db.exec("DROP TRIGGER PrePaidFail");
  drift(e.room.m_rgPlayer[2]!);
  const before = SpecialLive(e);
  e.db.CommitSpecialItemUse = () => {
    throw new Error("MUST NOT retry paid storage after pre drift");
  };
  noClockRandom(e);
  e.room.Update();
  expect(e.room.GetSpecialItemUseState().Failure).toBe("state-changed");
  expect(SpecialLive(e)).toEqual(before);
  expect(e.db.GetInventoryRecord(stock.SN)!.Amount).toBe(3);
  expect(SpecialReceiptCount(e.db)).toBe(0);
  noPackets(e);
});

test("real-launch frozen RESULT rejects pre-only identical/empty/changed ABA BEFORE retrying storage, without readiness injection", () => {
  for (const change of preABA) {
    const e = game(),
      commit = e.db.CommitGameResult.bind(e.db);
    let calls = 0;
    e.db.CommitGameResult = () => {
      calls++;
      return "conflict";
    };
    e.time(30100);
    SubmitMoneyRoundClaims(e);
    e.clear();
    expect(e.room.UpdateResultLifecycle()).toBe(false);
    expect(e.room.IsResultCommitPending()).toBe(true);
    drift(e.room.m_rgPlayer[1]!, change);
    const before = SpecialLive(e);
    e.db.CommitGameResult = (input) => {
      calls++;
      return commit(input);
    };
    expect(() => e.room.UpdateResultLifecycle()).toThrow(
      "Pending game result changed",
    );
    expect(calls).toBe(1);
    expect(SpecialLive(e)).toEqual(before);
    expect(resultCount(e)).toBe(0);
    noPackets(e);
  }
});

test("pre-only drift INSIDE committed MONEY callback preserves durable SQL/receipt but blocks ALL live After/156 and retry", () => {
  const e = game(),
    u = e.room.m_rgPlayer[1]!,
    commit = e.db.CommitMoneyPickup.bind(e.db);
  let calls = 0;
  e.db.CommitMoneyPickup = (input) => {
    calls++;
    const r = commit(input);
    drift(u);
    return r;
  };
  SendMoney(e);
  expect(calls).toBe(1);
  expect(MoneyReceiptCount(e.db)).toBe(1);
  expect(e.db.GetUserInfo("Partner")!.Money).toBe(10);
  expect(u.m_userInfo.Money).toBe(0);
  expect(e.room.GetMoneyPickupState().Failure).toBe("state-changed");
  const before = SpecialLive(e);
  noClockRandom(e);
  e.room.Update();
  expect(calls).toBe(1);
  expect(SpecialLive(e)).toEqual(before);
  noPackets(e);
});

test("pre-only drift INSIDE committed HOUSE callback preserves existing receipt, never fakes a rollback, and blocks live world/178", () => {
  const e = game(),
    commit = e.db.CommitHouseClaim.bind(e.db);
  e.db.CommitHouseClaim = (input) => {
    const r = commit(input);
    drift(e.room.m_rgPlayer[2]!);
    return r;
  };
  const before = SpecialLive(e);
  SendHouse(e);
  expect(HouseReceiptCount(e.db)).toBe(1);
  expect(e.db.GetUserInfo("Partner")!.Money).toBe(10);
  expect(e.room.GetHouseClaimState().Failure).toBe("state-changed");
  expect(SpecialLive(e)).toEqual(before);
  noPackets(e);
});

test("pre-only drift INSIDE committed LEGACY paid callback keeps SQL decrement but blocks live stock/Shop/Nice/159", () => {
  const e = game(),
    stock = SeedSpecialInventory(e),
    commit = e.db.CommitSpecialItemUse.bind(e.db);
  e.db.CommitSpecialItemUse = (input) => {
    const r = commit(input);
    drift(e.room.m_rgPlayer[2]!);
    return r;
  };
  const before = SpecialLive(e);
  SendSpecial(e, 1, 44, 1, stock.SN);
  expect(SpecialReceiptCount(e.db)).toBe(1);
  expect(e.db.GetInventoryRecord(stock.SN)!.Amount).toBe(2);
  expect(e.room.GetSpecialItemUseState().Failure).toBe("state-changed");
  expect(SpecialLive(e)).toEqual(before);
  noPackets(e);
});

test("pre-only drift INSIDE committed RESULT callback rechecks AFTER storage: receipt remains durable, no counters/stage/163, no replay", () => {
  const e = game(),
    commit = e.db.CommitGameResult.bind(e.db);
  let calls = 0;
  e.time(30100);
  SubmitMoneyRoundClaims(e);
  e.clear();
  const before = SpecialLive(e);
  e.db.CommitGameResult = (input) => {
    calls++;
    const r = commit(input);
    drift(e.room.m_rgPlayer[1]!);
    return r;
  };
  expect(() => e.room.UpdateResultLifecycle()).toThrow("changed after storage");
  expect(resultCount(e)).toBe(1);
  expect(e.room.IsResultCommitPending()).toBe(true);
  expect(SpecialLive(e)).toEqual(before);
  expect(() => e.room.UpdateResultLifecycle()).toThrow(
    "Pending game result changed",
  );
  expect(calls).toBe(1);
  expect(SpecialLive(e)).toEqual(before);
  noPackets(e);
});

test("an OLD real immutable catalog snapshot survives SQLite reload INSIDE codec; new projection/207 explicitly sees new Category", () => {
  const e = game();
  e.session.db.exec(
    "INSERT INTO FxItem(SN,Category,strAttr,nAttr1,nAttr2,nAttr3,strName) VALUES(7,2,'catalog',0,0,0,'NOT pre text')",
  );
  const manager = new CUserItemMan(e.db),
    old = manager.CaptureSnapshot(),
    u = e.room.m_rgPlayer[1]!,
    expected = new CSendPacket(207).Encode1(1);
  u.MakePreInventoryPacket(expected, old);
  const text = new CTextCodec(),
    encode = text.Encode.bind(text);
  let called = false;
  text.Encode = (s) => {
    if (!called) {
      called = true;
      e.session.db.exec("UPDATE FxItem SET Category=101 WHERE SN=7");
      manager.UpdateUserItemTable();
    }
    return encode(s);
  };
  const actual = new CSendPacket(207, undefined, text).Encode1(1);
  u.MakePreInventoryPacket(actual, old);
  expect(called).toBe(true);
  expect(actual.GetBuffer()).toEqual(expected.GetBuffer());
  expect(old.GetUserItem(7)!.Category).toBe(2);
  const plan = PlanInitPreInventory(
    [PreObservation()],
    manager.CaptureSnapshot(),
    PreState(),
  );
  expect(plan.Events.some((event) => event.Kind === "IncDecExp")).toBe(true);
  expect(plan.CatalogRevision).toBe(old.Revision + 1);
  const next = new CSendPacket(207).Encode1(1);
  u.MakePreInventoryPacket(next, manager.CaptureSnapshot());
  expect(next.GetBuffer()).not.toEqual(expected.GetBuffer());
  // Changing ONLY the cached level, not Exp, must also change the wire WORD.
  Reflect.set(u, "m_nLevel", 17);
  const cached = new CSendPacket(207).Encode1(1);
  u.MakePreInventoryPacket(cached, manager.CaptureSnapshot());
  expect(cached.GetBuffer()).not.toEqual(next.GetBuffer());
});
