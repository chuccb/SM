import { afterEach, expect, test } from "bun:test";
import {
  CGameSession,
  type GameSessionRemovalServices,
} from "../FXGS/CGameSession.ts";
import { CGameSessionTable } from "../FXGS/CGameSessionTable.ts";
import { CGameClock } from "../FXGS/CGameClock.ts";
import { CBanChief } from "../FXGS/CBanChief.ts";
import { CUser } from "../Common/CUser.ts";
import { CTextCodec } from "../Common/CTextCodec.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CDBSession } from "../Common/DB/CDBSession.ts";
import { CDBMan } from "../FXGS/CDBMan.ts";
import {
  CProtocolError,
  CUnsupportedOperation,
} from "../Common/CProtocolError.ts";
import { CServerApp } from "../CServerApp.ts";
import {
  ChannelType,
  GameStage,
  GamePlayerState,
  ListSessionLayout,
  SessionLimit,
  SlotStateMask,
  IntegerRange,
  ServerType,
} from "../Common/OfficialValues.ts";
import { ClientRequest } from "../Common/Protocol/PacketTypes.ts";
import { HOSTHANDLE } from "../Common/HOSTHANDLE.ts";
import { CPeImage, OFFICIAL_SERVICES } from "../Tools/OfficialSource.ts";
import { MemoryClient, Received } from "./helpers/Clients.ts";
import { ChannelFixture } from "./helpers/Channel.ts";
import { TestConfig, UserInfo } from "./helpers/Accounts.ts";
import {
  ResultResources,
  NormalResultCase,
  ResultEnvironment,
  ResultSubmission,
  SeedResultUsers,
} from "./helpers/GameResult.ts";
import vectors from "./fixtures/player-removal-vectors.json";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function peer() {
  const s = new MemoryClient();
  cleanup.push(() => s.Close());
  return s;
}
const serial = 0x89abcde0;
const packetBytes = (s: MemoryClient) =>
  s.packets.map((p) => p.m_pBlock.toString("hex"));
function basic(
  players: readonly number[] = [1, 1, 2, 2, 3, -1, -1, -1],
  locals = [0, 1],
  channelType: number = ChannelType.Normal,
) {
  let now = 100;
  const clock = new CGameClock(() => now),
    peers = new Map<number, MemoryClient>(),
    room = new CGameSession(
      17,
      91,
      "Removal",
      "",
      0,
      new CTextCodec(),
      ResultResources.bombers,
      ResultResources.maps,
      channelType,
      clock,
    );
  for (const id of new Set(players.filter((p) => p >= 0)))
    peers.set(id, peer());
  const users: (CUser | undefined)[] = Array(8);
  for (let slot = 0; slot < 8; slot++)
    if (players[slot]! >= 0) {
      const socket = peers.get(players[slot]!)!,
        u = new CUser(UserInfo(`Removal${slot}`), serial + slot);
      users[slot] = u;
      u.m_pClientSocket = socket;
      u.m_nSlotIdx = slot;
      u.m_nSessionIdx = 17;
      u.m_nSessionSerialNo = 91;

      socket.m_nPoolType = "Session";
    }
  for (const [id, socket] of peers) {
    const order =
      id === 1 ? locals : players.flatMap((p, i) => (p === id ? [i] : []));
    socket.m_aUser.push(...order.map((slot) => users[slot]!));
    now = (0xffff0000 + id) >>> 0;
    room.AddAllUser(
      socket,
      order.map(() => 0),
    );
  }
  // TRUSTED fixture: permute the two locals' slot order after normal AddUser
  // initialization, before any statistics, sync ownership or packet assertions.
  room.m_rgPlayer.fill(undefined);
  users.forEach((u, slot) => {
    if (u) {
      u.m_nSlotIdx = slot;
      room.m_rgPlayer[slot] = u;
    }
  });
  room.m_nChiefSlotidx = players.findIndex((p) => p >= 0);
  room.m_rgSlotInfo[room.m_nChiefSlotidx]![0] = SlotStateMask.Chief;
  return {
    room,
    clock,
    peers,
    users,
    time: (t: number) => {
      now = t;
    },
  };
}
function table(
  room?: CGameSession,
  broadcast: (packet: CSendPacket) => void = () => {},
) {
  const t = new CGameSessionTable(
    new CTextCodec(),
    ResultResources.bombers,
    ResultResources.maps,
    ChannelType.Normal,
    broadcast,
  );
  if (room) t.m_rgGameSession.set(room.m_nIdx, room);
  return t;
}
function create(
  sessions: CGameSessionTable,
  socket: MemoryClient,
  title: string,
) {
  const p = new CSendPacket(80)
    .EncodeStr(title)
    .EncodeStr("")
    .Encode1(0)
    .Encode1(socket.GetUserCount());
  for (const _ of socket.m_aUser) p.Encode1(0);
  sessions.OnPacket(Received(p), socket);
  return sessions.GetSession(socket)!;
}
/** TRUSTED prepared Running fixture. Not network launch or authority evidence. */
function running(start = 100, linked = true) {
  const session = new CDBSession(":memory:"),
    db = new CDBMan(session);
  let sessions: CGameSessionTable;
  const removal: GameSessionRemovalServices = {
    EjectPlayerForUDP: (r, s) => sessions.EjectPlayerForUDP(r, s),
  };
  const e = ResultEnvironment(
    NormalResultCase,
    { DB: db, ChannelIndex: 0, UpdateRankList: () => {} },
    undefined,
    linked ? removal : undefined,
  );
  const roomNotices: number[] = [];
  sessions = table(e.room, (p) => roomNotices.push(p.m_nPacketType));
  SeedResultUsers(db, ResultSubmission());
  e.time(start);
  e.clock.StartGame();
  e.room.SetPlaying(true);
  e.room.m_nGameState = GameStage.Running;
  e.room.m_aPlayerState.fill(GamePlayerState.Inactive);
  for (let slot = 0; slot < 8; slot++)
    if (e.room.m_rgPlayer[slot])
      e.room.m_aPlayerState[slot] = GamePlayerState.Active;
  e.room.m_nChiefSlotidx = 0;
  e.room.m_rgSlotInfo[0]![0] =
    e.room.m_rgSlotInfo[0]![0]! | SlotStateMask.Chief;
  const key = e.room.BeginResultLifecycle();
  e.clients.forEach((s) => s.Clear());
  cleanup.push(() => {
    e.clients.forEach((s) => s.Close());
    session.Close();
  });
  return { ...e, db, sessions, key, roomNotices };
}
type Running = ReturnType<typeof running>;
function loss(e: Running, reporter = 0, target = 2) {
  e.room.OnPacket(
    Received(new CSendPacket(187).Encode1(target)),
    e.clients[reporter]!,
  );
}
function retained(room: CGameSession) {
  return {
    states: [...room.m_aPlayerState],
    times: [...room.GetCurrentGameContext().m_aPlayerStateTime],
    bombers: [...room.m_aBomberIdxPlaying],
    join: Array.from({ length: 8 }, (_, slot) => room.GetPlayerJoinTime(slot)),
    calculator: room.m_dynInfoCalculator.GetStateBytes(),
    start: room.GetGameClock().GetStartGameTime(),
    end: room.GetGameClock().GetEndGameTime(),
    playing: room.m_bPlaying,
    stage: room.m_nGameState,
  };
}
function membership(e: ReturnType<typeof basic>) {
  return {
    players: e.room.m_rgPlayer.map((u) => u?.GetGlobalSerialNo()),
    ids: e.users.map(
      (u) => u && [u.m_nSlotIdx, u.m_nSessionIdx, u.m_nSessionSerialNo],
    ),
    slots: e.room.m_rgSlotInfo.map((b) => b.toString("hex")),
    discovered: Array.from({ length: 8 }, (_, slot) =>
      e.room.HasUDPPeerInfo(slot),
    ),
    endpoints: Array.from({ length: 8 }, (_, slot) =>
      e.room.GetUDPPeerHosts(slot).map((h) => [h.Address, h.Port]),
    ),
    chief: e.room.m_nChiefSlotidx,
    ban: e.room.m_banChief.GetStateBytes(),
    ghosts: [...e.room.m_anSlotGhost],
    owners: [...e.room.m_anGhostSlot],
    count: e.room.m_nGhostCount,
    history: [...e.peers].map(([id, s]) => [id, s.GetBeforeJoinSessions()]),
    pools: [...e.peers.values()].map((s) => s.m_nPoolType),
    packets: [...e.peers.values()].map(packetBytes),
    ...retained(e.room),
  };
}

test("280 manual C++ departures cover ghost subsets/local order, ready/chief, reset/sync order, 12-stride matrix and last peer", () => {
  expect(vectors.Removals).toHaveLength(280);
  for (const v of vectors.Removals) {
    const e = basic(v.Players, v.Locals),
      r = e.room,
      leaving = e.peers.get(1)!;
    r.m_nChiefSlotidx = v.Chief;
    r.SetPlaying(v.Playing);
    r.m_nGameState = GameStage.Running;
    r.m_nGhostCount = v.GhostCount;
    r.m_anSlotGhost.set(v.GhostOfPlayer);
    v.GhostOfPlayer.forEach((g, slot) => {
      if (g >= 0) r.m_anGhostSlot[g] = slot;
    });
    for (let slot = 0; slot < 8; slot++) {
      r.m_rgSlotInfo[slot]!.set([
        v.SlotFlags[slot]!,
        0xc0 + slot + 1,
        0xa0 + slot,
      ]);
      r.m_aPlayerState[slot] = slot;
      r.GetCurrentGameContext().m_aPlayerStateTime[slot] =
        (0xffffff00 + slot) >>> 0;
      r.m_aBomberIdxPlaying[slot] = slot + 2;
      r.m_anBanPlayerVote[slot] = slot + 1;
    }
    for (const socket of e.peers.values()) {
      r.OnUDPPeerInfo(
        socket.GetUser(0)!,
        new HOSTHANDLE(0x7f000001, 1000 + socket.GetUser(0)!.m_nSlotIdx),
        [0, 0],
        [0, 0],
      );
    }
    e.peers.forEach((socket) => socket.Clear());
    r.m_adwOpaqueSlotMatrix.set(
      Array.from(
        { length: ListSessionLayout.SlotMatrixStride ** 2 },
        (_, i) => 100 + i,
      ),
    );
    v.BeforeHistory.forEach((idx) => leaving.AddBeforeJoinSession(idx));
    e.time(500);
    r.m_banChief.SetCanStart(true);
    r.m_banChief.SetOddSlot(true);
    r.m_banChief.SetWarnedBan(true);
    r.m_banChief.SetWarnedBanOddSlot(true);
    r.m_syncGameObjMan.Init(r);
    v.SyncObjects.forEach(([id, slot]) =>
      r.m_syncGameObjMan.Delegate(id!, slot!),
    );
    if (v.SyncStopped) r.m_syncGameObjMan.OnGameEnd();
    const onLeave = r.m_syncGameObjMan.OnPlayerLeave.bind(r.m_syncGameObjMan),
      observations: number[][] = [];
    r.m_syncGameObjMan.OnPlayerLeave = (slot) => {
      observations.push([slot, r.GetCurPlayer()]);
      onLeave(slot);
    };
    const before = retained(r),
      dynamic = e.users.map((u) => u?.GetDynamicInfoSnapshot());
    e.time(1600);
    const nativeDestroy = r.DestroyPlayer.bind(r),
      idsAtVirtualEntry: number[][][] = [];
    r.DestroyPlayer = (socket, notify) => {
      idsAtVirtualEntry.push(
        socket.m_aUser.map((u) => [
          u.m_nSessionIdx,
          u.m_nSessionSerialNo,
          u.m_nSlotIdx,
        ]),
      );
      return nativeDestroy(socket, notify);
    };
    expect(table(r).DestroyPlayer(leaving, v.NotifySelf)).toBe(true);
    expect(idsAtVirtualEntry).toEqual([
      v.Locals.map((slot) => [
        SessionLimit.NoSession,
        IntegerRange.UInt32Maximum,
        slot,
      ]),
    ]);
    expect(
      r.m_rgPlayer.map((u) =>
        u?.m_pClientSocket
          ? [...e.peers].find(([, s]) => s === u.m_pClientSocket)![0]
          : -1,
      ),
    ).toEqual(v.AfterPlayers);
    expect(r.m_rgSlotInfo.map((b) => b[0])).toEqual(v.AfterFlags);
    expect(r.m_rgSlotInfo.map((b) => [b[1], b[2]])).toEqual(
      Array.from({ length: 8 }, (_, i) => [0xc0 + i + 1, 0xa0 + i]),
    );
    expect([...r.m_anSlotGhost]).toEqual(v.AfterGhostOfPlayer);
    expect([...r.m_anGhostSlot]).toEqual(v.AfterOwnerOfGhost);
    expect(r.m_nGhostCount).toBe(v.GhostCount);
    expect([...r.m_anBanPlayerVote]).toEqual(v.AfterVotes);
    expect([...r.m_adwOpaqueSlotMatrix]).toEqual(v.AfterMatrix);
    expect(
      v.SyncObjects.flatMap(([id]) =>
        r.m_syncGameObjMan.GetOwner(id!) === undefined
          ? []
          : [[id!, r.m_syncGameObjMan.GetOwner(id!)!]],
      ),
    ).toEqual(v.AfterSyncObjects);
    expect(observations).toEqual([
      [v.Locals[0]!, v.AfterPlayers.filter((id) => id >= 0).length],
    ]);
    expect(r.m_nChiefSlotidx).toBe(v.AfterChief);
    expect(r.IsBangPok()).toBe(v.AfterBangPok);
    expect(r.m_banChief.GetStateBytes().toString("hex")).toBe(v.AfterBanChief);
    expect(leaving.GetBeforeJoinSessions()).toEqual(v.AfterHistory);
    expect(
      leaving.m_aUser.map((u) => [
        u.m_nSlotIdx,
        u.m_nSessionIdx,
        u.m_nSessionSerialNo,
      ]),
    ).toEqual(
      v.Locals.map(() => [
        -1,
        SessionLimit.NoSession,
        IntegerRange.UInt32Maximum,
      ]),
    );
    expect(leaving.m_nPoolType).toBe("Lobby");
    for (const slot of v.Locals) {
      expect(r.HasUDPPeerInfo(slot)).toBe(false);
      expect(
        r.GetUDPPeerHosts(slot).every((h) => h.Address === 0 && h.Port === 0),
      ).toBe(true);
    }
    expect(retained(r)).toEqual(before);
    expect(e.users.map((u) => u?.GetDynamicInfoSnapshot())).toEqual(dynamic);
    for (const [id, socket] of e.peers)
      expect(packetBytes(socket)).toEqual(
        v.Packets[id.toString() as keyof typeof v.Packets]!,
      );
  }
});

test("CBanChief has real native state resets and 624 unsigned strict deadlines; manner is deliberately unused", () => {
  let now = 0;
  const chief = new CBanChief(() => now);
  for (const step of vectors.ChiefStateSteps) {
    now = step.At;
    switch (step.Method) {
      case "Init":
        chief.Init();
        break;
      case "SetCanStart":
        chief.SetCanStart(step.Value);
        break;
      case "SetOddSlot":
        chief.SetOddSlot(step.Value);
        break;
      case "SetWarnedBan":
        chief.SetWarnedBan(step.Value);
        break;
      case "SetWarnedBanOddSlot":
        chief.SetWarnedBanOddSlot(step.Value);
        break;
      default:
        throw new Error("Unexpected native state step");
    }
    expect(chief.GetStateBytes().toString("hex")).toBe(step.Bytes);
  }
  expect(vectors.ChiefDeadlines).toHaveLength(624);
  for (const v of vectors.ChiefDeadlines) {
    now = v.Start;
    chief.Init();
    const before = chief.GetStateBytes();
    now = v.Now;
    expect(chief.IsBanChief(v.Full, v.Manner, v.Multiplier)).toBe(v.Ban);
    expect(chief.GetWarningDelay(v.Multiplier)).toBe(v.WarningDelay);
    expect(chief.GetOddSlotInManner(v.Multiplier)).toBe(v.OddDelay);
    expect(chief.GetStateBytes()).toEqual(before);
  }
  expect(chief.IsCanStart()).toBe(false);
  expect(chief.IsOddSlot()).toBe(false);
  expect(chief.IsWarnedBan()).toBe(false);
  expect(chief.IsWarnedBanOddSlot()).toBe(false);
  expect(chief.GetWarnedTime()).toBe(0);
  expect(chief.GetWarnedTimeOddSlot()).toBe(0);
  expect(chief.GetLastTimeEvenSlot()).toBe(0);
  for (const invalid of [-1, NaN, 0.5, 0x100000000])
    expect(() => chief.GetWarningDelay(invalid)).toThrow(CProtocolError);
});

test("29 read-only PE anchors bind departure ordering/pool4/timing to supplied FXGS; no EXE is run", () => {
  const pe = new CPeImage(OFFICIAL_SERVICES.FXGS);
  expect(pe.sha256).toBe(vectors.OfficialPE.SHA256);
  expect(vectors.InstructionAnchors).toHaveLength(29);
  for (const a of vectors.InstructionAnchors)
    expect(pe.read(a.VA, a.Bytes.length / 2).toString("hex")).toBe(a.Bytes);
});

test("low-level DeleteAllUser leaves stored slots/session ids/game peers intact;106 can read the retained slot and notifies only LAST local", () => {
  const e = basic(),
    r = e.room,
    a = e.peers.get(1)!,
    b = e.peers.get(2)!;
  r.m_rgSlotInfo[0]![0] = SlotStateMask.Chief | SlotStateMask.Ready;
  r.m_rgSlotInfo[1]![0] = SlotStateMask.Ready;
  r.OnUDPPeerInfo(
    a.GetUser(0)!,
    new HOSTHANDLE(0x7f000001, 40000),
    [0, 0],
    [0, 0],
  );
  e.peers.forEach((s) => s.Clear());
  r.m_aBomberIdxPlaying[0] = 8;
  const before = retained(r);
  r.DeleteAllUser(a);
  expect(r.GetCurPlayer()).toBe(3);
  expect(r.GetSlotidx(a.GetUser(0)!)).toBe(0);
  expect(r.FindPlayerSlot(a.GetUser(0)!)).toBe(-1);
  expect(
    a.m_aUser.map((u) => [u.m_nSlotIdx, u.m_nSessionIdx, u.m_nSessionSerialNo]),
  ).toEqual([
    [0, 17, 91],
    [1, 17, 91],
  ]);
  expect(r.m_rgSlotInfo[0]![0]).toBe(SlotStateMask.Ready);
  expect(r.m_nChiefSlotidx).toBe(0);
  expect(r.HasUDPPeerInfo(0)).toBe(true);
  expect(r.GetSockets()).not.toContain(a);
  expect(packetBytes(b)).toEqual([]);
  expect(retained(r)).toEqual(before);
  r.SendResetPlayer(a, true);
  expect(b.packets.map((p) => p.m_nPacketType)).toEqual([106, 106]);
  expect(packetBytes(a)).toEqual([
    new CSendPacket(106)
      .Encode1(1)
      .Encode4(serial + 1)
      .GetBuffer()
      .toString("hex"),
  ]);
  expect(a.m_nPoolType).toBe("Session");
  expect(a.GetBeforeJoinSessions()).toEqual([]);
  r.DeleteAllSlotidx(a);
  expect(a.m_aUser.map((u) => u.m_nSlotIdx)).toEqual([-1, -1]);
});

test("native Game layer clears slotidx but session IDX/serial belongs to the TABLE layer, not Game/DeleteAllUser", () => {
  const e = basic(),
    socket = e.peers.get(1)!;
  expect(e.room.DestroyPlayer(socket)).toBe(true);
  expect(
    socket.m_aUser.map((u) => [
      u.m_nSlotIdx,
      u.m_nSessionIdx,
      u.m_nSessionSerialNo,
    ]),
  ).toEqual([
    [-1, 17, 91],
    [-1, 17, 91],
  ]);
  expect(socket.m_nPoolType).toBe("Lobby");
  expect(socket.GetBeforeJoinSessions()).toEqual([17]);
  expect(e.room.GetCurPlayer()).toBe(3);
});

test("modern whole-group identity, ghost and unsupported cascade preflight is atomic, including the second local user", () => {
  for (const invalid of [
    "second-generation",
    "second-owner",
    "duplicate",
    "sparse",
    "ghost",
    "vote",
    "loading",
    "bangpok",
    "guild",
  ]) {
    const e = basic(
        undefined,
        undefined,
        invalid === "guild" ? ChannelType.Guild : ChannelType.Normal,
      ),
      a = e.peers.get(1)!,
      r = e.room;
    if (invalid === "second-generation") a.m_aUser[1]!.m_nSessionSerialNo++;
    if (invalid === "second-owner")
      a.m_aUser[1]!.m_pClientSocket = e.peers.get(2)!;
    if (invalid === "duplicate") a.m_aUser[1] = a.m_aUser[0]!;
    if (invalid === "sparse") delete a.m_aUser[1];
    if (invalid === "ghost") r.m_anSlotGhost[0] = 0; // inverse absent
    if (invalid === "vote") r.m_ulBanTargetSerialNo = serial + 4;
    if (invalid === "loading") {
      r.SetPlaying(true);
      r.m_nGameState = GameStage.Loading;
    }
    if (invalid === "bangpok") r.m_bBangPok = true;
    const before = membership(e);
    expect(() => table(r).DestroyPlayer(a)).toThrow();
    expect(membership(e)).toEqual(before);
  }
  const e = basic();
  e.room.OnPacket(
    Received(new CSendPacket(ClientRequest.SetGameTypeMod)),
    e.peers.get(1)!,
  );
  // Mod death/scoring remains unported, but this ordinary strategy departure
  // has NO mode-specific native callback and may leave a non-guild Mod room.
  expect(table(e.room).DestroyPlayer(e.peers.get(1)!)).toBe(true);
});

test("removing the last local pair closes table87 only; native sync early return retains objects and does NOT force playing false", () => {
  const e = basic([1, 1, -1, -1, -1, -1, -1, -1]),
    a = e.peers.get(1)!,
    r = e.room,
    notices: number[] = [];
  r.SetPlaying(true);
  r.m_nGameState = GameStage.Running;
  r.m_syncGameObjMan.Init(r);
  r.m_syncGameObjMan.Delegate(4, 0);
  const sessions = table(r, (p) => notices.push(p.m_nPacketType));
  expect(sessions.DestroyPlayer(a)).toBe(true);
  expect(sessions.GetBaseSession(17, 91)).toBeUndefined();
  expect(notices).toEqual([87]);
  expect(r.m_syncGameObjMan.GetOwner(4)).toBe(0);
  expect(r.m_bPlaying).toBe(true);
  expect(r.m_nChiefSlotidx).toBe(-2);
  expect(r.IsBangPok()).toBe(true);
  expect(a.packets).toHaveLength(0);
  expect(a.GetBeforeJoinSessions()).toEqual([17]);
  expect(sessions.DestroyPlayer(a)).toBe(false);
  expect(notices).toEqual([87]);
});

test("UDP removal permits owned closed/SetFree users, but195/pool4 guard tests only PRIMARY safe-object state", () => {
  for (const condition of [
    "open",
    "closed",
    "primary-free",
    "secondary-free",
  ]) {
    const e = basic(),
      target = e.peers.get(1)!,
      sessions = table(e.room),
      users = target.m_aUser.slice();
    if (condition === "closed") target.Close();
    if (condition === "primary-free") users[0]!.SetFree();
    if (condition === "secondary-free") users[1]!.SetFree();
    sessions.EjectPlayerForUDP(e.room, target);
    const notifies = condition === "open" || condition === "secondary-free";
    expect(target.packets.map((p) => p.m_nPacketType)).toEqual(
      notifies ? [195] : [],
    );
    if (notifies) expect(packetBytes(target)).toEqual(["99"]);
    expect(target.m_nPoolType).toBe(notifies ? "SessionRemoved" : "Lobby");
    expect(
      users.every(
        (u) =>
          u.m_nSlotIdx === -1 && u.m_nSessionIdx === SessionLimit.NoSession,
      ),
    ).toBe(true);
    expect(e.room.GetCurPlayer()).toBe(3);
    expect(target.GetBeforeJoinSessions()).toEqual([17]);
    expect(() => sessions.EjectPlayerForUDP(e.room, target)).toThrow(
      CProtocolError,
    );
  }
});

test("native pool4 tolerates late session requests, retains global/rank membership, and83/16 explicitly change stage", () => {
  for (const entry of [83, 16]) {
    const c = ChannelFixture(),
      s = peer();
    const users = c.gs.RegisterConnection(s, [UserInfo(`Pool${entry}`)]);
    c.pool.AddNewSocket(s);
    c.pool.InsertRankList(s);
    const room = create(c.sessions, s, "Room");
    s.Clear();
    c.sessions.EjectPlayerForUDP(room, s);
    expect(s.m_nPoolType).toBe("SessionRemoved");
    expect(s.Take(195).remaining).toBe(0);
    const rank = c.pool.GetRankList();
    for (const kind of [97, 109, 148, 159, 187])
      expect(() =>
        c.pool.OnPacket(Received(new CSendPacket(kind)), s),
      ).not.toThrow();
    expect(s.packets).toHaveLength(0);
    expect(s.IsConnected()).toBe(true);
    expect(c.pool.GetRankList()).toEqual(rank);
    expect(users[0]!.IsSetFree()).toBe(0);
    expect(
      c.center.m_globalUserTable.GetUser(users[0]!.GetGlobalSerialNo()),
    ).toBe(users[0]);
    c.pool.OnPacket(Received(new CSendPacket(entry)), s);
    expect(s.m_nPoolType).toBe(entry === 83 ? "Lobby" : "Channel");
    expect(s.packets.map((p) => p.m_nPacketType)).toEqual(
      entry === 83 ? [15] : [13, 14],
    );
    expect(c.pool.GetRankList()).toEqual(rank); // empty room table has no86 chunks
    c.gs.UnregisterConnection(s);
  }
});

test("pool4 is not an invented authentication pool: native ordinary create/join routes still apply without an automatic Lobby transition", () => {
  const c = ChannelFixture(),
    s = peer();
  c.gs.RegisterConnection(s, [UserInfo("Recreate")]);
  c.pool.AddNewSocket(s);
  c.pool.InsertRankList(s);
  const original = create(c.sessions, s, "First");
  c.sessions.EjectPlayerForUDP(original, s);
  s.Clear();
  expect(s.m_nPoolType).toBe("SessionRemoved");
  const packet = new CSendPacket(80)
    .EncodeStr("Direct recreate")
    .EncodeStr("")
    .Encode1(0)
    .Encode1(1)
    .Encode1(0);
  c.pool.OnPacket(Received(packet), s);
  const next = c.sessions.GetSession(s)!;
  expect(next.m_nIdx).toBe(original.m_nIdx);
  expect(next.m_ulSerialNo).not.toBe(original.m_ulSerialNo);
  expect(s.m_nPoolType).toBe("Session");
  expect(s.packets.some((p) => p.m_nPacketType === 15)).toBe(false);
  expect(s.GetBeforeJoinSessions()).toEqual([original.m_nIdx]);
  c.sessions.DestroyPlayer(s);
  c.gs.UnregisterConnection(s);
});

test("stale generation removal clears only the stale group's session ids; pool4 late requests cannot evict a recycled occupant", () => {
  const sessions = table(),
    old = peer(),
    current = peer();
  for (const [socket, id] of [
    [old, "Old"],
    [current, "New"],
  ] as const) {
    const u = new CUser(UserInfo(id), id === "Old" ? 1 : 2);
    u.m_pClientSocket = socket;
    socket.m_aUser.push(u);
  }
  const original = create(sessions, old, "Original");
  sessions.DestroyPlayer(old);
  const replacement = create(sessions, current, "Recycled");
  expect(replacement.m_nIdx).toBe(original.m_nIdx);
  expect(replacement.m_ulSerialNo).not.toBe(original.m_ulSerialNo);
  const stale = old.GetUser(0)!;
  stale.m_nSessionIdx = original.m_nIdx;
  stale.m_nSessionSerialNo = original.m_ulSerialNo;
  stale.m_nSlotIdx = 6;
  old.m_nPoolType = "Session";
  expect(() => sessions.OnPacket(Received(new CSendPacket(109)), old)).toThrow(
    CProtocolError,
  );
  old.m_nPoolType = "SessionRemoved";
  expect(() =>
    sessions.OnPacket(Received(new CSendPacket(109)), old),
  ).not.toThrow();
  expect(sessions.DestroyPlayer(old)).toBe(false);
  expect(stale.m_nSessionIdx).toBe(SessionLimit.NoSession);
  expect(stale.m_nSessionSerialNo).toBe(IntegerRange.UInt32Maximum);
  expect(stale.m_nSlotIdx).toBe(6); // native table stale path has no DeleteAllSlotidx
  expect(replacement.m_rgPlayer[0]).toBe(current.GetUser(0));
  expect(replacement.GetCurPlayer()).toBe(1);
});

test("stale/no-room inconsistent local tuples cannot clear another generation, including sparse and duplicate groups", () => {
  for (const corrupt of ["tuple", "slot-gap", "duplicate", "no-primary"]) {
    const e = basic(),
      a = e.peers.get(1)!,
      sessions = table(e.room);
    a.GetUser(0)!.m_nSessionSerialNo = 90;
    if (corrupt === "slot-gap") delete a.m_aUser[1];
    if (corrupt === "duplicate") a.m_aUser[1] = a.m_aUser[0]!;
    if (corrupt === "no-primary") delete a.m_aUser[0];
    // A duplicated stale tuple is still invalid even when serials agree.
    const ids = e.users.map(
        (u) => u && [u.m_nSlotIdx, u.m_nSessionIdx, u.m_nSessionSerialNo],
      ),
      roster = e.room.m_rgPlayer.slice();
    expect(() => sessions.DestroyPlayer(a)).toThrow(CProtocolError);
    expect(e.room.m_rgPlayer).toEqual(roster);
    expect(
      e.users.map(
        (u) => u && [u.m_nSlotIdx, u.m_nSessionIdx, u.m_nSessionSerialNo],
      ),
    ).toEqual(ids);
  }
});

test("five-room history is unique FIFO, duplicate does not refresh, and inspection cannot change it", () => {
  const s = peer();
  for (const idx of [5, 2, 5, 7, 1, 8, 9, 2, 10]) s.AddBeforeJoinSession(idx);
  expect(s.GetBeforeJoinSessions()).toEqual([7, 1, 8, 9, 10]);
  expect(s.CheckInBeforeJoinSession(2)).toBe(false);
  expect(s.CheckInBeforeJoinSession(7)).toBe(true);
  (s.GetBeforeJoinSessions() as number[]).fill(0);
  expect(s.GetBeforeJoinSessions()).toEqual([7, 1, 8, 9, 10]);
  for (const bad of [-1, 65536, NaN, 1.5])
    expect(() => s.AddBeforeJoinSession(bad)).toThrow(CProtocolError);
});

test("table-linked Running update uses strict unsigned >8000, removes BOTH locals before195, consumes graph and continues timers", () => {
  for (const start of [100, 0xfffffff0]) {
    const e = running(start),
      target = e.clients[1]!,
      users = target.m_aUser.slice();
    const ctx = e.room.GetCurrentGameContext();
    ctx.m_aBomb.push({
      SerialNo: 21,
      State: 0,
      RemainingMilliseconds: 8001,
      Row: 0,
      Column: 0,
      Power: 1,
      RemotelyPaused: false,
    });
    for (const slot of [3, 4]) {
      e.room.m_aPlayerState[slot] = GamePlayerState.PendingDie;
      ctx.m_aPlayerStateTime[slot] = (8001 - 10000) >>> 0;
    }
    loss(e);
    const matrix = e.room.m_udpLossRegulator.GetLossMatrix();
    e.time((start + 8000) >>> 0);
    e.sessions.UpdateGameSessions();
    expect(target.m_nPoolType).toBe("Connecting"); // trusted fixture, not network pool setup
    expect(e.room.GetCurPlayer()).toBe(6);
    expect(e.room.m_udpLossRegulator.GetLossMatrix()).toEqual(matrix);
    e.clients.forEach((c) => c.Clear());
    e.time((start + 8001) >>> 0);
    e.sessions.UpdateGameSessions();
    expect(e.sessions.GetUpdateFailures()).toEqual([]);
    expect(e.room.GetCurPlayer()).toBe(4);
    expect(
      users.every(
        (u) =>
          u.m_nSlotIdx === -1 && u.m_nSessionIdx === SessionLimit.NoSession,
      ),
    ).toBe(true);
    expect(packetBytes(target)).toEqual(["99"]);
    expect(target.m_nPoolType).toBe("SessionRemoved");
    expect(e.clients[0]!.packets.map((p) => p.m_nPacketType)).toEqual([
      106, 106, 152, 159,
    ]);
    expect(ctx.m_aBomb).toEqual([]);
    const death = e.clients[0]!.packets[3]!;
    death.Decode1();
    expect(death.Decode1()).toBe(0x50);
    expect(death.Decode2()).toBe(0);
    expect(death.Decode2()).toBe(0);
    expect(death.Decode1()).toBe(2);
    for (const slot of [3, 4]) {
      expect(death.Decode1()).toBe(slot);
      expect(death.Decode2()).toBe(9999);
      expect(death.Decode2()).toBe(9999);
      expect(e.room.m_aPlayerState[slot]).toBe(GamePlayerState.Inactive);
      expect(ctx.m_aPlayerStateTime[slot]).toBe(8001);
    }
    death.AssertEnd(); // slot3 has ALREADY left, but native timers still visit it
    expect(e.room.m_udpLossRegulator.m_bPending).toBe(false);
    expect([...e.room.m_udpLossRegulator.GetLossMatrix()]).toEqual(
      Array(64).fill(0),
    );
    expect(e.room.GetLastUpdateTime()).toBe((start + 8001) >>> 0);
    expect(e.room.m_bPlaying).toBe(true);
    expect(e.clock.GetEndGameTime()).toBe(0);
    expect(e.db.GetGameResultReceipt(e.key)).toBeUndefined();
    target.Clear();
    e.time((start + 8002) >>> 0);
    e.sessions.UpdateGameSessions();
    expect(target.packets).toHaveLength(0);
  }
});

test("last remaining primary self-loss closes the room during Update, consumes graph, and cannot publish stale86 after87", () => {
  const e = running(),
    last = e.clients[0]!;
  e.sessions.DestroyPlayer(e.clients[1]!);
  e.sessions.DestroyPlayer(e.clients[2]!);
  e.clients.forEach((s) => s.Clear());
  e.roomNotices.length = 0;
  loss(e, 0, 0);
  e.time(8101);
  e.sessions.UpdateGameSessions();
  expect(e.roomNotices).toEqual([87]);
  expect(last.packets.map((p) => p.m_nPacketType)).toEqual([195]);
  expect(e.room.GetCurPlayer()).toBe(0);
  expect(e.room.m_bPlaying).toBe(true);
  expect(e.sessions.GetBaseSession(17, 91)).toBeUndefined();
  expect(e.room.m_udpLossRegulator.m_bPending).toBe(false);
  expect(e.room.GetLastUpdateTime()).toBe(8101);
  expect(e.sessions.GetScheduledRoundCount()).toBe(0);
  expect(e.sessions.GetUpdateFailures()).toEqual([]);
  expect(e.db.GetGameResultReceipt(e.key)).toBeUndefined();
  e.time(8102);
  e.sessions.UpdateGameSessions();
  expect(e.roomNotices).toEqual([87]);
});

test("a later candidate's invalid second local prevents the FIRST ejection and graph/tick consumption, then succeeds after identity is restored", () => {
  const e = running();
  loss(e, 0, 2);
  loss(e, 1, 4);
  loss(e, 2, 0);
  expect(
    e.room.m_udpLossRegulator.GetRegulationCandidates(e.room.m_rgPlayer),
  ).toEqual([e.clients[0]!, e.clients[2]!]);
  const broken = e.clients[2]!.m_aUser[1]!;
  broken.m_nSessionSerialNo++;
  const roster = e.room.m_rgPlayer.slice(),
    graph = e.room.m_udpLossRegulator.GetLossMatrix(),
    before = retained(e.room);
  e.time(8101);
  e.sessions.UpdateGameSessions();
  expect(e.sessions.GetUpdateFailures()).toEqual([
    {
      SessionIndex: 17,
      SessionSerialNo: 91,
      Code: "protocol-error",
      ConsecutiveFailures: 1,
    },
  ]);
  expect(e.room.m_rgPlayer).toEqual(roster);
  expect(retained(e.room)).toEqual(before);
  expect(e.room.GetLastUpdateTime()).toBe(100);
  expect(e.room.m_udpLossRegulator.GetLossMatrix()).toEqual(graph);
  expect(e.clients.every((s) => s.packets.length === 0)).toBe(true);
  broken.m_nSessionSerialNo = 91;
  e.sessions.UpdateGameSessions();
  expect(e.sessions.GetUpdateFailures()).toEqual([]);
  expect(e.room.GetCurPlayer()).toBe(2);
  expect(e.clients[0]!.m_nPoolType).toBe("SessionRemoved");
  expect(e.clients[2]!.m_nPoolType).toBe("SessionRemoved");
  expect(e.room.m_nChiefSlotidx).toBe(2);
  expect(e.room.m_bPlaying).toBe(true);
  expect(e.room.m_udpLossRegulator.m_bPending).toBe(false);
  expect(e.room.GetLastUpdateTime()).toBe(8101);
});

test("detached removal packets publish final state, catch failures/reentry, still reach other peers, and never replay removal or195", () => {
  const e = running(),
    a = e.clients[0]!,
    target = e.clients[1]!,
    c = e.clients[2]!,
    users = target.m_aUser.slice();
  loss(e);
  const sendA = a.SendPacket.bind(a),
    snapshots: unknown[] = [],
    blocked: string[] = [];
  a.SendPacket = (p) => {
    if (p.m_nPacketType === 106) {
      snapshots.push({
        members: e.room.GetCurPlayer(),
        slots: users.map((u) => u.m_nSlotIdx),
        ids: users.map((u) => u.m_nSessionIdx),
        removing: e.room.IsRemovingPlayer(),
        pool: target.m_nPoolType,
      });
      for (const [name, invoke] of [
        ["room", () => e.room.DestroyPlayer(a)],
        ["table", () => e.sessions.DestroyPlayer(a)],
        ["packet", () => e.room.OnPacket(Received(new CSendPacket(109)), a)],
      ] as const) {
        try {
          invoke();
        } catch {
          blocked.push(name);
        }
      }
      p.InitPacket(42).Encode1(99); // must not affect c's copy of106
      throw new Error("private-transport-error");
    }
    sendA(p);
  };
  let notices = 0;
  target.SendPacket = (p) => {
    if (p.m_nPacketType !== 195)
      throw new Error("unexpected target publication");
    notices++;
    snapshots.push({
      pool: target.m_nPoolType,
      tableGuard: e.sessions.IsRemovingPlayer(target),
      end: e.room.DeferHandleGameEnd(),
      update: e.room.UpdateResultLifecycle(),
      return: e.room.DoReturnPrepareStage(),
    });
    try {
      e.sessions.OnPacket(Received(new CSendPacket(109)), target);
    } catch {
      blocked.push("195-packet");
    }
    e.room.Update(); // no nested execution
    throw new Error("private-195-error");
  };
  e.time(8101);
  e.sessions.UpdateGameSessions();
  expect(snapshots).toEqual([
    {
      members: 4,
      slots: [-1, -1],
      ids: [65535, 65535],
      removing: true,
      pool: "Lobby",
    },
    {
      members: 4,
      slots: [-1, -1],
      ids: [65535, 65535],
      removing: true,
      pool: "Lobby",
    },
    {
      pool: "Lobby",
      tableGuard: true,
      end: false,
      update: false,
      return: false,
    },
  ]);
  expect(blocked).toEqual([
    "room",
    "table",
    "packet",
    "room",
    "table",
    "packet",
    "195-packet",
  ]);
  expect(
    e.room.m_rgPlayer.flatMap((u, slot) =>
      u ? [[slot, u.m_nSessionIdx, u.m_nSessionSerialNo]] : [],
    ),
  ).toEqual([
    [0, 17, 91],
    [1, 17, 91],
    [4, 17, 91],
    [5, 17, 91],
  ]);
  expect(c.packets.map((p) => p.m_nPacketType)).toEqual([106, 106]);
  expect(c.packets.map((p) => p.m_uLength)).toEqual([6, 6]);
  expect(e.room.GetPacketPublicationFailureCount()).toBe(2);
  expect(e.sessions.GetRemovalPublicationFailures()).toEqual({
    RecoveryNotice: 1,
    RoomNotice: 0,
  });
  expect(e.sessions.GetUpdateFailures()).toEqual([]);
  expect(target.m_nPoolType).toBe("SessionRemoved");
  expect(e.room.m_udpLossRegulator.m_bPending).toBe(false);
  expect(e.room.GetLastUpdateTime()).toBe(8101);
  e.time(8102);
  e.sessions.UpdateGameSessions();
  expect(notices).toBe(1);
  expect(c.packets).toHaveLength(2);
  expect(
    JSON.stringify(e.sessions.GetRemovalPublicationFailures()),
  ).not.toContain("private");
});

test("table notice transport failure cannot strand195/pool4 or roll back a committed departure", () => {
  const e = basic(),
    target = e.peers.get(1)!;
  const sessions = table(e.room, () => {
    throw new Error("private-broadcast-failure");
  });
  sessions.EjectPlayerForUDP(e.room, target);
  expect(e.room.GetCurPlayer()).toBe(3);
  expect(target.m_nPoolType).toBe("SessionRemoved");
  expect(packetBytes(target)).toEqual(["99"]);
  expect(sessions.GetRemovalPublicationFailures()).toEqual({
    RecoveryNotice: 0,
    RoomNotice: 1,
  });
});

test("undurable frozen CAS plan blocks every departure path before mutation; restoring SQL retries original duration, then durable departure is permitted", () => {
  const e = running();
  e.room.m_aPlayerState.set(NormalResultCase.States);
  e.time(15100);
  e.db.session.db
    .query("UPDATE FxUserDynamic SET Money=Money+1 WHERE ID='Result5'")
    .run();
  expect(e.room.UpdateResultLifecycle()).toBe(false);
  expect(e.room.IsResultCommitPending()).toBe(true);
  const roster = e.room.m_rgPlayer.slice(),
    ids = e.clients.map((s) =>
      s.m_aUser.map((u) => [
        u.m_nSlotIdx,
        u.m_nSessionIdx,
        u.m_nSessionSerialNo,
      ]),
    ),
    before = retained(e.room),
    target = e.clients[1]!;
  for (const remove of [
    () => e.room.DestroyPlayer(target),
    () => e.room.DeleteAllUser(target),
    () => e.sessions.DestroyPlayer(target),
    () => e.sessions.EjectPlayerForUDP(e.room, target),
  ])
    expect(remove).toThrow(CProtocolError);
  expect(e.room.m_rgPlayer).toEqual(roster);
  expect(retained(e.room)).toEqual(before);
  expect(
    e.clients.map((s) =>
      s.m_aUser.map((u) => [
        u.m_nSlotIdx,
        u.m_nSessionIdx,
        u.m_nSessionSerialNo,
      ]),
    ),
  ).toEqual(ids);
  expect(e.clients.every((s) => !s.packets.length)).toBe(true);
  expect(e.db.GetGameResultReceipt(e.key)).toBeUndefined();
  e.db.session.db
    .query("UPDATE FxUserDynamic SET Money=Money-1 WHERE ID='Result5'")
    .run();
  e.time(90100);
  expect(e.room.UpdateResultLifecycle()).toBe(true);
  const receipt = e.db.GetGameResultReceipt(e.key)!;
  expect(JSON.parse(receipt.Payload).ElapsedMilliseconds).toBe(15000);
  expect(e.sessions.DestroyPlayer(target)).toBe(true);
  expect(e.room.GetCurPlayer()).toBe(4);
  expect(e.db.GetGameResultReceipt(e.key)).toEqual(receipt);
  expect(e.room.DoReturnPrepareStage()).toBe(true);
  expect(e.room.m_bPlaying).toBe(false);
  expect(e.db.GetGameResultReceipt(e.key)).toEqual(receipt);
});

test("closed TCP disconnect still releases rank/Center/global ownership when room removal throws; no pretend offline settlement", async () => {
  const app = new CServerApp(TestConfig()),
    game = app.m_gameServers[0]!,
    s = peer();
  try {
    const server = app.m_center.m_localServerMan.GetSvr(ServerType.FXGame, 0)!;
    const users = app.m_center.OnAddNewUser(s, server, [
      UserInfo("ClosedA"),
      UserInfo("ClosedB"),
    ]);
    game.m_channelPool.AddNewSocket(s);
    game.m_channelPool.InsertRankList(s);
    expect(game.m_channelPool.GetRankList()).toHaveLength(2);
    game.m_gameSessionTable.DestroyPlayer = () => {
      throw new CProtocolError("frozen room cannot remove");
    };
    s.Close();
    expect(() => game.m_listenSocket.OnDisconnect(s)).toThrow("frozen");
    expect(game.m_channelPool.GetRankList()).toEqual([]);
    expect(s.GetUserCount()).toBe(0);
    expect(users.map((u) => u.IsSetFree())).toEqual([1, 1]);
    expect(
      users.every(
        (u) =>
          app.m_center.m_globalUserTable.GetUser(u.GetGlobalSerialNo()) ===
          undefined,
      ),
    ).toBe(true);
    expect(app.m_center.m_globalUserTable.GetUserCount()).toBe(0);
    expect(
      app.m_dbSession.db
        .query<{ n: number }, []>("SELECT count(*) AS n FROM RuntimeGameResult")
        .get()!.n,
    ).toBe(0);
  } finally {
    await app.CleanUp();
  }
});

test("without a table-owned removal service due graphs remain fail-closed, unchanged and unconsumed", () => {
  const e = running(100, false);
  loss(e);
  const graph = e.room.m_udpLossRegulator.GetLossMatrix(),
    before = retained(e.room);
  e.time(8101);
  expect(() => e.room.Update()).toThrow(CUnsupportedOperation);
  expect(e.room.m_udpLossRegulator.GetLossMatrix()).toEqual(graph);
  expect(e.room.m_udpLossRegulator.m_bPending).toBe(true);
  expect(retained(e.room)).toEqual(before);
  expect(e.room.GetLastUpdateTime()).toBe(100);
  expect(e.room.GetCurPlayer()).toBe(6);
});
