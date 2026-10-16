import { afterEach, expect, test } from "bun:test";
import { CPeImage } from "../Tools/OfficialSource.ts";
import vectors from "./fixtures/session-vectors.json";
import { CFastFile } from "../Common/CFastFile.ts";
import { CTextCodec } from "../Common/CTextCodec.ts";
import { CUser } from "../Common/CUser.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CReceivedPacketBase } from "../Common/CReceivedPacketBase.ts";
import { HOSTHANDLE, invalidHost } from "../Common/HOSTHANDLE.ts";
import {
  DecodeUnreliableDatagram,
  EncodeUnregisteredDatagram,
} from "../Common/MTUDPProtocol.ts";
import {
  CipherDegree,
  GameStage,
  SessionLimit,
  SlotStateMask,
} from "../Common/OfficialValues.ts";
import { CBomberAttr } from "../FXGS/CBomberAttr.ts";
import { CGameMapTmplList } from "../FXGS/CGameMapTmplList.ts";
import { CGameClock } from "../FXGS/CGameClock.ts";
import { CGameSession } from "../FXGS/CGameSession.ts";
import { CGameSessionTable } from "../FXGS/CGameSessionTable.ts";
import { CUDPPacketDispatcher } from "../FXGS/CUDPPacketDispatcher.ts";
import { MemoryClient, Received } from "./helpers/Clients.ts";
import { UserInfo } from "./helpers/Accounts.ts";

const files = new CFastFile();
files.FastFileInit("FXGS/FxServer");
const bombers = new CBomberAttr();
bombers.Load(files);
const maps = new CGameMapTmplList();
maps.CreateTmplList(files);
const sockets: MemoryClient[] = [];
let serial = 100;
function peer(count = 1, address = "127.0.0.1", firstSerial?: number) {
  const socket = new MemoryClient(address);
  sockets.push(socket);
  for (let i = 0; i < count; i++) {
    const id = firstSerial === undefined ? ++serial : firstSerial + i;
    const user = new CUser(UserInfo(`U${id}`), id);
    user.m_pClientSocket = socket;
    socket.m_aUser.push(user);
  }
  return socket;
}
function setup(firstTime = 100) {
  let time = firstTime;
  const clock = new CGameClock(() => time);
  const room = new CGameSession(
    7,
    0x10203040,
    "Negotiation kernel",
    "",
    0,
    new CTextCodec(),
    bombers,
    maps,
    0,
    clock,
  );
  return { room, clock, time: (value: number) => (time = value) };
}
function table(room: CGameSession) {
  const sessions = new CGameSessionTable(room.text, bombers, maps, 0, () => {});
  sessions.m_rgGameSession.set(room.m_nIdx, room);
  return sessions;
}
const send = (room: CGameSession, socket: MemoryClient, packet: CSendPacket) =>
  room.OnPacket(Received(packet), socket);
const flags = (room: CGameSession) => room.m_rgSlotInfo.map((s) => s[0]);
function discovered(room: CGameSession, socket: MemoryClient, port = 40000) {
  return room.OnUDPPeerInfo(
    socket.m_aUser[0]!,
    HOSTHANDLE.FromAddress(socket.address, port),
    [0, 0],
    [0, 0],
  );
}
/** TRUSTED TEST SETUP ONLY. No network request can commit a loading stage yet. */
function loading(room: CGameSession, selected: number[]) {
  room.m_nMapIdxPlaying = 200;
  room.m_bPlaying = true;
  room.m_nGameState = GameStage.Loading;
  room.m_aBomberIdxPlaying.set(selected);
}
function ready(room: CGameSession, socket: MemoryClient) {
  const packet = new CSendPacket(109).Encode4(maps.GetCRC(200));
  for (const user of socket.m_aUser) {
    const index = room.m_aBomberIdxPlaying[user.m_nSlotIdx]!;
    packet
      .Encode1(index)
      .Encode1(bombers.GetDefBombCount(index))
      .Encode1(bombers.GetDefBombPower(index))
      .Encode1(bombers.GetDefSpeed(index));
  }
  return packet;
}
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.Close();
});

for (const input of vectors.launches)
  test(`116 matches manual C++ selection/shuffle/encoding: ${input.name}`, () => {
    const { room, clock } = setup(input.time);
    for (let slot = 0; slot < SessionLimit.Players; slot++)
      if (input.selected[slot]! < 0)
        room.m_rgSlotInfo[slot]![0] = SlotStateMask.Closed;
    for (let slot = 0; slot < SessionLimit.Players; slot++) {
      if (input.selected[slot]! < 0) continue;
      const socket = peer();
      room.AddAllUser(socket, [input.selected[slot]!]);
      room.m_rgSlotInfo[slot]![2] = input.colors[slot]!;
      socket.Clear();
    }
    const before = flags(room);
    let used = 0;
    const result = room.MakeLaunchGameStagePacket(
      input.map,
      () => input.draws[used++]!,
    );
    expect(used).toBe(input.draws.length);
    expect(maps.GetMapMaxPlayer(input.map)).toBe(input.capacity);
    expect(result.Packet.GetBuffer().toString("hex")).toBe(input.body);
    expect(result.BomberIndices).toEqual(input.bombers);
    expect(result.SpawnIndices).toEqual(input.spawns);
    expect(result.MapIndex).toBe(input.map);
    expect(room.m_bPlaying).toBe(false);
    expect(room.m_nMapIdxPlaying).toBe(-1);
    expect([...room.m_aBomberIdxPlaying]).toEqual(Array(8).fill(-1));
    expect(flags(room)).toEqual(before);
    expect(clock.GetStartGameTime()).toBe(0);
    expect(
      room.GetSockets().every((s) => (s as MemoryClient).packets.length === 0),
    ).toBe(true);
  });
test("116 builder fails atomically on invalid RNG, insufficient capacity and unported variants", () => {
  const { room } = setup();
  const socket = peer();
  room.AddAllUser(socket, [10]);
  for (const invalid of [-1, 32768, NaN, Infinity, 0.5])
    expect(() => room.MakeLaunchGameStagePacket(200, () => invalid)).toThrow();
  send(room, socket, new CSendPacket(103));
  socket.Clear();
  expect(() => room.MakeLaunchGameStagePacket(200, () => 0)).toThrow(
    "ordinary normal rooms only",
  );
  send(room, socket, new CSendPacket(102));
  const others = [peer(2), peer(2), peer(2)];
  for (const other of others) room.AddAllUser(other, [0, 0]);
  expect(() => room.MakeLaunchGameStagePacket(191, () => 0)).toThrow(
    "capacity",
  );
  expect(room.m_bPlaying).toBe(false);
  expect(room.m_nMapIdxPlaying).toBe(-1);
});
for (const input of vectors.begin)
  test(`150 is a PURE encoder, ghost timing is in seconds, map ${input.map}`, () => {
    const { room, clock } = setup();
    const packet = room.MakeBeginGamePacket(
      input.map,
      input.time,
      input.sequence,
      input.key,
    );
    expect(packet.GetBuffer().toString("hex")).toBe(input.body);
    const received = Received(packet);
    expect(received.Decode1()).toBe(150);
    expect(received.Decode4()).toBe(input.time);
    expect(received.Decode4()).toBe((input.sequence ^ input.key) >>> 0);
    expect(received.Decode4()).toBe(input.ghostStart);
    expect(received.Decode4()).toBe(input.ghostFreq);
    received.AssertEnd();
    expect(clock.GetStartGameTime()).toBe(0);
    expect(room.m_nGameState).toBe(GameStage.Loading);
    expect(room.m_bPlaying).toBe(false);
  });
test("150 encoder rejects non-DWORD input without beginning the round", () => {
  const { room } = setup();
  for (const bad of [-1, NaN, 0x100000000, 0.5, Infinity])
    for (let index = 0; index < 3; index++) {
      const fields = [0, 0, 0];
      fields[index] = bad;
      expect(() =>
        room.MakeBeginGamePacket(22, fields[0]!, fields[1]!, fields[2]!),
      ).toThrow();
    }
  expect(room.m_bPlaying).toBe(false);
});

for (const input of vectors.peers)
  test(`120 matches manual C++ and preserves native candidate indices: ${input.name}`, () => {
    const { room } = setup(input.joinTime);
    const socket = peer();
    room.AddAllUser(socket, [0]);
    expect(
      room.OnUDPPeerInfo(
        socket.m_aUser[0]!,
        new HOSTHANDLE(input.observed[0]!, input.observed[1]!),
        input.candidates.map((h) => h[0]!),
        input.candidates.map((h) => h[1]!),
      ),
    ).toBe(true);
    expect(room.HasUDPPeerInfo(0)).toBe(true);
    expect(room.GetUDPPeerHosts(0).map((h) => [h.Address, h.Port])).toEqual(
      input.hosts,
    );
    expect(socket.packets[0]!.m_pBlock.toString("hex")).toBe(input.body);
    expect(room.m_bPlaying).toBe(false);
  });
test("120 presence is occupancy, not discovered status; join DWORD is not global serial", () => {
  const { room } = setup(0x12345678);
  const a = peer(2);
  const b = peer();
  room.AddAllUser(a, [0, 0]);
  room.AddAllUser(b, [0]);
  discovered(room, a);
  const packet = a.Take(120);
  for (let slot = 0; slot < 8; slot++) {
    expect(packet.Decode1()).toBe(slot < 3 ? 1 : 0);
    if (slot >= 3) continue;
    const hosts = Array.from({ length: 3 }, () => [
      packet.Decode4(),
      packet.Decode2(),
    ]);
    expect(hosts).toEqual(
      slot < 2
        ? [
            [0x7f000001, 40000],
            [0, 0],
            [0, 0],
          ]
        : [
            [0, 0],
            [0, 0],
            [0, 0],
          ],
    );
    expect(packet.Decode4()).toBe(0x12345678);
  }
  packet.AssertEnd();
  expect(room.HasUDPPeerInfo(1)).toBe(true);
  expect(room.HasUDPPeerInfo(2)).toBe(false);
  expect(b.packets.length).toBe(1);
});
test("discovery duplicate cannot rebind endpoints or refresh the original join timestamp", () => {
  const { room, time } = setup(100);
  const socket = peer();
  room.AddAllUser(socket, [0]);
  discovered(room, socket);
  const before = room.MakeUDPPeerInfoPacket().GetBuffer();
  socket.Clear();
  time(99999);
  expect(discovered(room, socket, 40001)).toBe(false);
  expect(room.MakeUDPPeerInfoPacket().GetBuffer()).toEqual(before);
  expect(socket.packets).toEqual([]);
});
test("paired discovery validates every member and every endpoint BEFORE setting either flag", () => {
  const { room } = setup();
  const socket = peer(2);
  room.AddAllUser(socket, [0, 0]);
  const before = room.MakeUDPPeerInfoPacket().GetBuffer();
  socket.m_aUser[1]!.m_nSessionSerialNo++;
  expect(() => discovered(room, socket)).toThrow("generation");
  socket.m_aUser[1]!.m_nSessionSerialNo = room.m_ulSerialNo;
  expect(() =>
    room.OnUDPPeerInfo(
      socket.m_aUser[0]!,
      new HOSTHANDLE(1, 1),
      [1, 2],
      [1, 65536],
    ),
  ).toThrow();
  expect(room.HasUDPPeerInfo(0)).toBe(false);
  expect(room.HasUDPPeerInfo(1)).toBe(false);
  expect(room.MakeUDPPeerInfoPacket().GetBuffer()).toEqual(before);
  expect(socket.packets).toEqual([]);
});
test("native departure clears peers but preserves actual bomber until a slot is reused", () => {
  const { room, time } = setup(100);
  const a = peer();
  const b = peer();
  room.AddAllUser(a, [0]);
  room.AddAllUser(b, [0]);
  discovered(room, a);
  room.m_aBomberIdxPlaying[0] = 8;
  room.DestroyPlayer(a);
  expect(room.HasUDPPeerInfo(0)).toBe(false);
  expect(room.GetUDPPeerHosts(0)).toEqual([
    invalidHost,
    invalidHost,
    invalidHost,
  ]);
  expect(room.m_aBomberIdxPlaying[0]).toBe(8); // native DestroyPlayer does NOT reset it
  time(1234);
  const replacement = peer();
  room.AddAllUser(replacement, [0]);
  expect(replacement.m_aUser[0]!.m_nSlotIdx).toBe(0);
  expect(room.m_aBomberIdxPlaying[0]).toBe(-1); // AddUser resets this field
  expect(room.HasUDPPeerInfo(0)).toBe(false);
  const packet = Received(room.MakeUDPPeerInfoPacket());
  expect(packet.Decode1()).toBe(120);
  expect(packet.Decode1()).toBe(1);
  packet.DecodeBuffer(18);
  expect(packet.Decode4()).toBe(1234);
});

test("TCP 109 validates actual random-only bombers, NOT the waiting-room random sentinel", () => {
  const { room } = setup();
  const socket = peer(2);
  room.AddAllUser(socket, [10, 10]);
  loading(room, [8, 9]);
  const request = ready(room, socket);
  expect(request.GetBuffer().toString("hex")).toBe(vectors.udp.tcpReadyBody);
  const before = flags(room);
  send(room, socket, request);
  for (let slot = 0; slot < 2; slot++) {
    expect(room.m_rgSlotInfo[slot]![0]! & SlotStateMask.Status).toBe(
      SlotStateMask.ReadyForStart,
    );
    expect(room.m_rgSlotInfo[slot]![0]! & ~SlotStateMask.Status).toBe(
      before[slot]! & ~SlotStateMask.Status,
    );
    expect(room.m_rgSlotInfo[slot]![1]! & SlotStateMask.Bomber).toBe(10);
  }
  expect(room.IsAllPlayerReadyForStart()).toBe(false);
  expect(socket.packets).toEqual([]);
});
test("109 CRC/bomber/count/power/speed mismatch and every truncation leave BOTH local-player flags untouched", () => {
  const { room } = setup();
  const socket = peer(2);
  room.AddAllUser(socket, [10, 10]);
  loading(room, [8, 9]);
  const before = flags(room);
  const valid = ready(room, socket).GetBuffer();
  for (let length = 1; length < valid.length; length++) {
    expect(() =>
      room.OnPacket(
        new CReceivedPacketBase(valid.subarray(0, length), CipherDegree.CRC8),
        socket,
      ),
    ).toThrow();
    expect(flags(room)).toEqual(before);
  }
  for (const offset of [1, 5, 6, 7, 8, 9, 10, 11, 12]) {
    const bad = Buffer.from(valid);
    bad[offset]! ^= 1;
    expect(() =>
      room.OnPacket(new CReceivedPacketBase(bad, CipherDegree.CRC8), socket),
    ).toThrow();
    expect(flags(room)).toEqual(before);
  }
  expect(() =>
    room.OnPacket(
      new CReceivedPacketBase(
        Buffer.concat([valid, Buffer.from([0])]),
        CipherDegree.CRC8,
      ),
      socket,
    ),
  ).toThrow();
  expect(flags(room)).toEqual(before);
  expect(socket.packets).toEqual([]);
});
test("109 has no effect outside loading, and cannot invent an absent selected-map context", () => {
  const { room } = setup();
  const socket = peer();
  room.AddAllUser(socket, [0]);
  const before = flags(room);
  send(room, socket, new CSendPacket(109));
  loading(room, [0]);
  room.m_nGameState = GameStage.Running;
  send(room, socket, new CSendPacket(109));
  room.m_nGameState = GameStage.Result;
  send(room, socket, new CSendPacket(109));
  room.m_nGameState = GameStage.Loading;
  room.m_nMapIdxPlaying = -1;
  expect(() => send(room, socket, new CSendPacket(109))).toThrow(
    "loading context",
  );
  expect(flags(room)).toEqual(before);
});
for (const order of ["UDP-first", "TCP-first"])
  test(`both handshake orders converge on the gated ready state, never send 150: ${order}`, () => {
    const { room } = setup();
    const a = peer(2);
    const b = peer();
    room.AddAllUser(a, [10, 10]);
    room.AddAllUser(b, [0]);
    loading(room, [8, 9, 0]);
    if (order === "UDP-first") {
      discovered(room, a);
      discovered(room, b, 40001);
      send(room, a, ready(room, a));
      expect(() => send(room, b, ready(room, b))).toThrow("DoStartGame");
    } else {
      send(room, a, ready(room, a));
      send(room, b, ready(room, b));
      discovered(room, a);
      expect(() => discovered(room, b, 40001)).toThrow("DoStartGame");
    }
    expect(room.IsAllPlayerReadyForStart()).toBe(true);
    expect(room.m_nGameState).toBe(GameStage.Loading);
    expect(room.GetGameClock().GetStartGameTime()).toBe(0);
    expect(
      [...a.packets, ...b.packets].every((p) => p.m_nPacketType === 120),
    ).toBe(true);
  });
test("empty and combined-ready-bit rooms cannot satisfy native start readiness", () => {
  const { room } = setup();
  expect(room.IsAllPlayerReadyForStart()).toBe(false);
  const a = peer();
  room.AddAllUser(a, [0]);
  discovered(room, a);
  room.m_rgSlotInfo[0]![0] = SlotStateMask.ReadyForStart | SlotStateMask.Ready;
  expect(room.IsAllPlayerReadyForStart()).toBe(false);
  room.m_rgSlotInfo[0]![0] = SlotStateMask.ReadyForStart;
  expect(room.IsAllPlayerReadyForStart()).toBe(true);
});
test("loading peer timeout uses original JOIN time, unsigned rollover and strict >25000, with paired sockets deduplicated", () => {
  for (const input of vectors.deadlines.filter((v) => v.limit === 25000)) {
    const { room, time } = setup(input.first);
    const a = peer(2);
    const b = peer();
    room.AddAllUser(a, [0, 0]);
    room.AddAllUser(b, [0]);
    discovered(room, b);
    loading(room, [0, 0, 0]);
    time(input.now);
    expect(room.GetExpiredUDPPeerSockets()).toEqual(input.expired ? [a] : []);
    expect(room.GetCurPlayer()).toBe(3); // pure extraction, not live ejection
    room.m_nGameState = GameStage.Running;
    expect(room.GetExpiredUDPPeerSockets()).toEqual([]);
  }
});

test("raw GS UDP 11 and legacy-ready framing match manual C++, not TCP/Relay headers", () => {
  for (const [payload, framed] of [
    [vectors.udp.peerBody, vectors.udp.peerDatagram],
    [vectors.udp.legacyReadyBody, vectors.udp.legacyReadyDatagram],
  ]) {
    const body = Buffer.from(payload!, "hex");
    const frame = Buffer.from(framed!, "hex");
    expect(EncodeUnregisteredDatagram(body)).toEqual(frame);
    expect(DecodeUnreliableDatagram(frame)).toEqual([body]);
  }
  const first = Buffer.from(vectors.udp.peerDatagram, "hex");
  expect(DecodeUnreliableDatagram(Buffer.concat([first, first]))).toHaveLength(
    2,
  );
  for (const bad of [
    Buffer.alloc(0),
    Buffer.from([0, 0]),
    first.subarray(0, -1),
    Buffer.concat([first, Buffer.from([1])]),
    Buffer.alloc(4097),
  ])
    expect(() => DecodeUnreliableDatagram(bad)).toThrow();
  const corrupt = Buffer.from(first);
  corrupt[3]! ^= 1;
  expect(() => DecodeUnreliableDatagram(corrupt)).toThrow("CRC");
  expect(() => EncodeUnregisteredDatagram(Buffer.alloc(255))).toThrow(
    "too long",
  );
  expect(
    DecodeUnreliableDatagram(EncodeUnregisteredDatagram(Buffer.alloc(0))),
  ).toEqual([Buffer.alloc(0)]);
});
test("UDP 11 binds the current room generation and TCP IP; 35-byte UDP type 1 is the native NO-OP", () => {
  const { room } = setup();
  const socket = peer(2, "127.0.0.1", 0x11223344);
  room.AddAllUser(socket, [10, 10]);
  const dispatcher = new CUDPPacketDispatcher(table(room), (id) =>
    socket.m_aUser.find((u) => u.m_nGlobalSerialNo === id),
  );
  const observed = new HOSTHANDLE(0x7f000001, 45000);
  const legacy = Buffer.from(vectors.udp.legacyReadyBody, "hex");
  loading(room, [8, 9]);
  expect(dispatcher.OnUDPPacket(legacy, observed)).toBe(false);
  expect(room.HasUDPPeerInfo(0)).toBe(false);
  expect(room.m_rgSlotInfo[0]![0]! & SlotStateMask.Status).toBe(0);
  room.m_bPlaying = false;
  const valid = Buffer.from(vectors.udp.peerBody, "hex");
  expect(dispatcher.OnUDPPacket(valid, new HOSTHANDLE(0x7f000002, 45000))).toBe(
    false,
  );
  const stale = Buffer.from(valid);
  stale.writeUInt32BE(room.m_ulSerialNo + 1, 7);
  expect(dispatcher.OnUDPPacket(stale, observed)).toBe(false);
  const illegalIndex = Buffer.from(valid);
  illegalIndex.writeUInt16BE(255, 5);
  expect(dispatcher.OnUDPPacket(illegalIndex, observed)).toBe(false);
  expect(socket.IsConnected()).toBe(true);
  expect(room.HasUDPPeerInfo(0)).toBe(false);
  expect(dispatcher.OnUDPPacket(valid, observed)).toBe(true);
  expect(room.HasUDPPeerInfo(0)).toBe(true);
  expect(room.HasUDPPeerInfo(1)).toBe(true);
  expect(room.GetUDPPeerHosts(0)[1]).toEqual(new HOSTHANDLE(0x0a010203, 4321));
  expect(dispatcher.OnUDPPacket(valid, observed)).toBe(false);
  expect(socket.packets).toHaveLength(1);
  expect(socket.packets[0]!.m_nPacketType).toBe(120);
  expect(room.m_bPlaying).toBe(false);
});
test("UDP dispatcher rejects length/type mismatches, detached users, and a partially moved local pair atomically", () => {
  const { room } = setup();
  const socket = peer(2, "127.0.0.1", 0x11223344);
  room.AddAllUser(socket, [0, 0]);
  const dispatcher = new CUDPPacketDispatcher(
    table(room),
    () => socket.m_aUser[0],
  );
  const observed = new HOSTHANDLE(0x7f000001, 45000);
  const valid = Buffer.from(vectors.udp.peerBody, "hex");
  for (const bad of [
    valid.subarray(0, -1),
    Buffer.concat([valid, Buffer.from([0])]),
    Buffer.from([1, ...valid.subarray(1)]),
    Buffer.alloc(35, 11),
  ])
    expect(dispatcher.OnUDPPacket(bad, observed)).toBe(false);
  socket.m_aUser[1]!.m_nSessionIdx++;
  expect(dispatcher.OnUDPPacket(valid, observed)).toBe(false);
  expect(room.HasUDPPeerInfo(0)).toBe(false);
  expect(room.HasUDPPeerInfo(1)).toBe(false);
  expect(socket.packets).toEqual([]);
});
test("185 and 186 decode ONE target, send TCP 54 to that target, and use reporter's primary room slot", () => {
  const { room } = setup();
  const a = peer(2);
  const b = peer();
  room.AddAllUser(a, [0, 0]);
  room.AddAllUser(b, [0]);
  for (const opcode of [185, 186]) {
    send(room, b, new CSendPacket(opcode).Encode1(1));
    const response = a.Take(54);
    expect(response.Decode1()).toBe(2); // B's self-index is zero, room slot is TWO
    response.AssertEnd();
    expect(response.m_pBlock.toString("hex")).toBe("6c58");
    expect(b.packets).toEqual([]);
    send(room, a, new CSendPacket(opcode).Encode1(2));
    expect(b.Take(54).Decode1()).toBe(0);
  }
  room.m_aPlayerState[2] = 1;
  send(room, b, new CSendPacket(186).Encode1(0));
  expect(a.packets).toEqual([]);
  send(room, b, new CSendPacket(185).Encode1(0));
  expect(a.Take(54).Decode1()).toBe(2);
  room.m_aPlayerState[2] = 3; // native Update has this NON-BOOLEAN state
  send(room, b, new CSendPacket(186).Encode1(0));
  expect(a.Take(54).Decode1()).toBe(2); // rejects exactly 1, not any nonzero
  expect(() => send(room, b, new CSendPacket(186))).toThrow();
  expect(() => send(room, b, new CSendPacket(186).Encode1(8))).toThrow();
  a.m_aUser[1]!.SetFree(); // native CUser+20 guard applies to TARGET, not selfidx
  for (const opcode of [185, 186]) {
    send(room, b, new CSendPacket(opcode).Encode1(1));
    expect(a.packets).toEqual([]);
  }
});
test("HOSTHANDLE is frozen, compares both words, and uses host-order IPv4 (not raw inet_addr)", () => {
  const host = HOSTHANDLE.FromAddress("203.0.113.9", 0x1234);
  expect(host.Address).toBe(0xcb007109);
  expect(host.Port).toBe(0x1234);
  expect(host.Equals(new HOSTHANDLE(0xcb007109, 0x1234))).toBe(true);
  expect(host.Equals(new HOSTHANDLE(0xcb007109, 0x3412))).toBe(false);
  expect(Object.isFrozen(host)).toBe(true);
  for (const [ip, port] of [
    [-1, 1],
    [0x100000000, 1],
    [1, -1],
    [1, 65536],
    [NaN, 1],
    [1, 0.5],
  ])
    expect(() => new HOSTHANDLE(ip!, port!)).toThrow();
});

test("actual PE bytes confirm the empty UDP-ready overload, empty normal launch extension, and native 15-bit CRT rand", () => {
  const pe = new CPeImage("FXGS/FxServer.exe");
  expect(pe.read(0x0041b506, 3).toString("hex")).toBe("c21800");
  expect(pe.read(0x004209b9, 1).toString("hex")).toBe("c3");
  // shr eax,16; and eax,0x7fff; ret. Read only, never execute the supplied PE.
  expect(pe.read(0x0046ea5f + 25, 9).toString("hex")).toBe(
    "c1e81025ff7f0000c3",
  );
});
