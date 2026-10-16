import { afterEach, describe, expect, test } from "bun:test";
import { CUser } from "../Common/CUser.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CDBSession } from "../Common/DB/CDBSession.ts";
import { CDBMan } from "../FXGS/CDBMan.ts";
import { CConnectPool } from "../FXGS/CConnectPool.ts";
import { CUserItemMan } from "../FXGS/CUserItemMan.ts";
import { ServerType, OpaqueOfficial } from "../Common/OfficialValues.ts";
import { ClientRequest } from "../Common/Protocol/PacketTypes.ts";
import { g_nLevel2ExpTable } from "../Common/Protocol/OfficialTables.ts";
import { ChannelFixture } from "./helpers/Channel.ts";
import { ResultSubmission, SeedResultUsers } from "./helpers/GameResult.ts";
import { MemoryClient, Received } from "./helpers/Clients.ts";
import { UserInfo } from "./helpers/Accounts.ts";
import vectors from "./fixtures/result-lifecycle-vectors.json";

const sockets: MemoryClient[] = [],
  sessions: CDBSession[] = [];
function socket(): MemoryClient {
  const p = new MemoryClient();
  sockets.push(p);
  return p;
}
afterEach(() => {
  for (const s of sockets.splice(0)) s.Close();
  for (const s of sessions.splice(0)) s.Close();
});
function add(
  peer: MemoryClient,
  serial: number,
  level: number,
  name = `Rank${serial}`,
): CUser {
  const u = new CUser(
    UserInfo(name, { Exp: g_nLevel2ExpTable[level - 1]! }),
    serial,
  );
  u.m_pClientSocket = peer;
  peer.m_aUser.push(u);
  return u;
}
function packetFor(users: readonly CUser[]): CSendPacket {
  const p = new CSendPacket(ClientRequest.ConnEstablished).Encode1(
    users.length,
  );
  for (const u of users)
    p.EncodeStr(u.GetName())
      .Encode4(u.GetGlobalSerialNo())
      .Encode4(u.m_userInfo.GuildSn);
  return p
    .Encode4(0)
    .Encode4(OpaqueOfficial.FxClientIntegrityXor[0]!)
    .Encode1(0);
}
function connection() {
  const c = ChannelFixture(),
    s = new CDBSession(":memory:"),
    db = new CDBMan(s);
  sessions.push(s);
  SeedResultUsers(db, ResultSubmission());
  const source = socket(),
    target = socket();
  const users = c.ls.RegisterConnection(source, [
    db.GetUserInfo("Result0")!,
    db.GetUserInfo("Result1")!,
  ]);
  c.pool.AddNewSocket(target);
  const connect = new CConnectPool(
    db,
    c.gs,
    new CUserItemMan(db),
    c.sessions,
    0,
    (peer) => c.pool.InsertRankList(peer),
  );
  expect(c.ls.RequestConnection(source, ServerType.FXGame, 0).result).toBe(1);
  return { ...c, db, source, target, users, connect };
}

describe("native cached-level rank semantics + modern attachment ownership", () => {
  test("162 independent C++ insert/per-slot up/down/no-change permutations, including unsigned serial ties", () => {
    for (const row of vectors.Rank) {
      const { pool } = ChannelFixture(),
        a = socket(),
        b = socket();
      const users = row.Before.map((level, i) =>
        add(i < 2 ? a : b, row.Serials[i]!, level),
      );
      for (const p of [a, b]) {
        pool.AddNewSocket(p);
        pool.InsertRankList(p);
      }
      const order = () => pool.GetRankList().map((u) => users.indexOf(u));
      expect(order()).toEqual(row.Initial);
      for (let slot = 0; slot < 4; slot++) {
        users[slot]!.m_userInfo.Exp = g_nLevel2ExpTable[row.After[slot]! - 1]!;
        users[slot]!.SetLevel();
        if (row.After[slot]! > row.Before[slot]!)
          pool.UpdateRankList(users[slot]!);
        expect(order()).toEqual(row.Steps[slot]!);
      }
      pool.DeleteSocket(a);
      pool.DeleteSocket(b);
      expect(pool.GetRankList()).toEqual([]);
    }
  });
  test("cached, not current Exp or fake look-level; update of absent pointer is a no-op", () => {
    const { pool } = ChannelFixture(),
      p = socket();
    const a = add(p, 0xffffffff, 1),
      b = add(p, 1, 2);
    a.m_userInfo.Exp = g_nLevel2ExpTable[449]!;
    a.SetFakeLevel(449);
    pool.InsertRankList(p);
    expect(pool.GetRankList()).toEqual([b, a]);
    const outsider = socket(),
      c = add(outsider, 2, 450);
    pool.UpdateRankList(c);
    expect(pool.GetRankList()).toEqual([b, a]);
    a.SetLevel();
    pool.UpdateRankList(a);
    expect(pool.GetRankList()).toEqual([a, b]);
    const detached = pool.GetRankList() as CUser[];
    detached.length = 0;
    expect(pool.GetRankList()).toEqual([a, b]);
  });
  test("TCP accept alone does NOT insert users; repeat authenticated insertion validates but is idempotent", () => {
    const { pool } = ChannelFixture(),
      p = socket();
    pool.AddNewSocket(p);
    expect(pool.GetRankList()).toEqual([]);
    expect(() => pool.InsertRankList(p)).toThrow();
    const user = add(p, 1, 8);
    pool.InsertRankList(p);
    pool.InsertRankList(p);
    expect(pool.GetRankList()).toEqual([user]);
    p.Close();
    expect(() => pool.InsertRankList(p)).toThrow();
    pool.DeleteSocket(p);
    pool.DeleteSocket(p);
    expect(pool.GetRankList()).toEqual([]);
  });
  test("invalid/free/duplicate-serial second member never partially inserts a group", () => {
    for (const mode of ["free", "owner", "serial", "too-many"]) {
      const { pool } = ChannelFixture(),
        p = socket(),
        q = socket();
      const existing = add(q, 1, 10);
      pool.InsertRankList(q);
      add(p, 2, 450);
      const second = add(p, mode === "serial" ? 1 : 3, 5);
      if (mode === "free") second.SetFree();
      if (mode === "owner") second.m_pClientSocket = q;
      if (mode === "too-many") add(p, 4, 2);
      expect(() => pool.InsertRankList(p)).toThrow();
      expect(pool.GetRankList()).toEqual([existing]);
    }
  });
  test("delete captures original attached pointers even after Center has detached the source socket", () => {
    const c = ChannelFixture(),
      source = socket(),
      target = socket();
    const users = c.gs.RegisterConnection(source, [
      UserInfo("RankOne"),
      UserInfo("RankTwo"),
    ]);
    c.pool.AddNewSocket(source);
    c.pool.InsertRankList(source);
    expect(c.gs.RequestConnection(source, ServerType.Login, 0).result).toBe(1);
    c.ls.ConfirmConnection(
      target,
      users.map((u) => ({
        ID: u.GetName(),
        GlobalSerialNo: u.GetGlobalSerialNo(),
        GuildSn: 0,
      })),
    );
    expect(source.m_aUser).toHaveLength(0);
    expect(target.m_aUser).toEqual(users);
    expect(c.pool.GetRankList()).toEqual(
      users.toSorted((a, b) => a.GetGlobalSerialNo() - b.GetGlobalSerialNo()),
    );
    c.pool.DeleteSocket(source);
    expect(c.pool.GetRankList()).toEqual([]);
    c.pool.DeleteSocket(source);
    c.gs.UnregisterConnection(source);
    expect(target.m_aUser).toEqual(users);
    expect(users.map((u) => u.IsSetFree())).toEqual([0, 0]);
    expect(users.every((u) => u.m_pClientSocket === target)).toBe(true);
  });
  test("GS trusted SQL reload calls SetLevel for BOTH users BEFORE channel rank insertion", () => {
    const c = connection();
    expect(c.users.map((u) => u.GetLevel())).toEqual([1, 450]);
    c.db.session.db
      .query("UPDATE FxUserDynamic SET Exp=? WHERE ID='Result0'")
      .run(g_nLevel2ExpTable[149]!);
    c.db.session.db
      .query("UPDATE FxUserDynamic SET Exp=? WHERE ID='Result1'")
      .run(g_nLevel2ExpTable[1]!);
    c.connect.OnPacket(Received(packetFor(c.users)), c.target);
    expect(c.users.map((u) => u.GetLevel())).toEqual([150, 2]);
    expect(c.users.map((u) => u.GetLookLevel())).toEqual([150, 2]);
    expect(c.pool.GetRankList()).toEqual(c.users);
    expect(c.source.GetUserCount()).toBe(0);
    expect(c.source.IsConnected()).toBe(false);
    expect(c.target.m_nPoolType).toBe("Lobby");
    expect(c.users.every((u) => u.m_pClientSocket === c.target)).toBe(true);
    const before = c.pool.GetRankList();
    expect(() =>
      c.connect.OnPacket(Received(packetFor(c.users)), c.target),
    ).toThrow();
    expect(c.pool.GetRankList()).toEqual(before);
  });
  test("inventory read failure is preflighted before consuming either user's single-use transfer", () => {
    const c = connection(),
      load = c.db.LoadInventory.bind(c.db),
      before = c.users.map((u) => u.GetDynamicInfoSnapshot());
    c.db.LoadInventory = (id) => {
      if (id === "Result1") throw new Error("injected inventory read failure");
      return load(id);
    };
    expect(() =>
      c.connect.OnPacket(Received(packetFor(c.users)), c.target),
    ).toThrow("inventory read failure");
    expect(c.source.IsConnected()).toBe(true);
    expect(c.source.m_aUser).toEqual(c.users);
    expect(c.target.m_aUser).toHaveLength(0);
    expect(c.pool.GetRankList()).toEqual([]);
    expect(c.users.map((u) => u.GetDynamicInfoSnapshot())).toEqual(before);
    expect(
      c.users.every(
        (u) => u.m_pendingConnection && u.m_pClientSocket === c.source,
      ),
    ).toBe(true);
    c.db.LoadInventory = load;
    c.connect.OnPacket(Received(packetFor(c.users)), c.target);
    expect(c.target.m_aUser).toEqual(c.users);
    expect(c.pool.GetRankList()).toHaveLength(2);
  });
});
