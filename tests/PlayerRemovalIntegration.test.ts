import { afterEach, expect, test } from "bun:test";
import { CGameSessionTable } from "../FXGS/CGameSessionTable.ts";
import { CGameSession } from "../FXGS/CGameSession.ts";
import { CDBMan } from "../FXGS/CDBMan.ts";
import { CDBSession } from "../Common/DB/CDBSession.ts";
import { CTextCodec } from "../Common/CTextCodec.ts";
import { CUser } from "../Common/CUser.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CProtocolError } from "../Common/CProtocolError.ts";
import { CServerApp } from "../CServerApp.ts";
import {
  ChannelType,
  GamePlayerState,
  GameStage,
  ServerType,
} from "../Common/OfficialValues.ts";
import {
  ResultResources,
  NormalResultCase,
  ResultSubmission,
  SeedResultUsers,
} from "./helpers/GameResult.ts";
import { MemoryClient, Received } from "./helpers/Clients.ts";
import { TestConfig, UserInfo } from "./helpers/Accounts.ts";

const clients: MemoryClient[] = [];
afterEach(() => {
  for (const s of clients.splice(0)) s.Close();
});
function client() {
  const s = new MemoryClient();
  clients.push(s);
  return s;
}
function create(table: CGameSessionTable, socket: MemoryClient): CGameSession {
  const p = new CSendPacket(80)
    .EncodeStr("Table departure")
    .EncodeStr("")
    .Encode1(0)
    .Encode1(socket.GetUserCount());
  socket.m_aUser.forEach(() => p.Encode1(0));
  table.OnPacket(Received(p), socket);
  return table.GetSession(socket)!;
}

test("real CreateSession attaches table recovery service; trusted Begin then due187 traverses that production wiring (NOT a network start)", () => {
  const session = new CDBSession(":memory:"),
    db = new CDBMan(session),
    table = new CGameSessionTable(
      new CTextCodec(),
      ResultResources.bombers,
      ResultResources.maps,
      ChannelType.Normal,
      () => {},
      { DB: db, ChannelIndex: 0, UpdateRankList: () => {} },
    ),
    a = client(),
    b = client();
  try {
    let serial = 100;
    for (const socket of [a, b])
      for (let local = 0; local < 2; local++) {
        const u = new CUser(UserInfo(`Actual${serial}`), serial++);
        u.m_pClientSocket = socket;
        socket.m_aUser.push(u);
      }
    const room = create(table, a);
    table.DoJoinSession(b, room.m_nIdx, room.m_ulSerialNo, "", [0, 0]);
    expect(room.GetCurPlayer()).toBe(4);
    // Trusted test-only partial runtime state. No request106 / 116 / 150 path.
    room.PrepareRoundStatistics();
    room.GetGameClock().StartGame();
    room.SetPlaying(true);
    room.m_nGameState = GameStage.Running;
    room.m_aPlayerState.fill(GamePlayerState.Inactive);
    room.m_aPlayerState.fill(GamePlayerState.Active, 0, 4);
    const key = room.BeginResultLifecycle();
    a.Clear();
    b.Clear();
    table.OnPacket(Received(new CSendPacket(187).Encode1(2)), a);
    room.m_udpLossRegulator.m_dwFirstLossTime =
      (room.GetGameClock().GetCurrentTime() - 8001) >>> 0;
    table.UpdateGameSessions();
    expect(table.GetUpdateFailures()).toEqual([]);
    expect(room.GetCurPlayer()).toBe(2);
    expect(table.GetSession(b)).toBeUndefined();
    expect(b.m_nPoolType).toBe("SessionRemoved");
    expect(b.packets.map((p) => p.m_nPacketType)).toEqual([195]);
    expect(b.packets[0]!.m_pBlock.toString("hex")).toBe("99");
    expect(a.packets.map((p) => p.m_nPacketType)).toEqual([106, 106]);
    expect(room.m_udpLossRegulator.m_bPending).toBe(false);
    expect(room.m_bPlaying).toBe(true);
    expect(db.GetGameResultReceipt(key)).toBeUndefined();
    expect(table.GetScheduledRoundCount()).toBe(1);
  } finally {
    session.Close();
  }
});

test("immediate modern room-list broadcaster excludes the departing transient-Lobby socket before195", async () => {
  const app = new CServerApp(TestConfig()),
    game = app.m_gameServers[0]!,
    a = client(),
    b = client(),
    observer = client(),
    sockets = [a, b, observer];
  try {
    const server = app.m_center.m_localServerMan.GetSvr(ServerType.FXGame, 0)!;
    for (const [i, socket] of sockets.entries()) {
      app.m_center.OnAddNewUser(
        socket,
        server,
        i === 2
          ? [UserInfo("Observer")]
          : [UserInfo(`Peer${i}A`), UserInfo(`Peer${i}B`)],
      );
      game.m_channelPool.AddNewSocket(socket);
      game.m_channelPool.InsertRankList(socket);
      game.m_listenSocket.sockets.add(socket); // test-only registration, no TCP listener
    }
    observer.m_nPoolType = "Lobby";
    const room = create(game.m_gameSessionTable, a);
    game.m_gameSessionTable.DoJoinSession(
      b,
      room.m_nIdx,
      room.m_ulSerialNo,
      "",
      [0, 0],
    );
    sockets.forEach((s) => s.Clear());
    game.m_gameSessionTable.EjectPlayerForUDP(room, a);
    expect(a.packets.map((p) => p.m_nPacketType)).toEqual([195]);
    expect(a.m_nPoolType).toBe("SessionRemoved");
    expect(observer.packets.map((p) => p.m_nPacketType)).toEqual([86]);
    expect(b.packets.map((p) => p.m_nPacketType)).toEqual([
      106, 106, 107, 107, 107,
    ]);
    expect(game.m_gameSessionTable.GetRemovalPublicationFailures()).toEqual({
      RecoveryNotice: 0,
      RoomNotice: 0,
    });
    a.Clear();
    game.m_channelPool.OnPacket(Received(new CSendPacket(83)), a);
    expect(a.packets.map((p) => p.m_nPacketType)).toEqual([15, 83]);
    expect(a.m_nPoolType).toBe("Lobby");
  } finally {
    for (const socket of sockets) {
      socket.Close();
      game.m_listenSocket.OnDisconnect(socket);
      game.m_listenSocket.sockets.delete(socket);
    }
    await app.CleanUp();
  }
});

test("actual frozen CAS disconnect releases Center/rank but occupied freed participants block SQL retry; no offline award or rebased receipt", async () => {
  const app = new CServerApp(TestConfig()),
    game = app.m_gameServers[0]!,
    sockets = [client(), client(), client()];
  let room: CGameSession | undefined;
  try {
    const db = new CDBMan(app.m_dbSession);
    SeedResultUsers(db, ResultSubmission());
    const server = app.m_center.m_localServerMan.GetSvr(ServerType.FXGame, 0)!;
    for (let group = 0; group < 3; group++) {
      const infos = [0, 1].map((local) => {
        const slot = group * 2 + local;
        return UserInfo(
          `Result${slot}`,
          NormalResultCase.Players[slot]!.State.Dynamic,
        );
      });
      app.m_center.OnAddNewUser(sockets[group]!, server, infos);
      game.m_channelPool.AddNewSocket(sockets[group]!);
      game.m_channelPool.InsertRankList(sockets[group]!);
    }
    room = create(game.m_gameSessionTable, sockets[0]!);
    for (const s of sockets.slice(1))
      game.m_gameSessionTable.DoJoinSession(
        s,
        room.m_nIdx,
        room.m_ulSerialNo,
        "",
        [0, 0],
      );
    room.PrepareRoundStatistics();
    room.GetGameClock().StartGame();
    room.SetPlaying(true);
    room.m_nGameState = GameStage.Running;
    room.m_aPlayerState.fill(GamePlayerState.Inactive);
    room.m_aPlayerState[0] = GamePlayerState.WinClaim;
    const key = room.BeginResultLifecycle();
    sockets.forEach((s) => s.Clear());
    const before = app.m_dbSession.db
      .query("SELECT ID,Money,Exp,Win,Draw,Lose FROM FxUserDynamic ORDER BY ID")
      .all();
    app.m_dbSession.db
      .query("UPDATE FxUserDynamic SET Money=Money+1 WHERE ID='Result5'")
      .run();
    expect(room.UpdateResultLifecycle()).toBe(false);
    expect(room.IsResultCommitPending()).toBe(true);
    const target = sockets[1]!,
      users = target.m_aUser.slice(),
      roster = room.m_rgPlayer.slice();
    target.Close();
    expect(() => game.m_listenSocket.OnDisconnect(target)).toThrow(
      CProtocolError,
    );
    expect(target.GetUserCount()).toBe(0);
    expect(users.map((u) => u.IsSetFree())).toEqual([1, 1]);
    expect(users.every((u) => u.m_pClientSocket === undefined)).toBe(true);
    expect(game.m_channelPool.GetRankList()).toHaveLength(4);
    expect(app.m_center.m_globalUserTable.GetUserCount()).toBe(4);
    expect(room.m_rgPlayer).toEqual(roster); // no silent roster amendment
    expect(users.map((u) => u.m_nSlotIdx)).toEqual([2, 3]);
    app.m_dbSession.db
      .query("UPDATE FxUserDynamic SET Money=Money-1 WHERE ID='Result5'")
      .run();
    expect(() => room!.UpdateResultLifecycle()).toThrow("terminally detached");
    game.m_gameSessionTable.UpdateGameSessions();
    expect(game.m_gameSessionTable.GetUpdateFailures()).toEqual([
      {
        SessionIndex: room.m_nIdx,
        SessionSerialNo: room.m_ulSerialNo,
        Code: "protocol-error",
        ConsecutiveFailures: 1,
      },
    ]);
    expect(game.m_gameSessionTable.GetPendingResultCount()).toBe(1);
    expect(room.GetResultRoundID()).toBe(key);
    expect(room.GetGameClock().GetEndGameTime()).toBe(0);
    expect(room.m_nGameState).toBe(GameStage.Running);
    expect(db.GetGameResultReceipt(key)).toBeUndefined();
    expect(
      app.m_dbSession.db
        .query(
          "SELECT ID,Money,Exp,Win,Draw,Lose FROM FxUserDynamic ORDER BY ID",
        )
        .all(),
    ).toEqual(before);
    expect(sockets.every((s) => s.packets.length === 0)).toBe(true);
    expect(app.GetStatus().gameUpdate[0]!.pendingResults).toBe(1);
    expect(app.GetStatus().gameUpdate[0]!.failedRooms).toBe(1);
  } finally {
    for (const s of sockets) {
      s.Close();
      try {
        game.m_listenSocket.OnDisconnect(s);
      } catch {
        /* retained frozen room is explicitly unrecoverable here */
      }
    }
    await app.CleanUp();
  }
});
