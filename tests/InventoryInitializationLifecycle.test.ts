import { afterEach, expect, test } from "bun:test";
import { CUser } from "../Common/CUser.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { ServerType } from "../Common/OfficialValues.ts";
import { DBTime } from "./helpers/Calendar.ts";
import { UserInfo } from "./helpers/Accounts.ts";
import { MemoryClient, Received } from "./helpers/Clients.ts";
import { ChannelFixture } from "./helpers/Channel.ts";
import {
  InitializationFixture,
  InitializationInput,
} from "./helpers/InventoryInitialization.ts";
import { NativeInventory } from "./helpers/UserInventory.ts";
import { PreObservation, PreRow } from "./helpers/PreInventory.ts";
import {
  NativeMoneyEnvironment,
  MoneyReceiptCount,
  SendMoney,
  SubmitMoneyRoundClaims,
  type NativeMoneyFixture,
} from "./helpers/MoneyPickup.ts";
import { SendHouse } from "./helpers/HouseClaim.ts";
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
function pair(u: CUser) {
  u.InstallUserInventoryInitialization(
    [NativeInventory({ Slot: 255 })],
    [PreRow()],
  );
}
function samePair(u: CUser) {
  const before = u.CaptureUserInventoryInitialization(),
    dynamic = u.GetDynamicInfoSnapshot();
  u.InstallUserInventoryInitialization(before.Owned!.Rows, before.Pre.Rows);
  const after = u.CaptureUserInventoryInitialization();
  expect(after.Owned!.Rows).toEqual(before.Owned!.Rows);
  expect(after.Pre.Rows).toEqual(before.Pre.Rows);
  expect([after.Owned!.Revision, after.Pre.Revision]).toEqual([
    before.Owned!.Revision + 1,
    before.Pre.Revision + 1,
  ]);
  expect(u.GetDynamicInfoSnapshot()).toEqual(dynamic);
}
function game() {
  const e = NativeMoneyEnvironment();
  cleanup.push(e.close);
  pair(e.room.m_rgPlayer[1]!);
  pair(e.room.m_rgPlayer[2]!);
  return e;
}
function noPackets(e: NativeMoneyFixture) {
  for (const p of e.clients) expect(p.packets).toEqual([]);
}
function noClockRandom(e: NativeMoneyFixture) {
  e.clock.GetCurrentTime = () => {
    throw new Error("MUST NOT sample stale plan clock");
  };
  e.clock.ElapsedTime = () => {
    throw new Error("MUST NOT sample stale elapsed time");
  };
  e.random(() => {
    throw new Error("MUST NOT draw stale plan random");
  });
}
function resultCount(e: NativeMoneyFixture) {
  return e.session.db
    .query<{ n: number }, []>("SELECT count(*) n FROM RuntimeGameResult")
    .get()!.n;
}
function transfer() {
  let hook: (() => void) | undefined;
  const e = ChannelFixture(() => {
      hook?.();
      return 1800000000000;
    }),
    source = new MemoryClient(),
    target = new MemoryClient();
  cleanup.push(
    () => source.Close(),
    () => target.Close(),
  );
  const users = e.ls.RegisterConnection(source, [
    UserInfo("First"),
    UserInfo("Second"),
  ]);
  users.forEach(pair);
  const ids = users.map((u) => ({
    ID: u.GetName(),
    GlobalSerialNo: u.GetGlobalSerialNo(),
    GuildSn: u.m_userInfo.GuildSn,
  }));
  expect(e.ls.RequestConnection(source, ServerType.FXGame, 0).result).toBe(1);
  return {
    ...e,
    source,
    target,
    users,
    ids,
    hook(next: () => void) {
      hook = next;
    },
  };
}

test("Center lease rejects a paired same-value reload on SECOND local; failed paired preflight preserves the old lease and never consumes first local", () => {
  const e = transfer(),
    lease = e.gs.AuthorizeConnection(e.target, e.ids),
    second = e.users[1]!;
  const before = second.CaptureUserInventoryInitialization();
  expect(() =>
    second.InstallUserInventoryInitialization([], [PreRow({ Slot: 256 })]),
  ).toThrow();
  expect(second.CaptureUserInventoryInitialization()).toEqual(before);
  expect(() =>
    e.gs.CheckConnectionAuthorization(e.target, lease),
  ).not.toThrow();
  samePair(second);
  expect(() => e.gs.ConfirmAuthorizedConnection(e.target, lease)).toThrow();
  expect(e.source.m_aUser).toEqual(e.users);
  expect(e.target.m_aUser).toEqual([]);
  expect(
    e.users.every(
      (u) => u.m_pClientSocket === e.source && u.m_pendingConnection,
    ),
  ).toBe(true);
});

test("paired ABA INSIDE Center's clock callback is caught AFTER callout, before whole-group consumption, with no invented calendar/financial lease authority", () => {
  const e = transfer(),
    lease = e.gs.AuthorizeConnection(e.target, e.ids);
  let armed = true;
  e.hook(() => {
    if (armed) {
      armed = false;
      samePair(e.users[1]!);
    }
  });
  expect(() => e.gs.ConfirmAuthorizedConnection(e.target, lease)).toThrow();
  expect(e.source.m_aUser).toEqual(e.users);
  expect(e.target.m_aUser).toEqual([]);
  expect(e.target.packets).toEqual([]);
});

test("actual channel209 consumer publishes TWO local native201 bodies installed as pairs; pre SN and StockSn never replace ItemSn or leak as owned rows", async () => {
  const { pool } = ChannelFixture(),
    peer = new MemoryClient();
  cleanup.push(() => peer.Close());
  const expected = new CSendPacket(201).Encode1(2);
  for (let i = 0; i < 2; i++) {
    const u = new CUser(UserInfo(`Pair${i}`), i + 1);
    u.InstallUserInventoryInitialization(
      [
        NativeInventory({
          ItemSn: 7 + i,
          StockSn: 0xfedcba98,
          Amount: i + 3,
          Slot: 255,
        }),
      ],
      [PreRow({ SN: 7 + i, ItemSn: 999, StockSn: 7 + i })],
    );
    u.m_pClientSocket = peer;
    peer.m_aUser.push(u);
    u.MakeUserInventoryPacket(expected);
  }
  const before = peer.m_aUser.map((u) =>
    u.CaptureUserInventoryInitialization(),
  );
  pool.AddNewSocket(peer);
  peer.Clear();
  await pool.OnPacket(Received(new CSendPacket(209)), peer);
  expect(peer.Take(201).m_pBlock).toEqual(expected.GetBuffer());
  expect(peer.packets).toEqual([]);
  expect(
    peer.m_aUser.map((u) => u.CaptureUserInventoryInitialization()),
  ).toEqual(before);
});

test("composite projection plus paired read-side install cannot apply XP/money/premium/flush or mutate colliding legacy SQLite inventory/pre/receipts/schema", () => {
  const e = InitializationFixture();
  cleanup.push(e.close);
  e.session.db.exec(
    "INSERT INTO FxUserAccount(ID,UserHashNo,Password) VALUES('Native',0,'disabled-test-fixture'); INSERT INTO FxUserDynamic(ID,Exp,Money,TicketDate) VALUES('Native',0,37,12345); INSERT INTO FxUserInventory(SN,ID,ItemID,Amount) VALUES(31,'Native',7,3); INSERT INTO FxPreInventory(SN,ID,ItemID,Amount,Verbose) VALUES(31,'Native',7,3,'legacy pre')",
  );
  const u = new CUser(e.db.GetUserInfo("Native")!, 0x89abcdef),
    before = u.GetDynamicInfoSnapshot(),
    account = e.db.GetUserInfo("Native"),
    stock = e.db.GetInventoryRecord(31),
    pre = e.session.db.query("SELECT * FROM FxPreInventory").all(),
    changes = () =>
      e.session.db.query<{ n: number }, []>("SELECT total_changes() n").get()!
        .n,
    changed = changes();
  const plan = e.db.PlanInitUserInventory(
    {
      ...InitializationInput(),
      PreRows: [
        PreObservation({ ItemSn: 8, Amount: 1000000 }),
        PreObservation({ ItemSn: 9, Amount: 1000 }),
        PreObservation({ ItemSn: 10 }),
      ],
    },
    e.items,
    e.clock,
  );
  if (plan.Stage !== "complete") throw new Error("complete");
  expect(plan.Pre.After.Exp).toBe(1000000);
  expect(plan.Pre.After.Money).toBe(1037);
  u.InstallUserInventoryInitialization(
    plan.Owned.Rows,
    plan.Pre.Rows,
    plan.Owned.Equipment,
  );
  expect(u.GetDynamicInfoSnapshot()).toEqual(before);
  expect(u.GetAuthencode()).toBe(0);
  expect(e.db.GetUserInfo("Native")).toEqual(account);
  expect(e.db.GetInventoryRecord(31)).toEqual(stock);
  expect(e.session.db.query("SELECT * FROM FxPreInventory").all()).toEqual(pre);
  expect(changes()).toBe(changed);
  expect(e.session.db.query("PRAGMA user_version").get()).toEqual({
    user_version: 6,
  });
  for (const table of [
    "RuntimeMoneyPickup",
    "RuntimeHouseClaim",
    "RuntimeSpecialItemUse",
    "RuntimeGameResult",
  ])
    expect(e.session.db.query(`SELECT count(*) n FROM ${table}`).get()).toEqual(
      { n: 0 },
    );
  // A clock generation is not a grant, replay authorization, or live installer.
  e.clock.SyncLocalTimeFromDB(0, DBTime());
  expect(u.GetDynamicInfoSnapshot()).toEqual(before);
});

test("pending MONEY freezes a same-byte paired reload BEFORE SQL/clock/random; both new revisions do not authorize a new financial plan or pre replay", () => {
  const e = game();
  e.session.db.exec(
    "CREATE TRIGGER PairMoneyFail BEFORE INSERT ON RuntimeMoneyPickup BEGIN SELECT RAISE(FAIL,'fixture'); END",
  );
  SendMoney(e);
  expect(e.room.GetMoneyPickupState().Failure).toBe("storage");
  e.session.db.exec("DROP TRIGGER PairMoneyFail");
  samePair(e.room.m_rgPlayer[1]!);
  const before = SpecialLive(e);
  e.db.CommitMoneyPickup = () => {
    throw new Error("MUST NOT retry paired drift");
  };
  noClockRandom(e);
  e.room.Update();
  expect(e.room.GetMoneyPickupState().Failure).toBe("state-changed");
  expect(e.room.GetMoneyPickupState().Pending).toBe(true);
  expect(SpecialLive(e)).toEqual(before);
  expect(MoneyReceiptCount(e.db)).toBe(0);
  noPackets(e);
});

test("pending HOUSE and legacy PAID fence an unrelated occupant's paired reload, not just the actor's wallet or matching ItemSn", () => {
  for (const kind of ["house", "paid"]) {
    const e = game();
    // Keep claimant's legacy paid layout distinct from the unrelated native pair.
    if (kind === "paid") e.room.m_rgPlayer[1]!.m_aInventory = [];
    const stock = kind === "paid" ? SeedSpecialInventory(e) : undefined;
    const table =
      kind === "paid" ? "RuntimeSpecialItemUse" : "RuntimeHouseClaim";
    e.session.db.exec(
      `CREATE TRIGGER PairFail BEFORE INSERT ON ${table} BEGIN SELECT RAISE(FAIL,'fixture'); END`,
    );
    if (stock) SendSpecial(e, 1, 44, 1, stock.SN);
    else SendHouse(e);
    expect(
      stock
        ? e.room.GetSpecialItemUseState().Failure
        : e.room.GetHouseClaimState().Failure,
    ).toBe("storage");
    e.session.db.exec("DROP TRIGGER PairFail");
    samePair(e.room.m_rgPlayer[2]!);
    const before = SpecialLive(e);
    e.db.CommitHouseClaim = () => {
      throw new Error("MUST NOT retry house pair drift");
    };
    e.db.CommitSpecialItemUse = () => {
      throw new Error("MUST NOT retry paid pair drift");
    };
    noClockRandom(e);
    e.room.Update();
    expect(
      stock
        ? e.room.GetSpecialItemUseState().Failure
        : e.room.GetHouseClaimState().Failure,
    ).toBe("state-changed");
    expect(SpecialLive(e)).toEqual(before);
    expect(e.session.db.query(`SELECT count(*) n FROM ${table}`).get()).toEqual(
      { n: 0 },
    );
    if (stock) expect(e.db.GetInventoryRecord(stock.SN)!.Amount).toBe(3);
    noPackets(e);
  }
});

test("real-launch pending RESULT rejects paired same-value generation drift BEFORE retrying storage or changing live counters/readiness/163", () => {
  const e = game();
  let commits = 0;
  e.db.CommitGameResult = () => {
    commits++;
    return "conflict";
  };
  e.time(30100);
  SubmitMoneyRoundClaims(e);
  e.clear();
  expect(e.room.UpdateResultLifecycle()).toBe(false);
  expect(e.room.IsResultCommitPending()).toBe(true);
  samePair(e.room.m_rgPlayer[1]!);
  const before = SpecialLive(e);
  expect(() => e.room.UpdateResultLifecycle()).toThrow(
    "Pending game result changed",
  );
  expect(commits).toBe(1);
  expect(resultCount(e)).toBe(0);
  expect(SpecialLive(e)).toEqual(before);
  noPackets(e);
});

test("paired reload AFTER real MONEY COMMIT keeps durable receipt/SQL but blocks live publication and cannot pay again", () => {
  const e = game(),
    u = e.room.m_rgPlayer[1]!,
    commit = e.db.CommitMoneyPickup.bind(e.db);
  let calls = 0;
  e.db.CommitMoneyPickup = (input) => {
    calls++;
    const result = commit(input);
    samePair(u);
    return result;
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
  e.room.Update();
  expect(calls).toBe(1);
  expect(SpecialLive(e)).toEqual(before);
  noPackets(e);
});

test("paired reload AFTER RESULT COMMIT is rechecked before live effects; durable receipt survives and old frozen plan is not rebased or replayed", () => {
  const e = game(),
    commit = e.db.CommitGameResult.bind(e.db);
  let calls = 0;
  e.time(30100);
  SubmitMoneyRoundClaims(e);
  e.clear();
  const before = SpecialLive(e);
  e.db.CommitGameResult = (input) => {
    calls++;
    const result = commit(input);
    samePair(e.room.m_rgPlayer[1]!);
    return result;
  };
  expect(() => e.room.UpdateResultLifecycle()).toThrow("changed after storage");
  expect(resultCount(e)).toBe(1);
  expect(e.room.IsResultCommitPending()).toBe(true);
  expect(SpecialLive(e)).toEqual(before);
  expect(() => e.room.UpdateResultLifecycle()).toThrow(
    "Pending game result changed",
  );
  expect(calls).toBe(1);
  noPackets(e);
});

test("paired native installation still rejects positive paid before legacy CAS; qty0 relay uses neither stock nor pre list and creates no receipt", () => {
  const e = game(),
    u = e.room.m_rgPlayer[1]!,
    before = u.CaptureUserInventoryInitialization();
  let calls = 0;
  e.db.CommitSpecialItemUse = () => {
    calls++;
    throw new Error("MUST NOT call legacy CAS");
  };
  expect(() => SendSpecial(e, 1, 44, 1, 7)).toThrow(
    "Native inventory persistence",
  );
  expect(calls).toBe(0);
  expect(SpecialReceiptCount(e.db)).toBe(0);
  noPackets(e);
  u.GetUserInventory = () => {
    throw new Error("qty0 MUST NOT lookup stock");
  };
  SendSpecial(e, 1, 44, 0);
  expect(calls).toBe(0);
  expect(e.clients[0]!.packets).toEqual([]);
  e.clients[1]!.Take(159);
  expect(u.CaptureUserInventoryInitialization()).toEqual(before);
  expect(SpecialReceiptCount(e.db)).toBe(0);
});

test("a rejected SECOND-list pair preflight does not revoke an already-issued Center lease; successful single-use consume still transfers the entire original group", () => {
  const e = transfer(),
    lease = e.gs.AuthorizeConnection(e.target, e.ids),
    second = e.users[1]!,
    before = second.CaptureUserInventoryInitialization();
  expect(() =>
    second.InstallUserInventoryInitialization(
      [NativeInventory()],
      [PreRow({ strAttr: "bad\0attribute" })],
    ),
  ).toThrow("NUL");
  expect(second.CaptureUserInventoryInitialization()).toEqual(before);
  expect(e.gs.ConfirmAuthorizedConnection(e.target, lease)).toEqual(e.users);
  expect(e.source.m_aUser).toEqual([]);
  expect(e.target.m_aUser).toEqual(e.users);
  expect(() => e.gs.ConfirmAuthorizedConnection(e.target, lease)).toThrow();
});
