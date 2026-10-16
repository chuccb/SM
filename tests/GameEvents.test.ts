import { afterEach, expect, test } from "bun:test";
import vectors from "./fixtures/gameplay-vectors.json";
import { CFastFile } from "../Common/CFastFile.ts";
import { CTextCodec } from "../Common/CTextCodec.ts";
import { CUser } from "../Common/CUser.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CBomberAttr } from "../FXGS/CBomberAttr.ts";
import { CGameMapTmplList } from "../FXGS/CGameMapTmplList.ts";
import { CGameSession } from "../FXGS/CGameSession.ts";
import { CGameClock } from "../FXGS/CGameClock.ts";
import { CSyncGameObjMan } from "../FXGS/CSyncGameObjMan.ts";
import { GameStage } from "../Common/OfficialValues.ts";
import { MemoryClient, Received } from "./helpers/Clients.ts";
import { UserInfo } from "./helpers/Accounts.ts";

const files = new CFastFile();
files.FastFileInit("FXGS/FxServer");
const bombers = new CBomberAttr();
bombers.Load(files);
const maps = new CGameMapTmplList();
maps.CreateTmplList(files);
const sockets: MemoryClient[] = [];
let serial = 0;
function peer(...ids: string[]): MemoryClient {
  const socket = new MemoryClient();
  sockets.push(socket);
  for (const id of ids) {
    const u = new CUser(UserInfo(id), ++serial);
    u.m_pClientSocket = socket;
    socket.m_aUser.push(u);
  }
  return socket;
}
/** Trusted test setup only. Real RequestStartGame still CANNOT enter battle. */
function game(running = true) {
  let now = 100;
  const clock = new CGameClock(() => now);
  const room = new CGameSession(
    0,
    13,
    "Kernel tests",
    "",
    0,
    new CTextCodec(),
    bombers,
    maps,
    0,
    clock,
  );
  const a = peer("A", "A2");
  const b = peer("B");
  room.AddAllUser(a, [10, 10]);
  room.AddAllUser(b, [10]);
  room.m_bPlaying = running;
  room.m_nGameState = running ? GameStage.Running : GameStage.Loading;
  clock.StartGame();
  a.Clear();
  b.Clear();
  return {
    room,
    a,
    b,
    clock,
    time: (value: number) => {
      now = value;
    },
  };
}
const send = (room: CGameSession, peer: MemoryClient, packet: CSendPacket) =>
  room.OnPacket(Received(packet), peer);
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.Close();
});

test("GetSelfidx searches socket identity, not room slot, serial or a fabricated flag", () => {
  const { a, b } = game();
  expect(a.m_aUser[0]!.GetSelfidx()).toBe(0);
  expect(a.m_aUser[1]!.GetSelfidx()).toBe(1);
  expect(b.m_aUser[0]!.m_nSlotIdx).toBe(2);
  expect(b.m_aUser[0]!.GetSelfidx()).toBe(0);
  const detached = new CUser(UserInfo("Detached"), ++serial);
  expect(detached.GetSelfidx()).toBe(-1);
  detached.m_pClientSocket = a;
  expect(detached.GetSelfidx()).toBe(-1);
});
test("battle packets cannot promote waiting/loading/result rooms to running", () => {
  const { room, a, b } = game(false);
  const request = () =>
    send(room, a, new CSendPacket(140).Encode1(0).Encode1(0x12).Encode1(3));
  expect(request).toThrow("outside a running game");
  room.m_bPlaying = true;
  expect(request).toThrow("outside a running game");
  room.m_nGameState = GameStage.Result;
  expect(request).toThrow("outside a running game");
  expect(room.GetCurrentGameContext().m_aBomb).toEqual([]);
  expect(a.packets.length + b.packets.length).toBe(0);
  expect(() =>
    send(
      room,
      a,
      new CSendPacket(158).Encode2(1).EncodeBuffer(Buffer.alloc(20)),
    ),
  ).toThrow();
});
test("ignite uses room-slot ownership, allocates native record and broadcasts once per TCP peer", () => {
  const { room, a, b } = game();
  send(room, b, new CSendPacket(140).Encode1(2).Encode1(0x12).Encode1(0xc3));
  for (const peer of [a, b]) {
    const p = peer.Take(153);
    expect(p.Decode1()).toBe(2);
    expect(p.Decode1()).toBe(0x12);
    expect(p.Decode1()).toBe(0xc3);
    expect(p.Decode2()).toBe(0);
    p.AssertEnd();
    expect(peer.packets.length).toBe(0);
  }
  const ctx = room.GetCurrentGameContext();
  expect(ctx.m_aBomb[0]).toEqual({
    SerialNo: 0,
    State: 0,
    RemainingMilliseconds: 2800,
    Row: 1,
    Column: 2,
    Power: 3,
    RemotelyPaused: true,
  });
  expect(() =>
    send(room, b, new CSendPacket(140).Encode1(0).Encode1(0x12).Encode1(3)),
  ).toThrow("does not belong");
  expect(() =>
    send(room, b, new CSendPacket(140).Encode1(8).Encode1(0x12).Encode1(3)),
  ).toThrow();
  expect(() =>
    send(room, b, new CSendPacket(140).Encode1(2).Encode1(0xdf).Encode1(3)),
  ).toThrow("coordinate");
  expect(() =>
    send(
      room,
      b,
      new CSendPacket(140).Encode1(2).Encode1(0x12).Encode1(3).Encode1(0),
    ),
  ).toThrow("trailing");
  expect(ctx.m_aBomb.length).toBe(1);
  expect(ctx.m_nNextBombSerialNo).toBe(1);
  expect(a.packets.length + b.packets.length).toBe(0);
});
test("kick/throw response omits old coordinates and timer; landing and expiry use opcode 152", () => {
  const { room, a, b } = game();
  send(room, a, new CSendPacket(140).Encode1(1).Encode1(0x12).Encode1(3));
  a.Clear();
  b.Clear();
  send(
    room,
    a,
    new CSendPacket(141)
      .Encode1(0xa1)
      .Encode2(0)
      .Encode1(0x12)
      .Encode1(0x22)
      .Encode2(100),
  );
  for (const socket of [a, b]) {
    const p = socket.Take(154);
    expect(p.Decode1()).toBe(0xa1);
    expect(p.Decode2()).toBe(0);
    expect(p.Decode1()).toBe(0x22);
    p.AssertEnd();
  }
  room.UpdateBombTimers(100);
  for (const socket of [a, b]) {
    const p = socket.Take(152);
    expect(p.Decode1()).toBe(1);
    expect(p.Decode2()).toBe(0);
    expect(p.Decode1()).toBe(1);
    p.AssertEnd();
  }
  room.UpdateBombTimers(2000);
  for (const socket of [a, b]) {
    const p = socket.Take(152);
    expect(p.Decode1()).toBe(1);
    expect(p.Decode2()).toBe(0);
    expect(p.Decode1()).toBe(0);
    p.AssertEnd();
  }
  expect(room.GetCurrentGameContext().m_aBomb.length).toBe(0);
  room.UpdateBombTimers(1);
  expect(a.packets.length + b.packets.length).toBe(0);
});
test("bomb timer needs matching current coordinates and stationary state but not original igniter", () => {
  const { room, a, b } = game();
  send(room, a, new CSendPacket(140).Encode1(0).Encode1(0x12).Encode1(0x43));
  a.Clear();
  b.Clear();
  send(room, b, new CSendPacket(142).Encode2(0).Encode1(0x13).Encode2(1));
  room.UpdateBombTimers(10000);
  expect(room.GetCurrentGameContext().m_aBomb[0]!.RemainingMilliseconds).toBe(
    2800,
  );
  send(room, b, new CSendPacket(142).Encode2(0).Encode1(0x12).Encode2(10));
  room.UpdateBombTimers(10);
  expect(room.GetCurrentGameContext().m_aBomb).toEqual([]);
  for (const socket of [a, b]) {
    const p = socket.Take(152);
    expect(p.Decode1()).toBe(1);
    expect(p.Decode2()).toBe(0);
    expect(p.Decode1()).toBe(0);
    p.AssertEnd();
  }
});
test("box/obstacle/effect forwards preserve native sender exclusion and opaque data bytes", () => {
  const { room, a, b } = game();
  const ctx = room.GetCurrentGameContext();
  ctx.SetObstacleState(1, 2, 1);
  send(room, a, new CSendPacket(148).Encode1(7).Encode1(0x12));
  expect(a.packets.length).toBe(0);
  expect(ctx.GetObstacleState(1, 2)).toBe(0);
  const drop = b.Take(161);
  expect(drop.Decode1()).toBe(7);
  expect(drop.Decode1()).toBe(0x12);
  drop.AssertEnd();
  send(room, a, new CSendPacket(143).EncodeBuffer(Buffer.from([1, 2, 3, 4])));
  // Raw buffer is already scalar-obfuscated here, matching opaque relay bytes.
  for (const socket of [a, b])
    expect(socket.Take(155).DecodeBuffer(4)).toEqual(Buffer.from([1, 2, 3, 4]));
  send(room, a, new CSendPacket(150).Encode1(0x21).Encode1(9).Encode1(0x43));
  for (const socket of [a, b]) {
    const p = socket.Take(165);
    expect([p.Decode1(), p.Decode1(), p.Decode1()]).toEqual([0x21, 9, 0x43]);
    p.AssertEnd();
  }
  const opaque = Buffer.from([0, 0xff, 0x5a, 0x96, 0xca, 0x53, 0x95]);
  send(room, a, new CSendPacket(147).EncodeBuffer(opaque));
  expect(a.packets.length).toBe(0);
  expect(b.Take(160).DecodeBuffer(opaque.length)).toEqual(opaque);
});
test("malformed or out-of-room battle requests cannot partially modify context or broadcast", () => {
  const { room, a, b } = game();
  const stranger = peer("Stranger");
  expect(() =>
    send(
      room,
      stranger,
      new CSendPacket(140).Encode1(0).Encode1(0x12).Encode1(3),
    ),
  ).toThrow("not in this room");
  expect(() =>
    send(room, a, new CSendPacket(140).Encode1(0).Encode1(0x12)),
  ).toThrow("Truncated");
  expect(() =>
    send(room, a, new CSendPacket(148).Encode1(0).Encode1(0xdf)),
  ).toThrow("coordinate");
  expect(() =>
    send(room, a, new CSendPacket(143).Encode1(0).Encode1(1)),
  ).toThrow("Truncated");
  expect(room.GetCurrentGameContext().m_aBomb).toEqual([]);
  expect(a.packets.length + b.packets.length).toBe(0);
});
test("sync initial delegation balances only first-local-player slots; low slot wins ties", () => {
  const { room, a, b } = game();
  const sync = room.m_syncGameObjMan;
  expect(sync.FindMinimumLoadSlotIdx()).toBe(0);
  sync.SetInitialObjNo(5);
  expect([0, 1, 2, 3, 4].map((id) => sync.GetOwner(id))).toEqual([
    0, 2, 0, 2, 0,
  ]);
  for (const socket of [a, b])
    for (let id = 0; id < 5; id++) {
      const p = socket.Take(175);
      expect(p.Decode2()).toBe(id);
      expect(p.Decode1()).toBe(id % 2 ? 2 : 0);
      p.AssertEnd();
    }
  expect(sync.GetObjectCount()).toBe(5);
  expect(sync.FindMinimumLoadSlotIdx()).toBe(2);
  expect(() => sync.Delegate(100, 1)).toThrow("controller");
  expect(() => sync.Delegate(0, 2)).toThrow("Duplicate");
  expect(() => sync.SetInitialObjNo(65537)).toThrow();
  expect(sync.GetObjectCount()).toBe(5);
});
test("sync creation interval is shared across all peers and subtracts accumulated clock suspension", () => {
  const { room, a, b, clock, time } = game();
  const sync = room.m_syncGameObjMan;
  sync.SetInitialObjNo(2);
  a.Clear();
  b.Clear();
  const data = Buffer.from(Array.from({ length: 20 }, (_, i) => i));
  const create = () =>
    send(room, b, new CSendPacket(158).Encode2(0x1234).EncodeBuffer(data));
  time(5099);
  create();
  expect(sync.GetObjectCount()).toBe(2);
  expect(a.packets.length).toBe(0);
  time(5100);
  create();
  expect(sync.GetObjectCount()).toBe(3);
  for (const socket of [a, b]) {
    const p = socket.Take(174);
    expect(p.Decode2()).toBe(2);
    expect(p.Decode1()).toBe(0);
    expect(p.Decode2()).toBe(0x1234);
    expect(p.DecodeBuffer(20)).toEqual(data);
    p.AssertEnd();
  }
  send(room, a, new CSendPacket(158).Encode2(1).EncodeBuffer(data));
  expect(sync.GetObjectCount()).toBe(3);
  time(6000);
  clock.SuspendGame();
  time(8000);
  clock.ResumeGame();
  time(12099);
  create();
  expect(sync.GetObjectCount()).toBe(3);
  time(12100);
  create();
  expect(sync.GetObjectCount()).toBe(4);
  expect(sync.GetOwner(3)).toBe(2);
});
test("malformed sync creation does not consume interval or ID; additional destroy ownership is fail-closed", () => {
  const { room, a, b, time } = game();
  const sync = room.m_syncGameObjMan;
  sync.SetInitialObjNo(1);
  a.Clear();
  b.Clear();
  time(5100);
  expect(() =>
    send(
      room,
      a,
      new CSendPacket(158).Encode2(7).EncodeBuffer(Buffer.alloc(19)),
    ),
  ).toThrow("Truncated");
  expect(sync.GetObjectCount()).toBe(1);
  send(room, a, new CSendPacket(158).Encode2(7).EncodeBuffer(Buffer.alloc(20)));
  expect(sync.GetOwner(1)).toBe(2);
  a.Clear();
  b.Clear();
  expect(() =>
    send(room, b, new CSendPacket(159).Encode2(0).Encode4(0xffffffff)),
  ).toThrow("another controller");
  expect(sync.GetOwner(0)).toBe(0);
  expect(a.packets.length + b.packets.length).toBe(0);
  send(room, a, new CSendPacket(159).Encode2(0).Encode4(0xfedcba98));
  for (const socket of [a, b]) {
    const p = socket.Take(176);
    expect(p.Decode2()).toBe(0);
    expect(p.Decode4()).toBe(0xfedcba98);
    p.AssertEnd();
  }
  expect(sync.GetOwner(0)).toBeUndefined();
  expect(sync.GetObjectCount()).toBe(1);
  send(room, a, new CSendPacket(159).Encode2(999).Encode4(0));
  expect(a.packets.length + b.packets.length).toBe(0);
});
test("sync OnPlayerLeave destroys owned objects in sorted native std::set order; stop and reinit are explicit", () => {
  const { room, a, b, time } = game();
  const sync = room.m_syncGameObjMan;
  sync.Delegate(19, 0);
  sync.Delegate(3, 0);
  sync.Delegate(8, 2);
  sync.OnPlayerLeave(0);
  for (const socket of [a, b])
    for (const id of [3, 19]) {
      const p = socket.Take(176);
      expect(p.Decode2()).toBe(id);
      expect(p.Decode4()).toBe(0);
      p.AssertEnd();
    }
  expect(sync.GetObjectCount()).toBe(1);
  expect(sync.GetOwner(8)).toBe(2);
  sync.OnGameEnd();
  time(10000);
  send(room, b, new CSendPacket(158).Encode2(1).EncodeBuffer(Buffer.alloc(20)));
  send(room, b, new CSendPacket(159).Encode2(8).Encode4(3));
  sync.OnPlayerLeave(2);
  expect(sync.GetObjectCount()).toBe(1);
  expect(a.packets.length + b.packets.length).toBe(0);
  sync.Init(room);
  expect(sync.GetObjectCount()).toBe(0);
  expect(sync.FindMinimumLoadSlotIdx()).toBe(0);
});
test("native departure resets slots before primary sync cleanup and finally clears slot indices", () => {
  const { room, a, b } = game();
  const sync = room.m_syncGameObjMan;
  sync.SetInitialObjNo(2);
  a.Clear();
  b.Clear();
  room.DestroyPlayer(a);
  expect(sync.GetOwner(0)).toBeUndefined();
  expect(sync.GetOwner(1)).toBe(2);
  for (const slot of [0, 1]) {
    const reset = b.Take(106);
    expect(reset.Decode1()).toBe(slot);
    expect(reset.Decode4()).toBe(a.m_aUser[slot]!.GetGlobalSerialNo());
    reset.AssertEnd();
  }
  const p = b.Take(176);
  expect(p.Decode2()).toBe(0);
  expect(p.Decode4()).toBe(0);
  p.AssertEnd();
  expect(room.GetPlayerNo()).toBe(1);
  expect(a.m_aUser.every((u) => u.m_nSlotIdx === -1)).toBe(true);
});
test("sync without an initialized session or eligible controller cannot invent ownership", () => {
  const sync = new CSyncGameObjMan();
  expect(sync.FindMinimumLoadSlotIdx()).toBe(-1);
  expect(() => sync.SetInitialObjNo(1)).toThrow("no session");
  const { room } = game();
  room.m_rgPlayer.fill(undefined);
  sync.Init(room);
  sync.SetInitialObjNo(3);
  expect(sync.GetObjectCount()).toBe(0);
  expect(sync.FindMinimumLoadSlotIdx()).toBe(-1);
});

// Deliberately artificial long elapsed values exercise x86 signed jl. They are
// not a claim that native rounds last 24+ days or that start is implemented.
test("sync creation signed-overflow deadline matches independent C++/.lst reference", () => {
  const { room, a, b, clock, time } = game();
  let count = 0;
  for (const step of vectors.syncRates) {
    time((100 + step.elapsed) >>> 0);
    clock.m_dwTimeStopped = step.stopped;
    send(
      room,
      a,
      new CSendPacket(158).Encode2(1).EncodeBuffer(Buffer.alloc(20)),
    );
    if (step.allowed) count++;
    expect(room.m_syncGameObjMan.GetObjectCount()).toBe(count);
    expect(a.packets.length).toBe(step.allowed ? 1 : 0);
    expect(b.packets.length).toBe(step.allowed ? 1 : 0);
    a.Clear();
    b.Clear();
  }
});

test("sync initial-count reuse is rejected before resetting the allocator; wire IDs remain bounded", () => {
  const { room, a, b, time } = game();
  const sync = room.m_syncGameObjMan;
  sync.SetInitialObjNo(3);
  a.Clear();
  b.Clear();
  expect(() => sync.SetInitialObjNo(1)).toThrow("Initialize");
  expect(sync.GetObjectCount()).toBe(3);
  time(5100);
  send(room, a, new CSendPacket(158).Encode2(7).EncodeBuffer(Buffer.alloc(20)));
  expect(sync.GetOwner(3)).toBe(2);
  for (const socket of [a, b]) {
    const p = socket.Take(174);
    expect(p.Decode2()).toBe(3);
  }
  for (const invalid of [-1, 0.5, NaN, Infinity, 65536])
    expect(() => sync.Delegate(invalid, 0)).toThrow("wire field");
  expect(sync.GetObjectCount()).toBe(4);
  sync.Delegate(65535, 0);
  expect(sync.GetOwner(65535)).toBe(0);
});

test("native 150-bomb capacity is enforced at the room adapter without allocating another serial", () => {
  const { room, a, b } = game();
  for (let i = 0; i < 150; i++)
    send(room, a, new CSendPacket(140).Encode1(0).Encode1(0x12).Encode1(3));
  expect(room.GetCurrentGameContext().m_aBomb.length).toBe(150);
  expect(a.packets.length).toBe(150);
  expect(b.packets.length).toBe(150);
  a.Clear();
  b.Clear();
  expect(() =>
    send(room, a, new CSendPacket(140).Encode1(0).Encode1(0x12).Encode1(3)),
  ).toThrow("overflow");
  expect(room.GetCurrentGameContext().m_nNextBombSerialNo).toBe(150);
  expect(a.packets.length + b.packets.length).toBe(0);
});
