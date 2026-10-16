import { afterEach, expect, test } from "bun:test";
import { CFastFile } from "../Common/CFastFile.ts";
import { CTextCodec } from "../Common/CTextCodec.ts";
import { CUser } from "../Common/CUser.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CBomberAttr } from "../FXGS/CBomberAttr.ts";
import { CGameMapTmplList } from "../FXGS/CGameMapTmplList.ts";
import { CGameSession } from "../FXGS/CGameSession.ts";
import { CGameSessionTable } from "../FXGS/CGameSessionTable.ts";
import {
  ChannelType,
  SessionLimit,
  SlotStateMask,
  StartGameResult,
} from "../Common/OfficialValues.ts";
import { CUnsupportedOperation } from "../Common/CProtocolError.ts";
import { MemoryClient, Received } from "./helpers/Clients.ts";
import { UserInfo } from "./helpers/Accounts.ts";
const files = new CFastFile();
files.FastFileInit("FXGS/FxServer");
const bombers = new CBomberAttr();
bombers.Load(files);
const maps = new CGameMapTmplList();
maps.CreateTmplList(files);
const text = new CTextCodec();
const sockets: MemoryClient[] = [];
let sn = 0;
function peer(...ids: string[]) {
  const socket = new MemoryClient();
  sockets.push(socket);
  socket.m_aUser.push(
    ...ids.map((ID) => {
      const u = new CUser(UserInfo(ID), ++sn);
      u.m_pClientSocket = socket;
      return u;
    }),
  );
  return socket;
}
function room(manner = 0, channelType: number = ChannelType.Normal) {
  return new CGameSession(
    0,
    10,
    "Room",
    "",
    manner,
    text,
    bombers,
    maps,
    channelType,
  );
}
function add(room: CGameSession, ...ids: string[]) {
  const s = peer(...ids);
  room.AddAllUser(
    s,
    ids.map(() => 10),
  );
  return s;
}
function request(room: CGameSession, socket: MemoryClient, p: CSendPacket) {
  room.OnPacket(Received(p), socket);
}
const colors = (r: CGameSession) =>
  r.m_rgPlayer.flatMap((u, i) =>
    u ? [r.m_rgSlotInfo[i]![2]! & SlotStateMask.Color] : [],
  );
afterEach(() => {
  for (const s of sockets.splice(0)) s.Close();
});

test("newcomers balance existing teams, and a local two-player group starts on the same team", () => {
  const r = room();
  const a = add(r, "A", "Partner");
  expect(colors(r)).toEqual([0, 0]);
  add(r, "B");
  expect(colors(r)).toEqual([0, 0, 2]);
  add(r, "C");
  expect(colors(r)).toEqual([0, 0, 2, 2]);
  expect(
    a.m_aUser.every(
      (u) => u.m_nSessionIdx === 0 && u.m_nSessionSerialNo === 10,
    ),
  ).toBe(true);
  expect(r.m_nChiefSlotidx).toBe(0);
});
test("limited-team map keeps existing valid palette colors and preserves equal-color teams", () => {
  const r = room();
  const chief = add(r, "A");
  add(r, "B");
  add(r, "C");
  add(r, "D");
  for (const [i, color] of [7, 7, 3, 1].entries())
    r.m_rgSlotInfo[i]![2] = 0x80 | color;
  request(r, chief, new CSendPacket(97).Encode2(0)); // Bula00, four teams
  expect(colors(r)).toEqual([5, 5, 3, 0]);
  expect(r.m_rgSlotInfo.slice(0, 4).every((s) => (s[2]! & 0x80) !== 0)).toBe(
    true,
  );
  const map = chief.Take(112);
  expect(map.Decode2()).toBe(0);
  map.AssertEnd();
  for (let i = 0; i < 4; i++) {
    const p = chief.Take(107);
    expect(p.Decode1()).toBe(i);
    expect(p.DecodeBuffer(3)).toEqual(r.m_rgSlotInfo[i]!);
    p.AssertEnd();
  }
  expect(chief.packets.length).toBe(0);
});
test("too many teams are redistributed per occupied slot, not per previous color", () => {
  const r = room();
  const chief = add(r, "A");
  for (const ID of ["B", "C", "D", "E"]) add(r, ID);
  for (let i = 0; i < 5; i++) r.m_rgSlotInfo[i]![2] = i;
  r.m_rgSlotInfo[2]![0] = SlotStateMask.Ready;
  request(r, chief, new CSendPacket(97).Encode2(0));
  expect(colors(r)).toEqual([0, 3, 5, 6, 0]);
  expect(r.m_rgSlotInfo[0]![0]! & SlotStateMask.Chief).toBe(2);
  expect(r.m_rgSlotInfo[2]![0]! & SlotStateMask.Status).toBe(4);
  chief.Clear();
  request(r, chief, new CSendPacket(97).Encode2(0xfffe));
  expect(r.m_nMapIdx).toBe(-2);
  expect(colors(r)).toEqual([0, 3, 5, 6, 0]);
});
test("three-team, random-map and invalid theme selection have explicit bounds", () => {
  const r = room();
  const chief = add(r, "A");
  add(r, "B");
  add(r, "C");
  add(r, "D");
  for (const [i, color] of [6, 6, 5, 0].entries())
    r.m_rgSlotInfo[i]![2] = color;
  const index = maps.m_aMapTmpl.findIndex((m) => m.m_nMaxTeam === 3);
  expect(index).toBeGreaterThanOrEqual(0);
  request(r, chief, new CSendPacket(97).Encode2(index));
  expect(colors(r)).toEqual([3, 3, 5, 0]);
  chief.Clear();
  request(r, chief, new CSendPacket(97).Encode2(0xffff));
  expect(colors(r)).toEqual([3, 3, 5, 0]);
  expect(chief.packets.length).toBe(5);
  expect(() =>
    request(r, chief, new CSendPacket(97).Encode2(0x8000)),
  ).toThrow();
  expect(r.m_nMapIdx).toBe(-1);
});
test("ready updates the entire nonchief group; duplicate/desynced requests do not disconnect or invent snapshots", () => {
  const r = room();
  const chief = add(r, "A");
  const pair = add(r, "B", "C");
  request(r, pair, new CSendPacket(96).Encode1(1));
  expect(
    r.m_rgSlotInfo
      .slice(1, 3)
      .every((s) => (s[0]! & SlotStateMask.Status) === SlotStateMask.Ready),
  ).toBe(true);
  expect(pair.packets.length).toBe(2);
  pair.Clear();
  chief.Clear();
  request(r, pair, new CSendPacket(96).Encode1(1));
  expect(pair.packets.length).toBe(0);
  expect(chief.packets.length).toBe(0);
  expect(pair.IsConnected()).toBe(true);
  request(r, chief, new CSendPacket(96).Encode1(1));
  expect(r.m_rgSlotInfo[0]![0]! & SlotStateMask.Status).toBe(0);
  r.m_rgSlotInfo[2]![0] = 0;
  request(r, pair, new CSendPacket(96).Encode1(0));
  expect(r.m_rgSlotInfo[1]![0]! & SlotStateMask.Status).toBe(
    SlotStateMask.Ready,
  );
  expect(pair.packets.length).toBe(0); // modern group-atomic validation
  expect(() => request(r, pair, new CSendPacket(96).Encode1(2))).toThrow();
});
test("packed self-index maps to room slot; selections and slot closing cannot target another player's index", () => {
  const r = room();
  const chief = add(r, "A");
  const pair = add(r, "B", "C");
  request(r, pair, new CSendPacket(98).Encode1(0x13));
  expect(colors(r)[2]).toBe(3);
  expect(pair.Take(108).Decode1()).toBe(0x23);
  request(r, pair, new CSendPacket(99).Encode1(0x1a));
  expect(r.m_rgSlotInfo[2]![1]! & SlotStateMask.Bomber).toBe(10);
  expect(pair.Take(109).Decode1()).toBe(0x2a);
  expect(() => request(r, pair, new CSendPacket(98).Encode1(0x20))).toThrow();
  expect(() => request(r, pair, new CSendPacket(98).Encode1(0x08))).toThrow();
  expect(() => request(r, pair, new CSendPacket(99).Encode1(8))).toThrow();
  expect(() => request(r, pair, new CSendPacket(100).Encode1(0x71))).toThrow();
  chief.Clear();
  r.m_nModified = 0;
  request(r, chief, new CSendPacket(100).Encode1(0x7f));
  expect(chief.Take(110).Decode1()).toBe(0x71);
  expect(r.m_nMaxPlayer).toBe(7);
  r.MakeModifiedPacket();
  request(r, chief, new CSendPacket(100).Encode1(0x71));
  expect(r.m_nModified).toBe(0);
  request(r, chief, new CSendPacket(100).Encode1(0x01));
  expect(r.m_rgSlotInfo[0]![0]! & SlotStateMask.Closed).toBe(0);
  expect(r.m_nMaxPlayer).toBe(7);
});
test("game type normal/mod is distinct from Manner and is sent correctly to late joiners", () => {
  const r = room(1);
  const chief = add(r, "A");
  request(r, chief, new CSendPacket(103));
  expect(chief.Take(92).remaining).toBe(0);
  const other = add(r, "B");
  r.SendGameType(other);
  expect(other.Take(92).remaining).toBe(0);
  const simple = r.MakeSimpleInfoPacket();
  const p = Received(simple);
  p.Decode1();
  p.Decode2();
  p.Decode4();
  p.DecodeStr();
  p.Decode1();
  expect(p.Decode1()).toBe(1);
  request(r, chief, new CSendPacket(102));
  expect(chief.Take(93).remaining).toBe(0);
  expect(() => request(r, other, new CSendPacket(103))).toThrow();
});
test("chief leaves: first occupied slot succeeds, not the highest level; both local players lose ready status", () => {
  const r = room();
  const chief = add(r, "A");
  const next = add(r, "B", "C");
  const high = add(r, "D");
  high.m_aUser[0]!.m_userInfo.Exp = 1_000_000_000;
  high.m_aUser[0]!.SetLevel(); // native cached-level refresh after trusted setup
  request(r, next, new CSendPacket(96).Encode1(1));
  const sessions = new CGameSessionTable(
    text,
    bombers,
    maps,
    ChannelType.Normal,
    () => {},
  );
  sessions.m_rgGameSession.set(r.m_nIdx, r);
  sessions.DestroyPlayer(chief);
  expect(r.m_nChiefSlotidx).toBe(1);
  expect(r.IsChief(next)).toBe(true);
  expect(r.IsChief(high)).toBe(false);
  expect(
    r.m_rgSlotInfo
      .slice(1, 3)
      .every((s) => (s[0]! & SlotStateMask.Status) === 0),
  ).toBe(true);
  expect(chief.m_aUser[0]!.m_nSessionIdx).toBe(SessionLimit.NoSession);
});
test("start validation errors are original values; a valid waiting room still cannot fake a battle start", () => {
  const r = room();
  const chief = add(r, "A");
  expect(r.CanStartGame()).toBe(StartGameResult.NotEnoughPlayers);
  const other = add(r, "B");
  expect(r.CanStartGame()).toBe(StartGameResult.NotReady);
  request(r, other, new CSendPacket(96).Encode1(1));
  expect(r.CanStartGame()).toBe(StartGameResult.Valid);
  chief.Clear();
  expect(() => request(r, chief, new CSendPacket(106))).toThrow(
    CUnsupportedOperation,
  );
  expect(chief.packets.length).toBe(0);
  expect(r.m_bPlaying).toBe(false);
  r.m_nMapIdx = 0;
  expect(r.CanStartGame()).toBe(StartGameResult.PremiumMap);
  chief.m_aUser[0]!.m_nAuthencode = 1;
  // Bula00's real level limit is +52 = 1, not the unrelated +36 = 2.
  expect(r.CanStartGame()).toBe(StartGameResult.Valid);
  r.m_nMapIdx = 12; // Bula12: +52 = 15.
  expect(r.CanStartGame()).toBe(StartGameResult.LevelLimit);
  chief.m_aUser[0]!.m_userInfo.Exp = 1_000_000_000;
  chief.m_aUser[0]!.SetLevel();
  expect(r.CanStartGame()).toBe(StartGameResult.Valid);
});
test("room index recycling changes serial; stale serials, wrong passwords and group overflow are rejected atomically", () => {
  const table = new CGameSessionTable(
    text,
    bombers,
    maps,
    ChannelType.Normal,
    () => {},
  );
  const chief = peer("A");
  const create = (s: MemoryClient) =>
    table.OnPacket(
      Received(
        new CSendPacket(80)
          .EncodeStr("Room")
          .EncodeStr("pass")
          .Encode1(0)
          .Encode1(1)
          .Encode1(10),
      ),
      s,
    );
  create(chief);
  const original = table.GetSession(chief)!;
  const oldSerial = original.m_ulSerialNo;
  table.DestroyPlayer(chief);
  expect(table.m_rgGameSession.size).toBe(0);
  create(chief);
  const current = table.GetSession(chief)!;
  expect(current.m_nIdx).toBe(original.m_nIdx);
  expect(current.m_ulSerialNo).not.toBe(oldSerial);
  const other = peer("B", "C");
  table.DoJoinSession(other, current.m_nIdx, oldSerial, "pass", [10, 10]);
  expect(other.Take(81).Decode1()).toBe(2);
  table.DoJoinSession(
    other,
    current.m_nIdx,
    current.m_ulSerialNo,
    "wrong",
    [10, 10],
  );
  expect(other.Take(81).Decode1()).toBe(1);
  for (let i = 2; i < 8; i++)
    request(current, chief, new CSendPacket(100).Encode1((i << 4) | 1));
  table.DoJoinSession(
    other,
    current.m_nIdx,
    current.m_ulSerialNo,
    "pass",
    [10, 10],
  );
  expect(other.Take(81).Decode1()).toBe(2);
  expect(
    other.m_aUser.every((u) => u.m_nSessionIdx === SessionLimit.NoSession),
  ).toBe(true);
  expect(current.GetCurPlayer()).toBe(1);
});

test("team chat uses response 27, excludes sender/opponents, rejects two-local-player sending without disconnect", () => {
  const r = room();
  const chief = add(r, "A");
  const pair = add(r, "B", "C");
  const enemy = add(r, "D");
  r.m_rgSlotInfo[0]![2] = 0;
  r.m_rgSlotInfo[1]![2] = 0;
  r.m_rgSlotInfo[2]![2] = 0;
  r.m_rgSlotInfo[3]![2] = 1;
  request(r, chief, new CSendPacket(111).EncodeStr("team-only"));
  expect(chief.packets.length).toBe(0);
  expect(enemy.packets.length).toBe(0);
  for (let i = 0; i < 2; i++) {
    const p = pair.Take(27);
    expect(p.DecodeStr()).toBe("A : team-only");
    p.AssertEnd();
  }
  request(r, pair, new CSendPacket(111).EncodeStr("not allowed"));
  expect(pair.packets.length).toBe(0);
  expect(chief.packets.length).toBe(0);
  expect(pair.IsConnected()).toBe(true);
});

test("105 carries low-byte CommunitySvr, distinct from Gender, DB serial and global serial", () => {
  const r = room();
  const socket = add(r, "A");
  const user = socket.m_aUser[0]!;
  user.m_userInfo.Gender = 0x7b;
  user.m_userInfo.SID = 0x55667788;
  for (const [community, signed] of [
    [0x1234, 4660],
    [0xff9a, -102],
  ]) {
    user.m_userInfo.CommunitySvr = community!;
    expect(user.GetCommunitySvr()).toBe(signed!);
    const p = Received(r.MakeSetPlayerPacket(0, true));
    expect(p.Decode1()).toBe(105);
    expect(p.Decode1()).toBe(0);
    expect(p.Decode4()).toBe(user.m_nGlobalSerialNo);
    expect(p.Decode1()).toBe(1);
    expect(p.Decode1()).toBe(community! & 0xff);
    expect(p.Decode1()).toBe(255);
    expect(p.DecodeBuffer(3)).toEqual(r.m_rgSlotInfo[0]!);
    expect(p.DecodeStr()).toBe("A");
    expect(p.Decode1()).toBe(0x7b);
    expect(p.Decode2()).toBe(user.GetLevel());
    expect(p.Decode4()).toBe(0);
    expect(p.Decode4()).toBe(0);
    expect(p.Decode2()).toBe(0);
    expect(p.Decode1()).toBe(0);
    expect(p.Decode1()).toBe(0);
    expect(p.Decode4()).toBe(0);
    p.AssertEnd();
  }
});
