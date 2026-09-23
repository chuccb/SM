/** A11/A21: native tables/instructions → dyn mutations → packet → SQLite → re-entry.
 * Reward-formula tests are deliberately not implied: session fixtures supply
 * known calculator outputs to isolate the state/persistence contract.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CDBMan } from "../src/db/DBMan.ts";
import { CServerConfig } from "../src/core/ServerConfig.ts";
import { CReceivedPacket, CSendPacket, enSocket } from "../src/core/Packet.ts";
import { CDynInfoCalculator_GetLevel as GetLevel, CDynInfoCalculator_GetMaxExpInLevel as GetMaxExpInLevel,
  g_nLevel2ExpTable, kLevelTableSize, LEVEL_EXP_SENTINEL } from "../src/common/LevelTable.ts";
import { CClientSocket } from "../src/FXGS/ClientSocket.ts";
import { CChannelPool } from "../src/FXGS/ChannelPool.ts";
import { CConnectPool } from "../src/FXGS/ConnectPool.ts";
import { CCenterProcess } from "../src/FXGS/CenterProcess.ts";
import { CMainSystem } from "../src/FXGS/MainSystem.ts";
import { CGuildTable } from "../src/FXGS/Guild.ts";
import { CLocalUserTable } from "../src/FXGS/LocalUserTable.ts";
import { CUserItemMan } from "../src/FXGS/ItemMan.ts";
import { CGameSession } from "../src/FXGS/GameSession.ts";
import { CGameSessionTable } from "../src/FXGS/GameSessionTable.ts";
import { CDynInfoCalculator } from "../src/FXGS/DynInfoCalculator.ts";
import { DYN_FLUSH_BURST, USER_MONEY_MAX, FxCLIENT_HASH_A, SESSION_IDX_MAX } from "../src/FXGS/Defs.ts";
import { S2C_GamePacket } from "../src/core/protocol/PacketIDs.ts";

/** Read initialized PE data by VA; no Windows code execution or native-run claim. */
function nativeInt32s(file: string, va: number, count: number): number[] {
  const b = readFileSync(join(import.meta.dir, "../..", file));
  const pe = b.readUInt32LE(0x3c), optional = pe + 24;
  expect(b.readUInt32LE(pe)).toBe(0x4550);
  expect(b.readUInt16LE(optional)).toBe(0x10b);
  const rva = va - b.readUInt32LE(optional + 28);
  const sections = optional + b.readUInt16LE(pe + 20);
  for (let i = 0; i < b.readUInt16LE(pe + 6); i++) {
    const at = sections + i * 40, start = b.readUInt32LE(at + 12), size = b.readUInt32LE(at + 16);
    if (rva >= start && rva + count * 4 <= start + size) {
      const raw = b.readUInt32LE(at + 20) + rva - start;
      return Array.from({ length: count }, (_, k) => b.readInt32LE(raw + 4 * k));
    }
  }
  throw new Error(`VA ${va.toString(16)} is outside initialized sections of ${file}`);
}

describe("shared native level table", () => {
  for (const [file, table, size] of [
    ["LS/CxLogin.exe", 0x48e160, 0x48e868],
    ["FXGS/FxServer.exe", 0x4a84b8, 0x4a8bc0],
    ["FXSS/FxShop.exe", 0x492180, 0x492888],
  ] as const) {
    test(`${file}: all 450 entries equal the supplied PE data`, () => {
      expect(nativeInt32s(file, size, 1)).toEqual([450]);
      expect(nativeInt32s(file, table, 450)).toEqual([...g_nLevel2ExpTable]);
    });
  }
  test("every table boundary and its neighbors, including highest and invalid levels", () => {
    for (let i = 0; i < kLevelTableSize; i++) {
      expect(GetMaxExpInLevel(i)).toBe(g_nLevel2ExpTable[i]!);
      for (const n of [g_nLevel2ExpTable[i]! - 1, g_nLevel2ExpTable[i]!, g_nLevel2ExpTable[i]! + 1]) {
        const upper = g_nLevel2ExpTable.findIndex((threshold) => threshold > n);
        expect(GetLevel(n)).toBe(upper < 0 ? kLevelTableSize : Math.max(1, upper));
      }
    }
    for (const level of [-2147483648, -1, kLevelTableSize, 2147483647]) {
      expect(GetMaxExpInLevel(level)).toBe(0x7fffffff);
    }
    expect(GetLevel(0x7fffffff)).toBe(450);
    expect(GetLevel(0x80000000)).toBe(1); // signed int argument
  });
  test("exp permille: both sentinel guards and exact signed imul/idiv behavior", () => {
    for (const n of [-2147483648, -2147483, -1, 0, 1, 1500, 2999, 3000,
      ...g_nLevel2ExpTable.slice(1).flatMap((exp) => [exp - 1, exp, exp + 1]), 0x7fffffff]) {
      const level = GetLevel(n), low = GetMaxExpInLevel(level - 1), high = GetMaxExpInLevel(level);
      // Independent integer reference; no floating multiply shared with production.
      const expected = high === LEVEL_EXP_SENTINEL || low === LEVEL_EXP_SENTINEL ? 0
        : Number(BigInt.asIntN(32, (BigInt(n) - BigInt(low)) * 1000n) / BigInt(high - low));
      expect(CDynInfoCalculator.GetExpPercentage(n)).toBe(expected);
    }
    expect(CDynInfoCalculator.GetExpPercentage(13815000)).toBe(0);
    expect(CDynInfoCalculator.GetExpPercentage(0x7fffffff)).toBe(0);
  });
});

let db: CDBMan, dir: string, serial = 100;
let main: CMainSystem, channel: CChannelPool, connectPool: CConnectPool, center: CCenterProcess;
let saved: ReturnType<typeof snapshot>;
function snapshot() {
  return { cfg: CServerConfig.ms_pInstance, main: CMainSystem.ms_pInstance, channel: CChannelPool.ms_pInstance,
    connect: CConnectPool.ms_pInstance, center: CCenterProcess.ms_pInstance, users: CLocalUserTable.ms_pInstance,
    guild: CGuildTable.ms_pInstance, items: CUserItemMan.ms_pInstance, sessions: CGameSessionTable.ms_pInstance,
    sockets: CClientSocket.ms_tblSN2Obj, header: CClientSocket.ms_nHeaderTypeCounter };
}
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "sm-dyninfo-")); db = new CDBMan(dir); });
afterAll(() => {
  for (const connection of [...db.userInfo, ...db.inventory, db.config, db.item, db.guild]) connection.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  saved = snapshot();
  const cfg = new CServerConfig([["ServerIndex", ""]]); cfg.ParseConfigString("ServerIndex 2");
  CServerConfig.ms_pInstance = cfg;
  main = new CMainSystem(cfg); new CLocalUserTable(); new CGuildTable(db); new CUserItemMan();
  channel = new CChannelPool(db, cfg); connectPool = new CConnectPool(db); center = new CCenterProcess(db, cfg);
  center.SendPacket = () => enSocket.kioOk; // transport is covered separately; capture client bodies here
  // Use the original table methods with an empty fixture world, not 510 unused rooms.
  CGameSessionTable.ms_pInstance = Object.assign(Object.create(CGameSessionTable.prototype), {
    m_apGameSession: [], m_apPracticeSession: [], m_acTableFlags: new Uint8Array(SESSION_IDX_MAX),
  });
  CClientSocket.ms_tblSN2Obj = new Map();
});
afterEach(() => {
  CServerConfig.ms_pInstance = saved.cfg; CMainSystem.ms_pInstance = saved.main;
  CChannelPool.ms_pInstance = saved.channel; CConnectPool.ms_pInstance = saved.connect;
  CCenterProcess.ms_pInstance = saved.center; CLocalUserTable.ms_pInstance = saved.users;
  CGuildTable.ms_pInstance = saved.guild; CUserItemMan.ms_pInstance = saved.items;
  CGameSessionTable.ms_pInstance = saved.sessions;
  CClientSocket.ms_tblSN2Obj = saved.sockets; CClientSocket.ms_nHeaderTypeCounter = saved.header;
});
function decode(p: CSendPacket): CReceivedPacket {
  const n = new CReceivedPacket(); n.SetRcvPacket(p.m_pBlock.slice(0, p.m_uOffset), p.m_uOffset);
  n.SetCipherDegree(p.m_nCipherDegree); n.m_nPacketType = n.Decode1(); return n;
}
function body(write: (p: CSendPacket) => void): CReceivedPacket {
  const p = new CSendPacket(0); write(p); return decode(p);
}
function socketFixture() {
  const socket = new CClientSocket(); socket.m_bConnected = true;
  const packets: CReceivedPacket[] = [];
  socket.SendPacket = (p) => { packets.push(decode(p)); return enSocket.kioOk; };
  return { socket, packets };
}
function account(): string {
  const id = `dyn${++serial}`;
  expect(db.prCreateUser(id, id, "fixture", "", 0, 0, "", "", 0, "", "", "", "", "")).toBe(0);
  return id;
}
function player() {
  const id = account(), { socket, packets } = socketFixture();
  socket.AddNewUsers(1); const user = socket.GetUser(0)!;
  user.SetName(id); user.SetGlobalSerialNo(serial); user.dyn.strID = id; user.SetLevel();
  CLocalUserTable.ms_pInstance!.Insert(user); connectPool.AddNewSocket(socket);
  return { id, user, socket, packets };
}
function enter(id: string, tail = 1) {
  const { socket, packets } = socketFixture();
  const sn = ++serial;
  connectPool.OnConnEstablished(body((p) => {
    p.Encode1(1); p.EncodeStr(id); p.Encode4(sn); p.Encode4(0);
    p.Encode4(FxCLIENT_HASH_A); p.Encode4(0); p.Encode1(tail);
  }), socket);
  connectPool.OnCenterResConnEstablished(body((p) => { p.Encode1(1); p.Encode4(sn); p.Encode1(0); p.Encode1(1); }));
  return { socket, packets, user: socket.GetUser(0)! };
}
function dynRow(id: string) {
  const info = db.prGetUserInfo(id);
  if (info.retval !== 0) throw new Error(`Fixture row missing: ${id}`);
  return { money: info.money, exp: info.exp, win: info.win, draw: info.draw, lose: info.lose };
}
function detail(n: CReceivedPacket) {
  expect(n.m_nPacketType).toBe(S2C_GamePacket.OnRequestUserInfoDetailRes);
  expect(n.Decode1()).toBe(1);
  const id = n.DecodeStr(), name = n.DecodeStr(), guild = n.DecodeStr(), gender = n.Decode1();
  const stats = [n.Decode4(), n.Decode4(), n.Decode4(), n.Decode4(), n.Decode4(), n.Decode2(), n.Decode4()];
  const location = [n.Decode1(), n.Decode4(), n.Decode2()];
  const reveal = n.Decode1(); const personal = reveal ? Array.from({ length: 4 }, () => n.DecodeStr()) : [];
  const premium = n.Decode4(), community = n.Decode1();
  // These fixtures have no decorations or category-3 inventory.
  expect([n.Decode1(), n.Decode2(), n.Decode2()]).toEqual([0, 0, 0]);
  expect(n.m_uOffset).toBe(n.m_uLength);
  return { id, name, guild, gender, stats, location, reveal, personal, premium, community };
}

describe("CUser dynamic state and flush", () => {
  test("wins/draws/losses share the persisted dyn block, with signed int32 increments", () => {
    const { id, user } = player();
    Object.assign(user.dyn, { win: 4, draw: 5, lose: 6 });
    user.IncWin(); user.IncDraw(); user.IncLose();
    expect([user.dyn.win, user.dyn.draw, user.dyn.lose]).toEqual([5, 6, 7]);
    expect(user.m_fDynInfoModified).toBe(1);
    user.DeferFlushModifiedInfo(db, 1);
    expect(dynRow(id)).toEqual({ money: 0, exp: 0, win: 5, draw: 6, lose: 7 });
    user.dyn.win = 0x7fffffff; user.dyn.draw = -1; user.dyn.lose = 0x7fffffff;
    user.IncWin(); user.IncDraw(); user.IncLose();
    user.DeferFlushModifiedInfo(db, 1);
    expect(dynRow(id)).toMatchObject({ win: -2147483648, draw: 0, lose: -2147483648 });
  });

  test("timer polls do not add games; exactly 25 games trigger the write", () => {
    const { user } = player(); const write = spyOn(db, "WriteUserDynInfo");
    try {
      user.IncWin();
      for (let i = 0; i < 100; i++) user.DeferFlushModifiedInfo(db, 0);
      expect(user.GetGame()).toBe(0); expect(write).not.toHaveBeenCalled();
      for (let i = 0; i < DYN_FLUSH_BURST - 1; i++) { user.IncGame(); user.DeferFlushModifiedInfo(db, 0); }
      expect(user.GetGame()).toBe(24); expect(write).not.toHaveBeenCalled();
      user.IncGame(); user.DeferFlushModifiedInfo(db, 0);
      expect(write).toHaveBeenCalledTimes(1); expect(user.GetGame()).toBe(0);
      expect(user.m_fDynInfoModified).toBe(0);
      user.DeferFlushModifiedInfo(db, 1); expect(write).toHaveBeenCalledTimes(1);
    } finally { write.mockRestore(); }
  });

  test("clean threshold/forced flush resets games and level flag without a DB call", () => {
    const { user } = player(); const write = spyOn(db, "WriteUserDynInfo");
    try {
      user.m_fLevelModified = 1;
      for (let i = 0; i < DYN_FLUSH_BURST; i++) user.IncGame();
      user.DeferFlushModifiedInfo(db, 0);
      expect(user.GetGame()).toBe(0); expect(user.m_fLevelModified).toBe(0);
      user.IncGame(); user.m_fLevelModified = 1; user.DeferFlushModifiedInfo(db, 1);
      expect(user.GetGame()).toBe(0); expect(user.m_fLevelModified).toBe(0);
      expect(write).not.toHaveBeenCalled();
      Object.assign(user, { m_nGame: 0x80000000 });
      user.DeferFlushModifiedInfo(db, 0); expect(user.GetGame()).toBe(0); // unsigned >=25
      Object.assign(user, { m_nGame: 0xffffffff }); // native DWORD boundary fixture
      user.IncGame(); expect(user.GetGame()).toBe(0);
    } finally { write.mockRestore(); }
  });

  test("snapshot and dirty reset precede DB write; a subsequent mutation stays dirty", () => {
    const { user } = player(); user.IncWin(); user.IncGame(); user.m_fLevelModified = 1;
    const write = spyOn(db, "WriteUserDynInfo").mockImplementation((snapshot) => {
      expect(user.GetGame()).toBe(0); expect(user.m_fDynInfoModified).toBe(0); expect(user.m_fLevelModified).toBe(0);
      expect(snapshot).not.toBe(user.dyn); user.IncWin();
      expect(snapshot.win).toBe(1); return false;
    });
    try {
      user.DeferFlushModifiedInfo(db, 1);
      expect(user.dyn.win).toBe(2); expect(user.m_fDynInfoModified).toBe(1);
    } finally { write.mockRestore(); }
  });

  test("SQL failure becomes wrapper false, while native flush flags stay cleared", () => {
    const { id, user } = player(), shard = db.userInfo[db.GetUserHashNo(id)]!;
    shard.exec("CREATE TEMP TRIGGER dyn_write_failure BEFORE UPDATE ON FxUserDynamic BEGIN SELECT RAISE(FAIL,'fixture'); END");
    try {
      user.IncWin(); expect(db.WriteUserDynInfo(user.dyn)).toBe(false);
      expect(() => user.DeferFlushModifiedInfo(db, 1)).not.toThrow();
      expect(user.m_fDynInfoModified).toBe(0); expect(user.m_fLevelModified).toBe(0);
      expect(dynRow(id).win).toBe(0);
    } finally { shard.exec("DROP TRIGGER dyn_write_failure"); }
    user.DeferFlushModifiedInfo(db, 1); expect(dynRow(id).win).toBe(0); // no invented automatic retry
  });

  test("stored-procedure -1 and zero-row update are not SQL execution failures", () => {
    const { id, user } = player(); user.IncDecMoney(5);
    expect(db.prUpdateUserDynamic(id, 5, 0, 0, 0, 0)).toBe(-1);
    expect(db.WriteUserDynInfo(user.dyn)).toBe(true);
    user.DeferFlushModifiedInfo(db, 1);
    expect(user.m_fDynInfoModified).toBe(0);
    expect(dynRow(id).money).toBe(0); // supplied SQL's all-zero guard is preserved
    expect(db.WriteUserDynInfo({ ...user.dyn, strID: "absent", win: 1 })).toBe(true);
  });

  for (const [initial, delta, expected] of [
    [0, -1, 0], [10, -10, 0], [USER_MONEY_MAX - 1, 1, USER_MONEY_MAX],
    [USER_MONEY_MAX, 1, USER_MONEY_MAX], [1, 0x7fffffff, 0], [0, -2147483648, 0],
  ]) {
    test(`money signed-add/clamp ${initial} + ${delta}`, () => {
      const { user } = player(); user.dyn.money = initial!; user.IncDecMoney(delta!);
      expect(user.dyn.money).toBe(expected!); expect(user.m_fDynInfoModified).toBe(1);
    });
  }
  test("zero deltas still dirty dynamic info, without changing the level flag", () => {
    const { user } = player();
    expect(user.IncDecExp(0)).toBe(0); expect(user.m_fDynInfoModified).toBe(1);
    expect(user.m_fLevelModified).toBe(0); user.DeferFlushModifiedInfo(db, 1);
    user.IncDecMoney(0); expect(user.m_fDynInfoModified).toBe(1); expect(user.m_fLevelModified).toBe(0);
  });
  test("experience transitions, sticky level flag, overflow and look-level clamp", () => {
    const { user } = player(); user.dyn.exp = 2999; user.SetLevel();
    expect(user.IncDecExp(1)).toBe(1); expect(user.m_nLevel).toBe(2);
    expect(user.m_fLevelModified).toBe(1);
    expect(user.IncDecExp(0)).toBe(0); expect(user.m_fLevelModified).toBe(1);
    expect(user.IncDecExp(-1)).toBe(-1); expect(user.m_nLevel).toBe(1);
    expect(user.IncDecExp(-4000)).toBe(0); expect(user.dyn.exp).toBe(0);
    user.dyn.exp = 0x7fffffff; user.SetLevel();
    expect(user.IncDecExp(1)).toBe(-1); expect(user.dyn.exp).toBe(0); expect(user.m_nLevel).toBe(1);
    for (const [bonus, look] of [[-10, 1], [0, 1], [10, 11], [500, 450], [0x7fffffff, 1]]) {
      user.SetFakeLevel(bonus!); expect(user.GetLookLevel()).toBe(look!);
    }
  });
});

describe("detail packets, entry and result persistence", () => {
  for (const exp of [0, 2999, 3000, 13814999, 13815000, 0x7fffffff]) {
    test(`local and DB-backed remote detail thresholds at exp ${exp}`, () => {
      const { id, user, socket, packets } = player();
      Object.assign(user.dyn, { exp, win: 4, draw: 5, lose: 6, money: 12 }); user.SetLevel();
      user.account.strName = id; user.account.Reveal = 1;
      Object.assign(user.account, { Address: "address", Tel: "tel", Profile: "profile", Birthday: "2000-01-01" });
      const shard = db.userInfo[db.GetUserHashNo(id)]!;
      shard.query("UPDATE FxUserAccount SET Reveal=1,Address='address',Tel='tel',Profile='profile',Birthday='2000-01-01' WHERE ID=?").run(id);
      user.IncWin(); user.DeferFlushModifiedInfo(db, 1);
      channel.SendUserDetailInfo(socket, user); const local = detail(packets.pop()!);
      center.OnUserChannelResult(body((p) => {
        p.Encode1(0); p.Encode4(user.GetGlobalSerialNo()); p.EncodeStr(id); p.Encode1(10); p.Encode4(7);
      }));
      const remote = detail(packets.pop()!);
      expect(local.stats).toEqual([5, 5, 6, exp, GetMaxExpInLevel(user.m_nLevel), user.m_nLevel, 12]);
      expect(remote.stats).toEqual(local.stats); expect(remote.personal).toEqual(local.personal);
      expect(local.location).toEqual([10, 2, 65535]); expect(remote.location).toEqual([10, 7, 65534]);
    });
  }
  test("missing DB-backed detail returns only failure and requested ID", () => {
    const { user, packets } = player();
    center.OnUserChannelResult(body((p) => {
      p.Encode1(0); p.Encode4(user.GetGlobalSerialNo()); p.EncodeStr("absent"); p.Encode1(10); p.Encode4(7);
    }));
    const response = packets.pop()!;
    expect(response.m_nPacketType).toBe(71); expect(response.Decode1()).toBe(0);
    expect(response.DecodeStr()).toBe("absent"); expect(response.m_uOffset).toBe(response.m_uLength);
  });
  for (const tail of [0, 1, 255]) {
    test(`packet-7 client initialization byte ${tail}, independent of game count`, () => {
      const id = account(); const { user, packets } = enter(id, tail);
      expect(user.IsClientInitialized()).toBe(tail === 0 ? 1 : 0);
      expect(user.GetGame()).toBe(0);
      const ids = packets.map((p) => p.m_nPacketType);
      expect(ids.includes(202)).toBe(tail !== 0); expect(ids.includes(201)).toBe(tail !== 0);
      user.IncGame(); user.DeferFlushModifiedInfo(db, 1);
      expect(user.IsClientInitialized()).toBe(tail === 0 ? 1 : 0);
    });
  }

  test("actual game end → local detail → close force-flush → entry DB reload", () => {
    const id = account(), first = enter(id), other = enter(account());
    first.user.dyn.exp = 2999; first.user.SetLevel();
    const session = new CGameSession(); session.fValid = 1; session.m_nGamePhase = 1;
    session.m_rgPlayer[0] = first.user; session.m_rgPlayer[1] = other.user;
    session.m_DynInfoCalculator.m_nInvalidGame = 0;
    session.m_rgSlotState[2] = 0; session.m_rgSlotState[5] = 1;
    session.m_abDeleted[0] = 6; session.m_abDeleted[1] = 4;
    session.m_DynInfoCalculator.GetWinExp = () => 2;
    session.m_DynInfoCalculator.GetKillNSaveExp = () => 0;
    session.m_GameClock.ElapsedTime = () => 45001;
    const results: CReceivedPacket[] = []; session.SendPacket = (p) => { results.push(decode(p)); };
    channel.m_vtRankList = [other.user, first.user];
    session.DeferHandleGameEnd();
    expect(session.m_nGamePhase).toBe(2); expect(first.user.GetGame()).toBe(1); expect(other.user.GetGame()).toBe(1);
    expect([first.user.dyn.win, other.user.dyn.lose]).toEqual([1, 1]);
    expect(first.user.dyn.exp).toBe(3001); expect(channel.m_vtRankList[0]).toBe(first.user);
    const result = results[0]!; expect(result.m_nPacketType).toBe(163);
    // flag, winner, result-view, ladder, different-team item flag.
    expect(Array.from({ length: 5 }, () => result.Decode1())).toEqual([1, 0, 0, 0, 0]);
    expect(result.Decode1()).toBe(1); expect(result.Decode4()).toBe(first.user.GetGlobalSerialNo());
    expect([result.Decode1(), result.Decode1(), result.Decode1(), result.Decode2(), result.Decode2(), result.Decode2(), result.Decode1(), result.Decode1()])
      .toEqual([0, 0, 0, 0, 0, 2, 1, 0]);
    expect(result.Decode1()).toBe(1); expect(result.Decode4()).toBe(other.user.GetGlobalSerialNo());
    expect([result.Decode1(), result.Decode1(), result.Decode1(), result.Decode2(), result.Decode2(), result.Decode2(), result.Decode1(), result.Decode1()])
      .toEqual([2, 0, 0, 0, 0, 1, 0, 0]);
    expect(Array.from({ length: 6 }, () => result.Decode1())).toEqual([0, 0, 0, 0, 0, 0]);
    expect(result.m_uOffset).toBe(result.m_uLength);
    const savedType = CMainSystem.ms_pInstance!.m_nChannelType;
    CMainSystem.ms_pInstance!.m_nChannelType = 77;
    try {
      const guild = new CGameSession();
      const guildPackets: CReceivedPacket[] = [];
      guild.SendPacket = (packet) => { guildPackets.push(decode(packet)); };
      guild.SendGameResult(0);
      const head = guildPackets[0]!;
      expect(head.m_nPacketType).toBe(163);
      expect([head.Decode1(), head.Decode1(), head.Decode1(), head.Decode1(), head.Decode1()]).toEqual([0, 0, 1, 0, 0]);
    } finally {
      CMainSystem.ms_pInstance!.m_nChannelType = savedType;
    }
    channel.SendUserDetailInfo(first.socket, first.user);
    expect(detail(first.packets.pop()!).stats).toEqual([1, 0, 0, 3001, 6000, 2, 0]);
    expect(dynRow(id).win).toBe(0); // not yet force/25-game flushed
    first.socket.Close(); other.socket.Close();
    expect(dynRow(id)).toMatchObject({ win: 1, exp: 3001 });
    const again = enter(id, 0);
    expect(again.user.dyn).toMatchObject({ strID: id, win: 1, draw: 0, lose: 0, exp: 3001 });
    expect(again.user.m_nLevel).toBe(2); expect(again.user.GetGame()).toBe(0);
    channel.SendUserDetailInfo(again.socket, again.user);
    expect(detail(again.packets.pop()!).stats).toEqual([1, 0, 0, 3001, 6000, 2, 0]);
  });

  for (const winTeam of [-1, 0, 1]) for (const invalidGame of [0, 1]) {
    test(`result team=${winTeam}, IsInvalidGame=${invalidGame}`, () => {
      const { user } = player(); const session = new CGameSession(); session.m_rgPlayer[0] = user;
      session.m_DynInfoCalculator.m_nInvalidGame = invalidGame;
      session.m_DynInfoCalculator.GetDrawExp = () => 5;
      session.m_DynInfoCalculator.GetWinExp = () => 5;
      session.m_DynInfoCalculator.GetKillNSaveExp = () => 5;
      session.m_GameClock.ElapsedTime = () => 45001; session.SendPacket = () => {};
      session.SendGameResult(winTeam);
      const counts = [winTeam === 0, winTeam === -1, winTeam === 1].map((matches) => !invalidGame && matches ? 1 : 0);
      expect([user.dyn.win, user.dyn.draw, user.dyn.lose]).toEqual(counts);
      expect(user.dyn.exp).toBe(invalidGame ? 0 : 5);
      user.DeferFlushModifiedInfo(db, 1);
      const stored = dynRow(user.GetName()); expect([stored.win, stored.draw, stored.lose]).toEqual(counts);
    });
  }
  test("cached client with claimed experience still receives 207/201, not 202", () => {
    const id = account(); main.m_fInventoryDB = 1;
    CUserItemMan.ms_pInstance!.m_vtUserItem.set(501, {
      Type: 101, strAttr: "", strName: "experience", nAttr1: 0, nAttr2: 0, nAttr3: 0,
    });
    db.prAddPreInventory(id, 0, 501, 601, 3000, 30, 6);
    const { user, packets } = enter(id, 0);
    const ids = packets.map((p) => p.m_nPacketType);
    expect(ids.includes(202)).toBe(false); expect(ids.includes(207)).toBe(true); expect(ids.includes(201)).toBe(true);
    expect(user.m_nPreInventoryCount).toBe(1); expect(user.dyn.exp).toBe(3000); expect(user.m_nLevel).toBe(2);
    expect(dynRow(id).exp).toBe(3000); expect(user.m_fDynInfoModified).toBe(0);
  });
  test("leave-loss gate is evaluated after the death callback", () => {
    const { user } = player(); const session = new CGameSession();
    session.fValid = 1; session.m_nGamePhase = 1; session.m_rgPlayer[0] = user; session.m_nCurPlayerNum = 1;
    session.OnBomberDie = () => { session.m_DynInfoCalculator.m_nInvalidGame = 1; };
    session.DeleteUser(0); expect(user.dyn.lose).toBe(0);
  });
  for (const [valid, phase, invalidGame, losses] of [[0, 1, 0, 0], [1, 0, 1, 1], [1, 1, 0, 1], [1, 1, 1, 0], [1, 2, 0, 0]]) {
    test(`leave-loss native gate valid=${valid} phase=${phase} IsInvalidGame=${invalidGame}`, () => {
      const { user } = player(); const session = new CGameSession();
      session.fValid = valid!; session.m_nGamePhase = phase!; session.m_DynInfoCalculator.m_nInvalidGame = invalidGame!;
      session.m_rgPlayer[0] = user; session.m_nCurPlayerNum = 1;
      session.OnBomberDie = () => {}; // death cascade independent of the verified loss gate
      session.DeleteUser(0);
      expect(user.dyn.lose).toBe(losses!); expect(user.GetGame()).toBe(0);
      expect(session.m_rgPlayer[0]).toBeNull();
      user.DeferFlushModifiedInfo(db, 1); expect(dynRow(user.GetName()).lose).toBe(losses!);
    });
  }
});
