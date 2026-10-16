import { afterEach, expect, test } from "bun:test";
import { CUser } from "../Common/CUser.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import {
  ClientRequest,
  ServerResponse,
} from "../Common/Protocol/PacketTypes.ts";
import { CProtocolError } from "../Common/CProtocolError.ts";
import { CUserItemMan } from "../FXGS/CUserItemMan.ts";
import { PlanInitUserInventory } from "../FXGS/UserInventory.ts";
import { GameStage } from "../Common/OfficialValues.ts";
import { ChannelFixture } from "./helpers/Channel.ts";
import { MemoryClient, Received } from "./helpers/Clients.ts";
import { UserInfo } from "./helpers/Accounts.ts";
import {
  NativeInventory,
  InventoryVectors,
  ModelText,
  ModelResident,
} from "./helpers/UserInventory.ts";
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
function create() {
  const e = NativeMoneyEnvironment();
  cleanup.push(e.close);
  expect(e.room.GetGameLaunchState().NativeLaunch).toBe(true);
  expect(e.room.m_nGameState).toBe(GameStage.Running);
  return e;
}
function attach(e: NativeMoneyFixture, slot = 1) {
  const u = e.room.m_rgPlayer[slot]!;
  u.InstallUserInventory([NativeInventory({ Slot: 255, Amount: 3 })]);
  return u;
}
function noPackets(e: NativeMoneyFixture) {
  for (const p of e.clients) expect(p.packets).toEqual([]);
}
function forbidClockAndRandom(e: NativeMoneyFixture) {
  e.clock.GetCurrentTime = () => {
    throw new Error("pending inventory fence MUST NOT sample clock");
  };
  e.clock.ElapsedTime = () => {
    throw new Error("pending inventory fence MUST NOT sample elapsed time");
  };
  e.random(() => {
    throw new Error("pending inventory fence MUST NOT draw random");
  });
}
function resultCount(e: NativeMoneyFixture) {
  return e.session.db
    .query<{ n: number }, []>("SELECT count(*) AS n FROM RuntimeGameResult")
    .get()!.n;
}
const nativeABA: readonly ((u: CUser) => void)[] = [
  (u) => {
    const rows = u.CaptureUserInventory()!.Rows;
    u.InstallUserInventory(rows);
  },
  (u) => {
    const rows = u.CaptureUserInventory()!.Rows;
    u.m_aInventory = [];
    u.InstallUserInventory(rows);
  },
  (u) => {
    const rows = u.CaptureUserInventory()!.Rows;
    u.ConsumeUserInventory(7, 1);
    u.InstallUserInventory(rows);
  },
];
function drift(u: CUser, change: (u: CUser) => void) {
  const before = JSON.stringify(u.GetInventoryStateSnapshot()),
    dynamic = u.GetDynamicInfoSnapshot(),
    generation = u.GetUserInventoryGeneration();
  change(u);
  expect(JSON.stringify(u.GetInventoryStateSnapshot())).toBe(before);
  expect(u.GetDynamicInfoSnapshot()).toEqual(dynamic);
  expect(u.GetUserInventoryGeneration().Revision).toBeGreaterThan(
    generation.Revision,
  );
}

// These use real106/discovery/109/150, not BeginResultLifecycle/test readiness
// injection. Native attachment is explicitly trusted, NOT a production SQL loader.
test("request209 really consumes TWO trusted native CUser inventories and201 independently matches frozen C++ bodies; malformed209 cannot send a partial response", async () => {
  const { pool } = ChannelFixture(),
    peer = new MemoryClient();
  cleanup.push(() => peer.Close());
  const models = InventoryVectors.Cases.filter(
    (c) =>
      c.Name === "all-equipped-positions-first-wins-no-Amount-or-date-recheck",
  ).slice(0, 2);
  expect(models).toHaveLength(2);
  const expected = new CSendPacket(201).Encode1(2);
  for (const [i, c] of models.entries()) {
    const u = new CUser(UserInfo(`Native50${i}`), i + 1),
      text = ModelText(c);
    u.InstallUserInventory(
      c.Expected.Rows.map((r) => ModelResident(r, text)),
      c.Expected.Equipment,
      text,
    );
    u.m_pClientSocket = peer;
    peer.m_aUser.push(u);
    expected.EncodeBuffer(
      Buffer.from(c.Expected.InventoryHex, "hex").subarray(1),
    );
  }
  pool.AddNewSocket(peer);
  peer.Clear();
  await pool.OnPacket(
    Received(new CSendPacket(ClientRequest.RequestUserInventory)),
    peer,
  );
  const actual = peer.Take(201);
  expect(actual.m_pBlock).toEqual(expected.GetBuffer());
  expect(actual.Decode1()).toBe(2);
  expect(actual.Decode4()).toBe(39);
  expect(peer.packets).toEqual([]);
  await expect(
    pool.OnPacket(
      Received(new CSendPacket(ClientRequest.RequestUserInventory).Encode1(1)),
      peer,
    ),
  ).rejects.toThrow(CProtocolError);
  expect(peer.packets).toEqual([]);
});

test("native load projection/explicit resident attachment neither deletes a colliding legacy SQLite SN nor migrates/grants/commits any owned row; DeleteAttempts are not receipts", () => {
  const e = create(),
    u = e.room.m_rgPlayer[1]!;
  e.session.db.exec(
    "INSERT INTO FxItem(SN,Category,strAttr,nAttr1,nAttr2,nAttr3,strName) VALUES(7,2,'Item/Fixture',1,0,0,'synthetic'); INSERT INTO FxUserInventory(SN,ID,ItemID,Amount) VALUES(7,'Partner',7,3)",
  );
  const stored = e.db.GetInventoryRecord(7),
    changes = () =>
      e.session.db
        .query<{ n: number }, []>("SELECT total_changes() AS n")
        .get()!.n,
    before = changes();
  const plan = PlanInitUserInventory(
    [NativeInventory({ StockSn: 99999, DateCreated: 0 })],
    new CUserItemMan(e.db).CaptureSnapshot(),
    u.GetLevel(),
    () => 1,
  );
  expect(plan.DeleteAttempts).toEqual([
    { RowIndex: 0, ItemSn: 7, LevelExpired: false, DateExpired: true },
  ]);
  u.InstallUserInventory(plan.Rows, plan.Equipment);
  expect(u.GetInventoryStateSnapshot()).toEqual([]);
  expect(u.GetUserInventoryGeneration().Native).toBe(true);
  expect(e.db.GetInventoryRecord(7)).toEqual(stored);
  expect(changes()).toBe(before);
  expect(e.session.db.query("PRAGMA user_version").get()).toEqual({
    user_version: 6,
  });
  expect([
    MoneyReceiptCount(e.db),
    HouseReceiptCount(e.db),
    SpecialReceiptCount(e.db),
    resultCount(e),
  ]).toEqual([0, 0, 0, 0]);
  noPackets(e);
});

test("positive native paid146 fails BEFORE legacy storage even when ItemSn collides with legacy SN/ItemID; separate StockSn must never become a lookup fallback; no stock/Shop/Nice/receipt/159 effects", () => {
  const e = create(),
    u = attach(e);
  e.session.db.exec(
    "INSERT INTO FxUserInventory(SN,ID,ItemID,Amount) VALUES(7,'Partner',7,3)",
  );
  const stored = e.db.GetInventoryRecord(7),
    before = SpecialLive(e),
    generation = u.GetUserInventoryGeneration();
  let commits = 0;
  e.db.CommitSpecialItemUse = () => {
    commits++;
    throw new Error("native rows MUST NOT reach legacy CAS");
  };
  forbidClockAndRandom(e);
  expect(() => SendSpecial(e, 1, 44, 1, 7)).toThrow(
    "Native inventory persistence",
  );
  expect(commits).toBe(0);
  expect(SpecialLive(e)).toEqual(before);
  expect(u.GetUserInventoryGeneration()).toEqual(generation);
  expect(e.db.GetInventoryRecord(7)).toEqual(stored);
  expect(SpecialReceiptCount(e.db)).toBe(0);
  expect(e.room.GetSpecialItemUseState()).toEqual({
    Sequence: 0,
    Pending: false,
    Attempts: 0,
    Failure: undefined,
  });
  noPackets(e);
});

test("zero-quantity146 is still native relaying, not inventory authorization: no lookup/SQL/dirty/revision/Shop/Nice, and whole sender TCP (two locals) is excluded from159", () => {
  const e = create(),
    u = attach(e),
    before = SpecialLive(e),
    generation = u.GetUserInventoryGeneration();
  u.GetUserInventory = () => {
    throw new Error("zero quantity MUST NOT lookup stock");
  };
  e.db.CommitSpecialItemUse = () => {
    throw new Error("zero quantity MUST NOT reach SQL");
  };
  forbidClockAndRandom(e);
  SendSpecial(e, 1, 44, 0);
  expect(SpecialLive(e)).toEqual(before);
  expect(u.GetUserInventoryGeneration()).toEqual(generation);
  expect(e.clients[0]!.packets).toEqual([]);
  const p = e.clients[1]!.Take(159);
  expect([
    p.Decode1(),
    p.Decode2(),
    p.Decode2(),
    p.Decode1(),
    p.Decode1(),
    p.Decode1(),
  ]).toEqual([1, 0x80ff, 0xff80, 90, 44, 0]);
  p.AssertEnd();
  expect(e.room.GetSpecialItemUseState()).toEqual({
    Sequence: 0,
    Pending: false,
    Attempts: 0,
    Failure: undefined,
  });
  expect(SpecialReceiptCount(e.db)).toBe(0);
});

test("native zero-quantity type22/state3 refreshes ONLY the native elapsed timestamp, never needs resident stock or a paid receipt", () => {
  const e = create(),
    u = attach(e),
    generation = u.GetUserInventoryGeneration(),
    rows = u.CaptureUserInventory()!.Rows;
  e.room.m_aPlayerState[1] = 3;
  e.time(1234);
  const elapsed = e.clock.ElapsedTime();
  u.GetUserInventory = () => {
    throw new Error("no stock");
  };
  SendSpecial(e, 1, 45, 0);
  expect(e.room.GetCurrentGameContext().m_aPlayerStateTime[1]).toBe(elapsed);
  expect(u.CaptureUserInventory()!.Rows).toBe(rows);
  expect(u.GetUserInventoryGeneration()).toEqual(generation);
  expect(u.CaptureUserInventory()!.Rows[0]!.Modified).toBe(0);
  expect(SpecialReceiptCount(e.db)).toBe(0);
  expect(e.room.m_aShopItemAttempted[1]).toBe(0);
  expect(e.clients[0]!.packets).toEqual([]);
  e.clients[1]!.Take(159);
});

test("a native second-local201 overflow from request209 cannot send the already-encoded first local or change either generation", async () => {
  const { pool } = ChannelFixture(),
    peer = new MemoryClient();
  cleanup.push(() => peer.Close());
  for (let i = 0; i < 2; i++) {
    const u = new CUser(UserInfo(`Overflow${i}`), i + 1);
    u.InstallUserInventory(
      i
        ? [
            ...Array.from({ length: 20 }, () =>
              NativeInventory({ Verbose: "X".repeat(4096) }),
            ),
          ]
        : [NativeInventory()],
    );
    u.m_pClientSocket = peer;
    peer.m_aUser.push(u);
  }
  pool.AddNewSocket(peer);
  peer.Clear();
  const before = peer.m_aUser.map((u) => u.CaptureUserInventory());
  await expect(
    pool.OnPacket(
      Received(new CSendPacket(ClientRequest.RequestUserInventory)),
      peer,
    ),
  ).rejects.toThrow("Outgoing packet too long");
  expect(peer.packets).toEqual([]);
  for (const [i, u] of peer.m_aUser.entries())
    expect(u.CaptureUserInventory()).toEqual(before[i]);
});

test("pending money freezes on byte-identical native reload, native/legacy/native ABA and consume/reinstall ABA, WITHOUT SQL retry, clock/random, live publication or rebase", () => {
  for (const change of nativeABA) {
    const e = create(),
      u = attach(e);
    e.session.db.exec(
      "CREATE TRIGGER InventoryMoneyFail BEFORE INSERT ON RuntimeMoneyPickup BEGIN SELECT RAISE(FAIL,'fixture'); END",
    );
    SendMoney(e);
    expect(e.room.GetMoneyPickupState().Failure).toBe("storage");
    e.session.db.exec("DROP TRIGGER InventoryMoneyFail");
    drift(u, change);
    const before = SpecialLive(e);
    e.db.CommitMoneyPickup = () => {
      throw new Error("MUST NOT retry SQL after generation drift");
    };
    forbidClockAndRandom(e);
    e.room.Update();
    expect(e.room.GetMoneyPickupState().Failure).toBe("state-changed");
    expect(e.room.GetMoneyPickupState().Pending).toBe(true);
    expect(SpecialLive(e)).toEqual(before);
    expect(MoneyReceiptCount(e.db)).toBe(0);
    noPackets(e);
  }
});

test("pending house freezes on native-generation-only reload of an UNRELATED room occupant, not merely the claiming wallet", () => {
  const e = create(),
    u = attach(e, 2);
  e.session.db.exec(
    "CREATE TRIGGER InventoryHouseFail BEFORE INSERT ON RuntimeHouseClaim BEGIN SELECT RAISE(FAIL,'fixture'); END",
  );
  SendHouse(e);
  expect(e.room.GetHouseClaimState().Failure).toBe("storage");
  e.session.db.exec("DROP TRIGGER InventoryHouseFail");
  drift(u, nativeABA[0]!);
  const before = SpecialLive(e);
  forbidClockAndRandom(e);
  e.room.Update();
  expect(e.room.GetHouseClaimState().Failure).toBe("state-changed");
  expect(SpecialLive(e)).toEqual(before);
  expect(HouseReceiptCount(e.db)).toBe(0);
  noPackets(e);
});

test("pending LEGACY paid use also fences native-generation-only drift of another occupant; never reinterpret native rows as the legacy receipt Before", () => {
  const e = create(),
    stock = SeedSpecialInventory(e),
    u = attach(e, 2);
  e.session.db.exec(
    "CREATE TRIGGER InventoryPaidFail BEFORE INSERT ON RuntimeSpecialItemUse BEGIN SELECT RAISE(FAIL,'fixture'); END",
  );
  SendSpecial(e, 1, 44, 1, stock.SN);
  expect(e.room.GetSpecialItemUseState().Failure).toBe("storage");
  e.session.db.exec("DROP TRIGGER InventoryPaidFail");
  drift(u, nativeABA[0]!);
  const before = SpecialLive(e);
  forbidClockAndRandom(e);
  e.room.Update();
  expect(e.room.GetSpecialItemUseState().Failure).toBe("state-changed");
  expect(SpecialLive(e)).toEqual(before);
  expect(SpecialReceiptCount(e.db)).toBe(0);
  expect(e.db.GetInventoryRecord(stock.SN)!.Amount).toBe(3);
  noPackets(e);
});

test("frozen results reject all THREE byte-identical native-generation ABA forms before retrying result storage; real native launch and claims, no readiness injection", () => {
  for (const change of nativeABA) {
    const e = create(),
      u = attach(e),
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
    drift(u, change);
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

test("native reload INSIDE money storage callback after root COMMIT keeps its durable receipt/SQL After but blocks all live After+156; retry stays frozen", () => {
  const e = create(),
    u = attach(e),
    commit = e.db.CommitMoneyPickup.bind(e.db);
  let calls = 0;
  e.db.CommitMoneyPickup = (input) => {
    calls++;
    const r = commit(input);
    drift(u, nativeABA[0]!);
    return r;
  };
  SendMoney(e);
  expect(calls).toBe(1);
  expect(MoneyReceiptCount(e.db)).toBe(1);
  expect(e.db.GetUserInfo("Partner")!.Money).toBe(10);
  expect(u.m_userInfo.Money).toBe(0);
  expect(e.room.GetMoneyPickupState().Failure).toBe("state-changed");
  const before = SpecialLive(e);
  forbidClockAndRandom(e);
  e.room.Update();
  expect(calls).toBe(1);
  expect(SpecialLive(e)).toEqual(before);
  noPackets(e);
});

test("native reload INSIDE house storage callback after root COMMIT blocks live wallet/world/178 without pretending to roll back an existing receipt", () => {
  const e = create(),
    u = attach(e, 2),
    commit = e.db.CommitHouseClaim.bind(e.db);
  e.db.CommitHouseClaim = (input) => {
    const r = commit(input);
    drift(u, nativeABA[0]!);
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

test("native reload INSIDE a LEGACY paid callback preserves committed legacy SQL decrement but freezes live stock/Shop/Nice/159 of that pending request", () => {
  const e = create(),
    stock = SeedSpecialInventory(e),
    u = attach(e, 2),
    commit = e.db.CommitSpecialItemUse.bind(e.db);
  e.db.CommitSpecialItemUse = (input) => {
    const r = commit(input);
    drift(u, nativeABA[0]!);
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

test("native generation drift INSIDE successful result storage is checked AGAIN before counters/stage/163: receipt remains durable, no live settlement, no automatic rebase", () => {
  const e = create(),
    u = attach(e),
    commit = e.db.CommitGameResult.bind(e.db);
  e.time(30100);
  SubmitMoneyRoundClaims(e);
  e.clear();
  const before = SpecialLive(e);
  let calls = 0;
  e.db.CommitGameResult = (input) => {
    calls++;
    const r = commit(input);
    drift(u, nativeABA[0]!);
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

test("unchanged native attachment is NOT a blanket result ban: real launched claims, lost result ACK, exact duplicate retry, one live163 and retained immutable native stock", () => {
  const e = create(),
    u = attach(e),
    rows = u.CaptureUserInventory()!.Rows,
    generation = u.GetUserInventoryGeneration(),
    commit = e.db.CommitGameResult.bind(e.db);
  e.time(30100);
  SubmitMoneyRoundClaims(e);
  e.clear();
  const before = SpecialLive(e);
  e.db.CommitGameResult = (input) => {
    commit(input);
    throw new Error("native-read-side fixture lost ACK");
  };
  expect(() => e.room.UpdateResultLifecycle()).toThrow("lost ACK");
  expect(resultCount(e)).toBe(1);
  expect(SpecialLive(e)).toEqual(before);
  noPackets(e);
  e.db.CommitGameResult = commit;
  expect(e.room.UpdateResultLifecycle()).toBe(true);
  expect(e.room.IsResultCommitPending()).toBe(false);
  expect(e.room.m_nGameState).toBe(GameStage.Result);
  expect(u.CaptureUserInventory()!.Rows).toBe(rows);
  expect(u.GetUserInventoryGeneration()).toEqual(generation);
  for (const peer of e.clients) peer.Take(ServerResponse.GameResult);
  expect(e.room.UpdateResultLifecycle()).toBe(false);
  expect(resultCount(e)).toBe(1);
  noPackets(e);
});

test("unchanged unrelated native occupant does NOT disable LEGACY paid CAS: one durable decrement/159 and native inventory generation remains untouched", () => {
  const e = create(),
    stock = SeedSpecialInventory(e),
    u = attach(e, 2),
    rows = u.CaptureUserInventory()!.Rows,
    generation = u.GetUserInventoryGeneration();
  SendSpecial(e, 1, 44, 1, stock.SN);
  expect(SpecialReceiptCount(e.db)).toBe(1);
  expect(e.db.GetInventoryRecord(stock.SN)!.Amount).toBe(2);
  expect(e.room.m_rgPlayer[1]!.GetUserInventory(stock.SN)!.Amount).toBe(2);
  expect(u.CaptureUserInventory()!.Rows).toBe(rows);
  expect(u.GetUserInventoryGeneration()).toEqual(generation);
  expect(e.clients[0]!.packets).toEqual([]);
  e.clients[1]!.Take(159);
  expect(e.room.GetSpecialItemUseState()).toEqual({
    Sequence: 1,
    Pending: false,
    Attempts: 1,
    Failure: undefined,
  });
  noPackets(e);
});
