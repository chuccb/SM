/** Map wire selections and binary layouts pinned to FxServer.exe.c/.lst.
 * Real .idx/.idd coverage is supplemented with small, independently encoded
 * records for legacy/signed/duplicate-group cases absent from shipped data. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { CServerConfig } from "../src/core/Config.ts";
import { CReceivedPacket, CSendPacket, CipherDegree, enSocket } from "../src/core/Packet.ts";
import { CFastFile, CIDFMan } from "../src/FXGS/CData.ts";
import { CGameMapTmpl, CGameMapTmplList } from "../src/FXGS/GameMap.ts";
import { CPracticeSession } from "../src/FXGS/Practice.ts";
import { CGameSession } from "../src/FXGS/Session.ts";
import { CMainSystem } from "../src/FXGS/System.ts";
import { CClientSocket, CUser } from "../src/FXGS/User.ts";
import { GS_ClientSend } from "../src/lib/PacketIDs.ts";

let savedIDF: CIDFMan | null;
let savedMaps: CGameMapTmplList | null;
let savedMain: CMainSystem | null;
let maps: CGameMapTmplList;
let main: CMainSystem;
beforeEach(() => {
  savedIDF = CIDFMan.ms_pInstance;
  savedMaps = CGameMapTmplList.ms_pInstance;
  savedMain = CMainSystem.ms_pInstance;
  maps = new CGameMapTmplList();
  main = new CMainSystem(new CServerConfig([]));
});
afterEach(() => {
  CIDFMan.ms_pInstance = savedIDF;
  CGameMapTmplList.ms_pInstance = savedMaps;
  CMainSystem.ms_pInstance = savedMain;
});

function dwords(...values: number[]): Buffer {
  const result = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => result.writeInt32LE(value | 0, i * 4));
  return result;
}
function name(value: string): Buffer {
  return Buffer.concat([dwords(value.length), Buffer.from(value, "latin1")]);
}
function groups(...entries: [string, string[]][]): Buffer {
  return Buffer.concat([dwords(entries.length), ...entries.flatMap(([key, patterns]) => [
    name(key), dwords(patterns.length), ...patterns.map(name),
  ])]);
}
/** Install an in-memory package through the real CFastFile/CData interfaces. */
function packageData(entries: Record<string, Uint8Array>): void {
  const ff = new CFastFile();
  let offset = 0;
  ff.m_vtEntry = Object.entries(entries).map(([strName, data]) => {
    const entry = { strName, offset, length: data.byteLength };
    offset += data.byteLength;
    return entry;
  });
  ff.m_nDataCount = ff.m_vtEntry.length;
  ff.m_pData = Buffer.concat(Object.values(entries));
  const man = Object.create(CIDFMan.prototype) as CIDFMan;
  man.m_FastFile = ff;
  CIDFMan.ms_pInstance = man;
}
function mapData(teams = 8, players = 8, level = 0, premium = 0, mission = 0): Buffer {
  // New format: version, maxTeam, +36, +40, +44, then +48..+76,
  // MissionInfo (+108..+120), and sync object count (+84).
  return dwords(1000, teams, 1, 15, 13, players, level, premium, 11, 12, 13, 14, 15, mission, 17, 18, 19, 20);
}
function loadMap(data: Uint8Array): CGameMapTmpl {
  packageData({ "Map/Test00": data });
  const tmpl = new CGameMapTmpl();
  tmpl.LoadMap("Map/Test00", 0);
  return tmpl;
}
function residentMap(data = mapData()): CGameMapTmpl {
  const tmpl = loadMap(data);
  maps.m_apGameMapTmpl = [tmpl];
  maps.m_nMapCount = 1;
  return tmpl;
}

describe("CGameMapTmpl::LoadMap (0040C15A)", () => {
  test("new-format fields retain signed values and opaque DWORD bit patterns", () => {
    const data = dwords(1001, 4, 2, 15, 13, 6, -7, 1, -10, 11, 12, 0xabcdef01, 0xfedcba98, 2, 14, 15, 16, 17);
    const tmpl = loadMap(data);
    expect(tmpl).toMatchObject({
      m_strName: "Test00", m_nThemeIdx: 0, m_nVersion: 1001, m_nMaxTeam: 4,
      m_nOld: 2, m_nArg40: 15, m_nArg44: 13, m_nMaxPlayer: 6, m_nLevelLimit: -7,
      m_nPremiumOnly: 1, m_nGhostStart: -10, m_nGhostFreq: 11, m_nArg68: 12,
      m_dwAirplaneItemProb: 0xabcdef01, m_dwArg76: 0xfedcba98,
      m_fMissionMap: 1, m_nMissionType: 2, m_nLapTileCount: 14,
      m_nLapTime: 15, m_nLapBonus: 16, m_nSyncGameObjCount: 17,
    });
    const withTail = loadMap(Buffer.concat([data, Buffer.from([0x12, 0x34])]));
    expect(withTail.m_dwCRC).not.toBe(tmpl.m_dwCRC); // CRC includes non-header map content
    expect(withTail.m_nSyncGameObjCount).toBe(17);
  });

  test.each([999, -1])("legacy first word %i is +40; +44 is NOT max players", (first) => {
    const tmpl = loadMap(dwords(first, 13, 6, -7, 1, 10, 11, 12, 13, 14, 2, 16, 17, 18, 19));
    expect(tmpl).toMatchObject({
      m_nVersion: 1000, m_nMaxTeam: 8, m_nOld: 1, m_nArg40: first, m_nArg44: 13,
      m_nMaxPlayer: 6, m_nLevelLimit: -7, m_nPremiumOnly: 1,
      m_nGhostStart: 10, m_nGhostFreq: 11, m_nArg68: 12,
      m_dwAirplaneItemProb: 13, m_dwArg76: 14, m_fMissionMap: 1,
      m_nMissionType: 2, m_nLapTileCount: 16, m_nLapTime: 17,
      m_nLapBonus: 18, m_nSyncGameObjCount: 19,
    });
  });

  test.each([-1, 0, 1, 2])("IsMissionMap normalizes signed mission type %i", (mission) => {
    residentMap(mapData(8, 8, 0, 0, mission));
    expect(maps.IsMissionMap(0)).toBe(mission > 0 ? 1 : 0);
  });

  test("truncated headers fail before publishing a defaulted map", () => {
    const full = mapData();
    for (let length = 0; length < full.length; length++) {
      packageData({ "Attr/MapGroup": groups(), "Map/Test00": full.subarray(0, length) });
      expect(() => maps.CreateTmplList()).toThrow("Invalid object description file");
      expect(maps.GetMapCount()).toBe(0);
      expect(maps.m_apGameMapTmpl).toHaveLength(0);
    }
  });
});

describe("map groups and template lifecycle", () => {
  test("the shipped package has 226 ordered maps, 13 themes and boolean mission flags", () => {
    new CIDFMan(join(import.meta.dir, "..", "..", "FXGS", "FxServer"));
    maps.CreateTmplList();
    expect(maps.GetMapCount()).toBe(226);
    expect(maps.m_apTheme).toHaveLength(13);
    expect(maps.m_apTheme[0]).toEqual({ strName: "Theme/Bula", m_nMaxTeam: 4 });
    expect(maps.m_apGameMapTmpl[0]).toMatchObject({
      m_nIdx: 0, m_strName: "Bula00", m_nMaxPlayer: 8, m_nLevelLimit: 1,
      m_nPremiumOnly: 1, m_nMissionType: 2, m_fMissionMap: 1,
      m_nLapTileCount: 4, m_nLapTime: 20, m_nLapBonus: 0, m_nSyncGameObjCount: 4,
    });
    expect(maps.IsMissionMap(0)).toBe(1);
    expect(maps.IsMapInGroup("PraticeMapGroup", "Xmas123")).toBe(true);
    expect(maps.IsMapInGroup("LadderMapGroup", "Factory07")).toBe(true);
    expect(maps.IsMapInGroup("ReBirthMapGroup", "Cemetery00")).toBe(true);
    const before = maps.m_apGameMapTmpl.map((tmpl) => ({ ...tmpl }));
    maps.CreateTmplList();
    expect(maps.GetMapCount()).toBe(226);
    expect(maps.m_apGameMapTmpl.map((tmpl) => ({ ...tmpl }))).toEqual(before);
  });

  test("multimap groups accumulate, keys are case-sensitive, patterns are not", () => {
    packageData({ "Attr/MapGroup": groups(
      ["PraticeMapGroup", ["Forest00", "Xmas?", "Forest00"]],
      ["PraticeMapGroup", ["Village01"]],
      ["praticemapgroup", ["Other00"]],
      ["EmptyGroup", []],
    ) });
    maps.LoadMapGroupInfo();
    expect(maps.m_mapMapGroup.get("PraticeMapGroup")).toEqual(["Forest00", "Xmas?", "Forest00", "Village01"]);
    for (const value of ["forest00", "VILLAGE01", "xmas", "Xmas123"]) {
      expect(maps.IsMapInGroup("PraticeMapGroup", value)).toBe(true);
    }
    expect(maps.IsMapInGroup("PraticeMapGroup", "Forest001")).toBe(false);
    expect(maps.IsMapInGroup("PraticeMapGroup", "Other00")).toBe(false);
    expect(maps.m_mapMapGroup.has("EmptyGroup")).toBe(false);
  });

  test.each(["group", "pattern"])("rejects the official 128-byte %s limit instead of partial success", (kind) => {
    packageData({ "Attr/MapGroup": groups([kind === "group" ? "a".repeat(128) : "group", [kind === "pattern" ? "b".repeat(128) : "map"]]) });
    expect(() => maps.LoadMapGroupInfo()).toThrow("Invalid object description file");
    packageData({ "Attr/MapGroup": groups([kind === "group" ? "a".repeat(127) : "group", [kind === "pattern" ? "b".repeat(127) : "map"]]) });
    expect(() => maps.LoadMapGroupInfo()).not.toThrow();
  });

  test("every truncated group boundary is rejected", () => {
    const data = groups(["PraticeMapGroup", ["Village00"]]);
    for (let length = 0; length < data.length; length++) {
      packageData({ "Attr/MapGroup": data.subarray(0, length) });
      expect(() => maps.LoadMapGroupInfo()).toThrow("Invalid object description file");
    }
  });

  test("themes aggregate max teams, exclude Map/_, preserve load order and reset on rebuild", () => {
    packageData({
      "Attr/MapGroup": groups(["PraticeMapGroup", ["Mixed?"]], ["ReBirthMapGroup", ["_Hidden00"]]),
      "Map/Mixed00": mapData(2), "map/mIXED01": mapData(4), "Map/_Hidden00": mapData(8),
      "Map/Other00": mapData(3), "NotMap/Skip00": mapData(),
    });
    maps.CreateTmplList();
    expect(maps.m_apGameMapTmpl.map((tmpl) => [tmpl.m_nIdx, tmpl.m_nThemeIdx])).toEqual([[0, 0], [1, 0], [2, -1], [3, 1]]);
    expect(maps.m_apTheme).toEqual([{ strName: "Theme/Mixed", m_nMaxTeam: 4 }, { strName: "Theme/Other", m_nMaxTeam: 3 }]);
    expect(maps.IsPracticeMap(0)).toBe(1);
    expect(maps.m_apGameMapTmpl[2]!.m_fReBirthMap).toBe(1);
    packageData({ "Attr/MapGroup": groups(), "Map/Next00": mapData(2) });
    maps.CreateTmplList();
    expect(maps.GetMapCount()).toBe(1);
    expect(maps.m_apGameMapTmpl[0]!.m_nIdx).toBe(0);
    expect(maps.m_apTheme).toEqual([{ strName: "Theme/Next", m_nMaxTeam: 2 }]);
    // Dispose resets the two pointer arrays, NOT the +2572 group multimap.
    expect(maps.IsMapInGroup("PraticeMapGroup", "Mixed00")).toBe(true);
  });
});

describe("GetRandomMapIdx eligibility (0040C6D1)", () => {
  test("player, theme and team bounds remain mandatory even with a premium ticket", () => {
    residentMap(mapData(3, 6));
    expect(maps.GetRandomMapIdx(6, 0, 0, 0, 3, 0)).toBe(0);
    for (const [players, theme, teams] of [[0, 0, 3], [9, 0, 3], [7, 0, 3], [6, 1, 3], [6, 0, 4]]) {
      expect(maps.GetRandomMapIdx(players!, 100, theme!, 0, teams!, 1)).toBe(-1);
    }
    expect(maps.GetRandomMapIdx(6, 0, -1, 0, 3, 0)).toBe(0);
  });

  test("premium ticket bypasses level, premium-only and practice checks, but NOT guild mission exclusion", () => {
    residentMap(mapData(8, 8, 20, 1, 2));
    expect(maps.GetRandomMapIdx(2, 1, 0, 1, 2, 0)).toBe(-1);
    expect(maps.GetRandomMapIdx(2, 1, 0, 1, 2, 1)).toBe(0);
    main.m_nChannelType = 77;
    expect(maps.GetRandomMapIdx(2, 1, 0, 1, 2, 1)).toBe(-1);
    residentMap(mapData(8, 8, 20, 1, -1));
    expect(maps.GetRandomMapIdx(2, 1, 0, 1, 2, 1)).toBe(0);
  });

  test("premium channel discounts level without clamping, but does not bypass practice", () => {
    const tmpl = residentMap(mapData(8, 8, 3, 1));
    main.m_nChannelType = 41;
    main.m_nPremiumLv = 5;
    expect(maps.GetMapLevelLimit(0)).toBe(-2);
    expect(maps.GetRandomMapIdx(2, -2, 0, 0, 2, 0)).toBe(0);
    expect(maps.GetRandomMapIdx(2, -3, 0, 0, 2, 0)).toBe(-1);
    expect(maps.GetRandomMapIdx(2, -2, 0, 1, 2, 0)).toBe(-1);
    tmpl.m_fPracticeMap = 1;
    expect(maps.GetRandomMapIdx(2, -2, 0, 1, 2, 0)).toBe(0);
    expect(maps.GetRandomMapIdx(2, -2, 0, 2, 2, 0)).toBe(-1);
  });

  test("only premium-only value 1 is gated, and ladder-group membership is NOT an eligibility gate", () => {
    const tmpl = residentMap(mapData(8, 8, 0, 2));
    main.m_nChannelType = 77;
    tmpl.m_fLadderMap = 0;
    expect(maps.GetRandomMapIdx(2, 0, 0, 0, 2, 0)).toBe(0);
    tmpl.m_nPremiumOnly = 1;
    expect(maps.GetRandomMapIdx(2, 0, 0, 0, 2, 0)).toBe(-1);
    maps.Dispose();
    expect(maps.GetRandomMapIdx(2, 0, 0, 0, 2, 1)).toBe(-1);
  });
});

/** Capture the encoded bodies AND flush boundaries through real session methods. */
function room(colors: (number | null)[], session = new CGameSession()) {
  const socket = Object.create(CClientSocket.prototype) as CClientSocket;
  const packets: { type: number; body: Buffer }[] = [];
  const flushes: number[] = [];
  session.PutPacket = (packet) => packets.push({ type: packet.m_nPacketType, body: Buffer.from(packet.m_pBlock.subarray(0, packet.m_uOffset)) });
  session.FlushPacket = () => { flushes.push(packets.length); };
  colors.forEach((color, slot) => {
    if (color === null) return;
    session.m_rgPlayer[slot] = new CUser(socket);
    session.m_rgSlotState.set([0x82, 0xc3, 0xe0 | color], slot * 3);
    session.m_nCurPlayerNum++;
  });
  function select(value: number) {
    const n = new CReceivedPacket();
    n.Alloc(2);
    n.m_uLength = 2;
    // Wire words are big-endian (unlike the little-endian .idd assets).
    new DataView(n.m_pBlock.buffer, n.m_pBlock.byteOffset).setUint16(0, value & 0xffff);
    session.OnSelectMap(n, socket);
  }
  return { session, socket, packets, flushes, select };
}
function expectedPacket(type: number, ...values: number[]): Buffer {
  const p = new CSendPacket(type, CipherDegree.kPacketEncryptedCRC8);
  if (type === GS_ClientSend.OnSessionMapIdx) p.Encode2(values[0]! & 0xffff);
  else { p.Encode1(values[0]!); p.EncodeBuffer(Uint8Array.from(values.slice(1))); }
  return Buffer.from(p.m_pBlock.subarray(0, p.m_uOffset));
}

/** CPracticeSession::MakeSetSlotStatePacket: AI marker, then optional E2 level. */
function expectedPracticeSlot(slot: number, state: number[], aiLevel: number | null): Buffer {
  const packet = new CSendPacket(GS_ClientSend.OnSetSlotState, CipherDegree.kPacketEncryptedCRC8);
  packet.Encode1(slot);
  packet.EncodeBuffer(Uint8Array.from(state));
  packet.Encode1(aiLevel === null ? 0 : 1);
  if (aiLevel !== null) packet.Encode2(aiLevel);
  return Buffer.from(packet.m_pBlock.subarray(0, packet.m_uOffset));
}

describe("signed map selection → room state → game map", () => {
  beforeEach(() => {
    packageData({ "Attr/MapGroup": groups(), "Map/Small00": mapData(2), "Map/Large00": mapData(8) });
    maps.CreateTmplList();
  });

  test.each([[-1, -1], [-2, 0], [-3, 1]])("wire selection %i resolves the correct theme %i at launch", (selection, theme) => {
    const r = room([0, 1]);
    r.select(selection);
    expect(r.session.m_nMapIdx).toBe(selection);
    expect(r.session.m_fModified & 2).toBe(2);
    expect(r.packets[0]!.body).toEqual(expectedPacket(GS_ClientSend.OnSessionMapIdx, selection));
    expect(r.flushes).toEqual([3]);
    const random = spyOn(maps, "GetRandomMapIdx");
    try {
      r.session.SetMapIdxPlayingByLevel(10, 2, 1);
      expect(random).toHaveBeenCalledWith(2, 10, theme, 0, 2, 1);
      if (theme >= 0) expect(r.session.m_nGameMapIdx).toBe(theme);
      else expect([0, 1]).toContain(r.session.m_nGameMapIdx);
    } finally { random.mockRestore(); }
  });

  test("explicit selections do not call the random picker", () => {
    const r = room([0, 1]);
    r.select(1);
    const random = spyOn(maps, "GetRandomMapIdx");
    try {
      r.session.SetMapIdxPlayingByLevel(10, 2, 0);
      expect(random).not.toHaveBeenCalled();
      expect(r.session.m_nGameMapIdx).toBe(1);
    } finally { random.mockRestore(); }
  });

  test("newcomer colours use the zero-based theme, while all-map random keeps its own branch", () => {
    const r = room([0]);
    r.session.m_nMapIdx = -2;
    expect(r.session.GetColorForNewComer(1)).toBe(3);
    r.session.m_nMapIdx = -3;
    expect(r.session.GetColorForNewComer(1)).toBe(1);
    r.session.m_nMapIdx = -1;
    expect(r.session.GetColorForNewComer(1)).toBe(1);
    r.session.m_nMapIdx = -2;
    r.session.m_rgSlotState[2] = 0xe3;
    expect(r.session.GetColorForNewComer(1)).toBe(0);
  });

  test("in-play requests echo the current selection and flush once without recolouring", () => {
    const r = room([1, 2]);
    r.session.m_nMapIdx = -3;
    r.session.m_fPlaying = 1;
    r.select(-2);
    expect(r.session.m_nMapIdx).toBe(-3);
    expect(r.session.m_fModified).toBe(0);
    expect(r.packets.map((p) => p.body)).toEqual([expectedPacket(GS_ClientSend.OnSessionMapIdx, -3)]);
    expect(r.flushes).toEqual([1]);
    expect([r.session.GetColor(0), r.session.GetColor(1)]).toEqual([1, 2]);
  });

  test.each([
    [2, [0, 1, 2], [0, 3, 0]], // too many colours: seat-order round robin
    [3, [7, 6, 5, 4], [0, 3, 5, 0]],
    [4, [7, 6, 5, 4, 3], [0, 3, 5, 6, 0]],
    [2, [1, 2, 1], [0, 3, 0]], // preserve groups when they fit
    [3, [7, 3, 5, 7], [0, 3, 5, 0]],
    [4, [7, 3, 5, 6], [0, 3, 5, 6]],
    [8, [7, 2, 5], [7, 2, 5]],
    [5, [0, 1], [17, 17]], // original unhandled switch cases
    [6, [0, 1], [17, 17]],
    [7, [0, 1], [17, 17]],
  ] as [number, number[], number[]][])("%i-team colour fold %j → %j preserves state bits and packet order", (teams, input, output) => {
    maps.m_apGameMapTmpl[0]!.m_nMaxTeam = teams;
    const r = room(input);
    const hook = spyOn(r.session.m_pStrategy, "OnSelectColor");
    try {
      r.select(0);
      expect(input.map((_, slot) => r.session.GetColor(slot))).toEqual(output);
      expect(hook).not.toHaveBeenCalled();
      expect(r.packets.map((p) => p.body)).toEqual([
        expectedPacket(GS_ClientSend.OnSessionMapIdx, 0),
        ...output.map((color, slot) => expectedPacket(GS_ClientSend.OnSetSlotState, slot, 0x82, 0xc3, 0xe0 | color)),
      ]);
      expect(r.flushes).toEqual([input.length + 1]);
    } finally { hook.mockRestore(); }
  });

  test("start uses chief level rather than accumulated exp, then preserves packed bits while folding colours", () => {
    const r = room([1, 2]);
    r.session.m_nChiefSlotidx = 0;
    const chief = r.session.m_rgPlayer[0]!;
    chief.m_nLevel = 2;
    chief.dyn.exp = 50000;
    maps.m_apGameMapTmpl[1]!.m_nLevelLimit = 20;
    r.socket.m_apUser = [chief];
    const responses: CSendPacket[] = [];
    r.socket.SendPacket = (packet) => { responses.push(packet); return enSocket.kioOk; };
    const picker = spyOn(maps, "GetRandomMapIdx");
    const launch = spyOn(r.session, "LaunchGameStage").mockImplementation(() => {});
    const hook = spyOn(r.session.m_pStrategy, "OnSelectColor");
    try {
      r.session.OnRequestStartGame(new CReceivedPacket(), r.socket);
      expect(picker).toHaveBeenCalledWith(2, 2, -1, 0, 0, 0);
      expect(r.session.m_nGameMapIdx).toBe(0); // high-level map excluded despite 50K exp
      expect(launch).toHaveBeenCalledTimes(1);
      expect(hook).not.toHaveBeenCalled();
      expect(responses[0]!.m_nPacketType).toBe(GS_ClientSend.OnStartGameRes);
      expect(r.packets.map((p) => p.body)).toEqual([
        expectedPacket(GS_ClientSend.OnSetSlotState, 0, 0x82, 0xc3, 0xe0),
        expectedPacket(GS_ClientSend.OnSetSlotState, 1, 0x82, 0xc3, 0xe3),
      ]);
      expect(r.flushes).toEqual([2]);
    } finally { picker.mockRestore(); launch.mockRestore(); hook.mockRestore(); }
  });

  test.each([0, 1, 2])("start normalizes premium-ticket byte %i to equality-with-1", (ticket) => {
    const r = room([0, 1]);
    const chief = r.session.m_rgPlayer[0]!;
    r.session.m_nChiefSlotidx = 0;
    chief.m_nLevel = 7;
    chief.m_fPremiumTicket = ticket;
    r.socket.m_apUser = [chief];
    r.socket.SendPacket = () => enSocket.kioOk;
    const select = spyOn(r.session, "SetMapIdxPlayingByLevel").mockImplementation(() => {});
    try {
      r.session.OnRequestStartGame(new CReceivedPacket(), r.socket);
      expect(select).toHaveBeenCalledWith(7, 0, ticket === 1 ? 1 : 0);
    } finally { select.mockRestore(); }
  });

  test("AddUser preserves bomber/colour high bits, and reports but continues on an occupied seat", () => {
    const r = room([]);
    r.session.m_rgSlotState.set([0xff, 0xff, 0xff], 0);
    const user = new CUser(r.socket);
    const hook = spyOn(r.session.m_pStrategy, "OnSelectColor");
    const report = spyOn(console, "error").mockImplementation(() => {});
    try {
      r.session.AddUser(0, user, 5, 3);
      expect(Array.from(r.session.m_rgSlotState.subarray(0, 3))).toEqual([0xe1, 0xc5, 0xe3]);
      expect(r.session.m_nCurPlayerNum).toBe(1);
      expect(user.m_nSlotIdx).toBe(0);
      expect(r.socket.m_nPoolType).toBe(2);
      const replacement = new CUser(r.socket);
      r.session.AddUser(0, replacement, 6, 4);
      expect(report).toHaveBeenCalledTimes(1);
      expect(r.session.m_rgPlayer[0]).toBe(replacement);
      expect(r.session.m_nCurPlayerNum).toBe(2); // CListSession tail still runs
      expect(Array.from(r.session.m_rgSlotState.subarray(0, 3))).toEqual([0xe1, 0xc6, 0xe4]);
      expect(hook).not.toHaveBeenCalled();
    } finally { hook.mockRestore(); report.mockRestore(); }
  });

  test("practice AI seats participate through IsPlayerSet, without becoming real users", () => {
    const practice = new CPracticeSession();
    const r = room([1], practice);
    practice.m_argpAISocket[2] = r.socket;
    practice.m_anAILevel[2] = 23;
    practice.m_rgSlotState.set([0x80, 0xc5, 0xe2], 6);
    r.select(-2);
    expect(practice.m_rgPlayer[2]).toBeNull();
    expect([practice.GetColor(0), practice.GetColor(2)]).toEqual([0, 3]);
    expect(r.packets.map((p) => p.body)).toEqual([
      expectedPacket(GS_ClientSend.OnSessionMapIdx, -2),
      expectedPracticeSlot(0, [0x82, 0xc3, 0xe0], null),
      expectedPracticeSlot(2, [0x80, 0xc5, 0xe3], 23),
    ]);
    expect(r.flushes).toEqual([3]);
  });

  test("round robin skips empty slots and a theme's maximum team count drives the same fold", () => {
    const r = room([7, null, 6, null, 5]);
    r.select(-2);
    expect([0, 2, 4].map((slot) => r.session.GetColor(slot))).toEqual([0, 3, 0]);
    expect(r.packets.map((p) => p.body)).toEqual([
      expectedPacket(GS_ClientSend.OnSessionMapIdx, -2),
      expectedPacket(GS_ClientSend.OnSetSlotState, 0, 0x82, 0xc3, 0xe0),
      expectedPacket(GS_ClientSend.OnSetSlotState, 2, 0x82, 0xc3, 0xe3),
      expectedPacket(GS_ClientSend.OnSetSlotState, 4, 0x82, 0xc3, 0xe0),
    ]);
    expect(r.flushes).toEqual([4]);
  });
});
