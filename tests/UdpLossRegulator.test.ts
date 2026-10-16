import { afterEach, expect, test } from "bun:test";
import vectors from "./fixtures/session-vectors.json";
import { CUdpLossRegulator } from "../FXGS/CUdpLossRegulator.ts";
import { CGameSession } from "../FXGS/CGameSession.ts";
import { CBomberAttr } from "../FXGS/CBomberAttr.ts";
import { CGameMapTmplList } from "../FXGS/CGameMapTmplList.ts";
import { CGameClock } from "../FXGS/CGameClock.ts";
import { CUser } from "../Common/CUser.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CTextCodec } from "../Common/CTextCodec.ts";
import { GameStage } from "../Common/OfficialValues.ts";
import { MemoryClient, Received } from "./helpers/Clients.ts";
import { UserInfo } from "./helpers/Accounts.ts";

let serial = 0;
const sockets: MemoryClient[] = [];
function graph() {
  const players: (CUser | undefined)[] = Array.from({ length: 8 });
  function add(...slots: number[]) {
    const socket = new MemoryClient();
    sockets.push(socket);
    for (const slot of slots) {
      const user = new CUser(UserInfo(`U${++serial}`), serial);
      user.m_nSlotIdx = slot;
      user.m_pClientSocket = socket;
      socket.m_aUser.push(user);
      players[slot] = user;
    }
    return socket;
  }
  return { players, add };
}
function loss(
  regulator: CUdpLossRegulator,
  socket: MemoryClient,
  target: number,
  players: readonly (CUser | undefined)[],
) {
  const packet = Received(new CSendPacket(187).Encode1(target));
  packet.Decode1();
  regulator.OnNotifyUdpLoss(packet, socket, players);
}
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.Close();
});

test("all 512 directed three-primary graphs, including diagonal/tie cases, match the manual native C++ reference", () => {
  const { players, add } = graph();
  add(0);
  add(2);
  add(7);
  const regulator = new CUdpLossRegulator(() => 100);
  const slots = [0, 2, 7];
  const before = players.slice();
  for (const input of vectors.graphs) {
    regulator.Init();
    for (let bit = 0; bit < 9; bit++)
      if ((input.mask >> bit) & 1)
        loss(
          regulator,
          players[slots[Math.floor(bit / 3)]!]!.m_pClientSocket as MemoryClient,
          slots[bit % 3]!,
          players,
        );
    const matrix = regulator.GetLossMatrix(),
      pending = regulator.m_bPending,
      first = regulator.m_dwFirstLossTime;
    expect(
      regulator
        .GetRegulationCandidates(players)
        .map((s) => s.m_aUser[0]!.m_nSlotIdx),
    ).toEqual(input.eject);
    expect(regulator.GetLossMatrix()).toEqual(matrix);
    expect(regulator.m_bPending).toBe(pending);
    expect(regulator.m_dwFirstLossTime).toBe(first);
    const result = regulator.RegulateConnection(players);
    expect(result.map((s) => s.m_aUser[0]!.m_nSlotIdx)).toEqual(input.eject);
    expect(regulator.m_bPending).toBe(false);
    expect(regulator.m_dwFirstLossTime).toBe(0);
    expect([...regulator.GetLossMatrix()]).toEqual(Array(64).fill(0));
    expect(players).toEqual(before); // graph kernel never applies room ejections
  }
});
test("duplicate reports are booleans; first report anchors the batch, not the most recent report", () => {
  const { players, add } = graph();
  const a = add(0, 1);
  const b = add(2);
  let now = 100;
  let reads = 0;
  const regulator = new CUdpLossRegulator(() => (reads++, now));
  loss(regulator, a, 2, players);
  now = 7000;
  loss(regulator, a, 2, players);
  const matrix = regulator.GetLossMatrix();
  expect(matrix[2]).toBe(1);
  expect(matrix[8 + 2]).toBe(1);
  expect([...matrix].reduce((a, b) => a + b)).toBe(2);
  expect(regulator.m_dwFirstLossTime).toBe(100);
  expect(reads).toBe(1);
  matrix.fill(999); // getters must not leak mutable internal storage
  expect(regulator.GetLossMatrix()[2]).toBe(1);
  now = 8100;
  expect(regulator.DeferRegulateConnection(players)).toEqual([]);
  expect(regulator.m_bPending).toBe(true);
  now = 8101;
  expect(regulator.DeferRegulateConnection(players)).toEqual([b]);
  expect(regulator.m_bPending).toBe(false);
  expect(players[2]!.m_pClientSocket).toBe(b);
});
test("8s batch deadline is unsigned, strict >, and timestamp zero does NOT mean no pending batch", () => {
  for (const input of vectors.deadlines.filter((v) => v.limit === 8000)) {
    const { players, add } = graph();
    const a = add(0);
    const b = add(7);
    let now = input.first;
    const regulator = new CUdpLossRegulator(() => now);
    loss(regulator, a, 7, players);
    now = input.now;
    expect(regulator.DeferRegulateConnection(players)).toEqual(
      input.expired ? [b] : [],
    );
    expect(regulator.m_bPending).toBe(!input.expired);
  }
});
test("only primary socket users participate; reporting to a second local slot does not create a primary graph edge", () => {
  const { players, add } = graph();
  const a = add(0, 3);
  const b = add(2);
  const regulator = new CUdpLossRegulator();
  loss(regulator, b, 3, players);
  expect(regulator.RegulateConnection(players)).toEqual([]);
  loss(regulator, a, 2, players);
  loss(regulator, b, 3, players);
  // One outgoing claim from A, no eligible outgoing claim from B. Native
  // chooses B, not a fictitious majority/quorum. This is NOT proof B is faulty.
  expect(regulator.RegulateConnection(players)).toEqual([b]);
});
test("symmetric degree/outgoing ties choose lowest primary slot and remove the whole socket from consideration", () => {
  const { players, add } = graph();
  const a = add(0, 1);
  const b = add(2);
  const c = add(7);
  const regulator = new CUdpLossRegulator();
  loss(regulator, a, 2, players);
  loss(regulator, b, 0, players);
  loss(regulator, c, 1, players); // secondary local slot is ineligible
  expect(regulator.RegulateConnection(players)).toEqual([a]);
  expect(a.m_aUser[1]!.GetSelfidx()).toBe(1);
  expect(players.filter(Boolean)).toHaveLength(4);
});
test("self-report contributes degree two, not one, and is not silently discarded", () => {
  const { players, add } = graph();
  const a = add(0);
  const b = add(2);
  const regulator = new CUdpLossRegulator();
  loss(regulator, a, 0, players);
  loss(regulator, b, 0, players);
  expect(regulator.RegulateConnection(players)).toEqual([a]);
});
test("malformed, trailing, empty-target and detached/partially moved group reports do not set pending or read the clock", () => {
  const { players, add } = graph();
  const a = add(0, 1);
  add(2);
  let reads = 0;
  const regulator = new CUdpLossRegulator(() => ++reads);
  const badPackets = [
    new CSendPacket(187),
    new CSendPacket(187).Encode1(2).Encode1(0),
  ];
  for (const request of badPackets) {
    const packet = Received(request);
    packet.Decode1();
    expect(() => regulator.OnNotifyUdpLoss(packet, a, players)).toThrow();
  }
  expect(() => loss(regulator, a, 7, players)).toThrow("occupied");
  expect(() => loss(regulator, a, 8, players)).toThrow("occupied");
  players[1] = undefined;
  expect(() => loss(regulator, a, 2, players)).toThrow("reporter");
  expect(() => loss(regulator, a, 2, players.slice(0, 7))).toThrow("eight");
  expect(() => regulator.RegulateConnection(players.slice(0, 7))).toThrow(
    "eight",
  );
  expect(regulator.m_bPending).toBe(false);
  expect(regulator.m_dwFirstLossTime).toBe(0);
  expect(reads).toBe(0);
  expect([...regulator.GetLossMatrix()]).toEqual(Array(64).fill(0));
});
test("187 routes only in Running; graph reports cannot start games or eject sockets by themselves", () => {
  let now = 100;
  const room = new CGameSession(
    0,
    42,
    "UDP kernel",
    "",
    0,
    new CTextCodec(),
    new CBomberAttr(),
    new CGameMapTmplList(),
    0,
    new CGameClock(() => now),
  );
  const { add } = graph();
  const a = add(0, 1);
  const b = add(2);
  room.AddAllUser(a, [0, 0]);
  room.AddAllUser(b, [0]);
  const request = () =>
    room.OnPacket(Received(new CSendPacket(187).Encode1(2)), a);
  expect(request).toThrow("outside a running game");
  room.m_bPlaying = true;
  expect(request).toThrow("outside a running game");
  room.m_nGameState = GameStage.Running;
  request();
  now = 8101;
  expect(
    room.m_udpLossRegulator.DeferRegulateConnection(room.m_rgPlayer),
  ).toEqual([b]);
  expect(room.GetCurPlayer()).toBe(3);
  expect(b.IsConnected()).toBe(true);
  expect(a.packets).toEqual([]);
  expect(b.packets).toEqual([]);
});
