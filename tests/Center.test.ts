import { afterEach, expect, test } from "bun:test";
import { CCenterServer } from "../Center/CCenterServer.ts";
import { ServerType, ChannelType } from "../Common/OfficialValues.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";
import { MemoryClient } from "./helpers/Clients.ts";
import { UserInfo, TestConfig } from "./helpers/Accounts.ts";
import { NormalizeID } from "../Common/CIDCompare.ts";
const sockets: MemoryClient[] = [];
const peer = (ip?: string) => {
  const s = new MemoryClient(ip);
  sockets.push(s);
  return s;
};
afterEach(() => {
  for (const s of sockets.splice(0)) s.Close();
});
function setup(maxUser = 8, type = ChannelType.Normal as number) {
  const config = TestConfig();
  config.FXGS.Channels[0]!.MaxUser = maxUser;
  config.FXGS.Channels[0]!.Type = type;
  let now = 1_800_000_000_000;
  const center = new CCenterServer(config, () => now);
  for (const s of center.m_localServerMan.m_aLocalServer) s.m_bConnected = true;
  const ls = center.m_localServerMan.GetSvr(ServerType.Login, 0)!;
  const gs = center.m_localServerMan.GetSvr(ServerType.FXGame, 0)!;
  return {
    center,
    ls,
    gs,
    tick: (ms: number) => {
      now += ms;
    },
  };
}
test("duplicate IDs validate the entire group before inserting either player", () => {
  const { center, ls } = setup();
  const owner = peer();
  center.OnAddNewUser(owner, ls, [UserInfo("Alice")]);
  const other = peer();
  expect(() =>
    center.OnAddNewUser(other, ls, [UserInfo("Bob"), UserInfo("ALICE")]),
  ).toThrow("Already");
  expect(center.m_globalUserTable.GetUserCount()).toBe(1);
  expect(center.m_globalUserTable.FindUserFromId("Bob")).toBeUndefined();
  expect(other.GetUserCount()).toBe(0);
  expect(NormalizeID("AÉ")).toBe("aÉ"); // exactly SQLite ASCII NOCASE, not Unicode case folding
});
test("repeated ID inside a two-player login is atomically rejected", () => {
  const { center, ls } = setup();
  expect(() =>
    center.OnAddNewUser(peer(), ls, [UserInfo("A"), UserInfo("a")]),
  ).toThrow();
  expect(center.m_globalUserTable.GetUserCount()).toBe(0);
});
test("capacity reservations count players, including all pending group members", () => {
  const { center, ls } = setup(2);
  const first = peer();
  const second = peer();
  const overflow = peer();
  center.OnAddNewUser(first, ls, [UserInfo("A")]);
  center.OnAddNewUser(second, ls, [UserInfo("B")]);
  center.OnAddNewUser(overflow, ls, [UserInfo("C")]);
  expect(center.OnReqConnectToSvr(first, ServerType.FXGame, 0).result).toBe(1);
  expect(center.OnReqConnectToSvr(second, ServerType.FXGame, 0).result).toBe(1);
  expect(center.OnReqConnectToSvr(overflow, ServerType.FXGame, 0).result).toBe(
    0,
  );
  const pair = setup(1);
  const group = peer();
  pair.center.OnAddNewUser(group, pair.ls, [UserInfo("X"), UserInfo("Y")]);
  expect(
    pair.center.OnReqConnectToSvr(group, ServerType.FXGame, 0).result,
  ).toBe(0);
  expect(
    group.m_aUser.every(
      (u) =>
        !("m_pendingConnection" in u) || u.m_pendingConnection === undefined,
    ),
  ).toBe(true);
});
test("pending handoff requires exact group/order, name, global serial, guild and TCP IP", () => {
  const { center, ls, gs } = setup();
  const source = peer();
  const users = center.OnAddNewUser(source, ls, [UserInfo("A"), UserInfo("B")]);
  const ids = users.map((u) => ({
    ID: u.GetName(),
    GlobalSerialNo: u.GetGlobalSerialNo(),
    GuildSn: 0,
  }));
  expect(center.OnReqConnectToSvr(source, ServerType.FXGame, 0).result).toBe(1);
  expect(() => center.OnConnEstablished(peer("127.0.0.2"), gs, ids)).toThrow(
    "transfer",
  );
  expect(() =>
    center.OnConnEstablished(peer(), gs, [...ids].reverse()),
  ).toThrow();
  expect(() => center.OnConnEstablished(peer(), gs, ids.slice(0, 1))).toThrow();
  expect(() =>
    center.OnConnEstablished(peer(), gs, [
      ids[0]!,
      { ...ids[1]!, GuildSn: 10 },
    ]),
  ).toThrow();
  expect(
    users.every((u) => u.m_pClientSocket === source && u.m_pendingConnection),
  ).toBe(true);
  const target = peer();
  expect(center.OnConnEstablished(target, gs, ids)).toEqual(users);
  expect(target.GetUserCount()).toBe(2);
  expect(source.GetUserCount()).toBe(0);
  expect(source.IsConnected()).toBe(false);
  expect(() => center.OnConnEstablished(peer(), gs, ids)).toThrow();
  expect(
    users.every((u) => !u.m_pendingConnection && u.m_pClientSocket === target),
  ).toBe(true);
  center.OnDeleteUser(source);
  expect(center.m_globalUserTable.GetUserCount()).toBe(2);
  expect(users.map((u) => u.IsSetFree())).toEqual([0, 0]);
  center.OnDeleteUser(target);
  expect(center.m_globalUserTable.GetUserCount()).toBe(0);
  expect(users.map((u) => u.IsSetFree())).toEqual([1, 1]);
});
test("source disconnect while pending preserves ownership until acceptance or expiry", () => {
  const { center, ls, gs, tick } = setup();
  const source = peer();
  const [user] = center.OnAddNewUser(source, ls, [UserInfo("A")]);
  center.OnReqConnectToSvr(source, ServerType.FXGame, 0);
  source.Close();
  center.OnDeleteUser(source);
  expect(center.m_globalUserTable.GetUserCount()).toBe(1);
  expect(user!.IsSetFree()).toBe(0); // pending detach does NOT free shared user
  const target = peer();
  center.OnConnEstablished(target, gs, [
    { ID: "A", GlobalSerialNo: user!.GetGlobalSerialNo(), GuildSn: 0 },
  ]);
  expect(user!.m_pClientSocket).toBe(target);
  expect(user!.IsSetFree()).toBe(0);
  center.OnDeleteUser(target);
  expect(user!.IsSetFree()).toBe(1);
  const dying = peer();
  const [dead] = center.OnAddNewUser(dying, ls, [UserInfo("B")]);
  center.OnReqConnectToSvr(dying, ServerType.FXGame, 0);
  dying.Close();
  center.OnDeleteUser(dying);
  tick(RuntimePolicy.SessionTransferTimeoutMs);
  center.ExpireConnections();
  expect(center.m_globalUserTable.GetUserCount()).toBe(0);
  expect(dead!.IsSetFree()).toBe(1);
});
test("expiry leaves a live source authenticated and allows a fresh single-use request", () => {
  const { center, ls, gs, tick } = setup();
  const source = peer();
  const [u] = center.OnAddNewUser(source, ls, [UserInfo("A")]);
  center.OnReqConnectToSvr(source, ServerType.FXGame, 0);
  tick(RuntimePolicy.SessionTransferTimeoutMs + 1);
  expect(() =>
    center.OnConnEstablished(peer(), gs, [
      { ID: "A", GlobalSerialNo: u!.GetGlobalSerialNo(), GuildSn: 0 },
    ]),
  ).toThrow();
  expect(center.m_globalUserTable.GetUserCount()).toBe(1);
  expect(center.OnReqConnectToSvr(source, ServerType.FXGame, 0).result).toBe(1);
});
test("offline/unknown/same servers and absent premium ticket are not advertised as successful", () => {
  const { center, ls, gs } = setup(8, ChannelType.Premium);
  const source = peer();
  center.OnAddNewUser(source, ls, [UserInfo("A")]);
  expect(center.OnReqConnectToSvr(source, 99, 0).result).toBe(0);
  expect(center.OnReqConnectToSvr(source, ServerType.Login, 0).result).toBe(0);
  expect(center.OnReqConnectToSvr(source, ServerType.FXGame, 0).result).toBe(2);
  gs.m_bConnected = false;
  expect(center.OnReqConnectToSvr(source, ServerType.FXGame, 0).result).toBe(0);
});

test("a marked-free group member cannot reserve or consume a handoff, without moving its partner", () => {
  for (const phase of ["before-reservation", "before-acceptance"]) {
    const { center, ls, gs, tick } = setup();
    const source = peer();
    const target = peer();
    const users = center.OnAddNewUser(source, ls, [
      UserInfo("A"),
      UserInfo("B"),
    ]);
    if (phase === "before-reservation") {
      users[1]!.SetFree();
      expect(
        center.OnReqConnectToSvr(source, ServerType.FXGame, 0).result,
      ).toBe(0);
      expect(users.every((u) => !u.m_pendingConnection)).toBe(true);
    } else {
      expect(
        center.OnReqConnectToSvr(source, ServerType.FXGame, 0).result,
      ).toBe(1);
      users[1]!.SetFree();
      expect(() =>
        center.OnConnEstablished(
          target,
          gs,
          users.map((u) => ({
            ID: u.GetName(),
            GlobalSerialNo: u.GetGlobalSerialNo(),
            GuildSn: 0,
          })),
        ),
      ).toThrow("transfer");
      expect(
        users.every(
          (u) => u.m_pendingConnection && u.m_pClientSocket === source,
        ),
      ).toBe(true);
    }
    expect(target.GetUserCount()).toBe(0);
    expect(users[0]!.IsSetFree()).toBe(0);
    source.Close();
    center.OnDeleteUser(source);
    tick(RuntimePolicy.SessionTransferTimeoutMs + 1);
    center.ExpireConnections();
    expect(center.m_globalUserTable.GetUserCount()).toBe(0);
    expect(users.map((u) => u.IsSetFree())).toEqual([1, 1]);
  }
});
