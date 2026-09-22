/** A04: instruction-derived state/timeout cases, not Windows scheduling tests.
 * Native Center anchors: check 004153B0, move 00415540, timeout 004155F0,
 * list 00408360/00408940, group request 004097B0, timer 00414F20/00415020.
 * Serial values are fixtures; this does not certify the SID/serial allocator.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { CLocalSocket, CLocalServer, CLocalServerMan, CTimerThread, CUser } from "../src/Center/CxCenter.ts";
import { CONNECTION_TIMEOUT_MS, CONNECTING_LIST_BUCKET_COUNT, SERVER_IDX_NONE } from "../src/Center/Defs.ts";
import { CServerConfig, CXCENTER_STR_KEYS } from "../src/core/ServerConfig.ts";
import { GetTickCount } from "../src/core/GetTickCount.ts";
import { CReceivedPacket, CSendPacket, enSocket } from "../src/core/Packet.ts";
import { CM_ReceivedPacket, SVRCLASS_GAME, SVRCLASS_LOGIN, SVRCLASS_SHOP } from "../src/core/protocol/CenterProtocol.ts";

let now: number;
beforeEach(() => {
  now = 100;
  spyOn(performance, "now").mockImplementation(() => now);
  spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => mock.restore());

function received(p: CSendPacket): CReceivedPacket {
  const n = new CReceivedPacket();
  n.SetRcvPacket(p.m_pBlock.slice(0, p.m_uOffset), p.m_uOffset);
  n.SetCipherDegree(p.m_nCipherDegree);
  n.m_nPacketType = n.Decode1();
  return n;
}
function fixture() {
  const cfg = new CServerConfig(CXCENTER_STR_KEYS, true);
  cfg.ParseConfigString("LSNumber 1 FXGSNumber 2 FXSSNumber 1 FXUSNumber 0");
  const center = new CLocalServerMan(cfg);
  const packets: { server: CLocalServer; packet: CReceivedPacket }[] = [];
  function server(type: number, index: number) {
    const s = new CLocalServer("fixture", type, index, "127.0.0.1", 14848 + index);
    s.socket = new CLocalSocket(center);
    spyOn(s.socket, "SendPacket").mockImplementation((p) => {
      packets.push({ server: s, packet: received(p) });
      return enSocket.kioOk;
    });
    center.servers.push(s);
    return s;
  }
  const ls = server(SVRCLASS_LOGIN, 0);
  const gs = server(SVRCLASS_GAME, 0);
  const gs1 = server(SVRCLASS_GAME, 1);
  const shop = server(SVRCLASS_SHOP, 0);
  function user(serial = 1, name = `user${serial}`, owner = ls) {
    const u = new CUser(name, owner.nServerClass, owner.nSvrIdx, serial, 1, 0, center);
    // Test fixtures historically aliased SID and global serial; override the
    // auto-allocated global serial so the serialTable key matches the fixture serial.
    (u as any).m_nGlobalSerial = serial;
    u.nSID = serial;
    center.globalUserTable.userTable.set(name, u); center.globalUserTable.serialTable.set(serial, u);
    return u;
  }
  function transfer(u: CUser, target = gs) {
    expect(u.CheckConnectingToSvr(center, target.nServerClass, target.nSvrIdx)).toBe(1);
    u.SetConnectingToSvr(target.nServerClass, target.nSvrIdx, center);
  }
  function request(serials: number[], owner = ls, target = gs) {
    const p = new CSendPacket(1);
    p.Encode1(serials.length);
    for (const serial of serials) p.Encode4(serial);
    p.Encode1(target.nServerClass); p.Encode4(target.nSvrIdx);
    owner.OnReqConnectToSvr(received(p), center);
    const response = packets.at(-1)!;
    expect(response.server).toBe(owner);
    expect(response.packet.m_nPacketType).toBe(CM_ReceivedPacket.OnCenterResConnectToSvr);
    expect(response.packet.Decode1()).toBe(serials.length);
    for (const serial of serials) expect(response.packet.Decode4()).toBe(serial);
    return response.packet;
  }
  function round() {
    for (let i = 0; i < CONNECTING_LIST_BUCKET_COUNT; i++) center.globalUserTable.DeleteConnectionTimeoutUser();
  }
  return { center, ls, gs, gs1, shop, packets, user, transfer, request, round };
}

describe("CUser monotonic DWORD deadline", () => {
  test("clock truncates and wraps; constructor uses it, independent of wall time", () => {
    spyOn(Date, "now").mockImplementation(() => { throw new Error("wall clock is not this deadline's clock"); });
    for (const value of [0, 19.9, 0x7fffffff, 0x80000000, 0xffffffff, 0x100000001]) {
      now = value;
      expect(GetTickCount()).toBe(value >>> 0);
      expect(new CUser("clock", 1, 0, 1, 1, 0).nConnectStamp).toBe(value >>> 0);
    }
    const f = fixture(); const u = f.user(); f.transfer(u);
    now += CONNECTION_TIMEOUT_MS + 1;
    expect(u.DeferDisconnectTimeout(f.center)).toBe(true);
  });

  for (const start of [100, 0x7fffffff - 1000, 0xffffffff - 1000]) {
    for (const elapsed of [17_499, 17_500, 17_501, 20_000]) {
      test(`unsigned elapsed ${elapsed}ms from ${start.toString(16)}`, () => {
        const f = fixture(); const u = f.user(); now = start; f.transfer(u);
        now = start + elapsed;
        expect(u.DeferDisconnectTimeout(f.center)).toBe(elapsed > 17_500);
        expect(u.fFree).toBe(Number(elapsed > 17_500));
        expect(f.gs.nConnNo).toBe(Number(elapsed <= 17_500));
        expect(u.m_fConnecting).toBe(1); // SetFree does NOT clear it
        expect(u.nSvrIdx).toBe(elapsed > 17_500 ? SERVER_IDX_NONE : 0);
      });
    }
  }

  test("check owns flag/time; move owns counts/list and must not refresh deadline", () => {
    const f = fixture(); const u = f.user();
    expect(f.ls.nConnNo).toBe(1);
    now = 200;
    expect(u.CheckConnectingToSvr(f.center, SVRCLASS_GAME, 0)).toBe(1);
    expect([u.m_fConnecting, u.nConnectStamp, u.nChannel]).toEqual([1, 200, SVRCLASS_LOGIN]);
    expect([f.ls.nConnNo, f.gs.nConnNo]).toEqual([1, 0]);
    now = 300;
    u.SetConnectingToSvr(SVRCLASS_GAME, 0, f.center);
    expect([u.m_fConnecting, u.nConnectStamp]).toEqual([1, 200]);
    expect([f.ls.nConnNo, f.gs.nConnNo]).toEqual([0, 1]);
    now = 200 + 17_501; f.round();
    expect(f.center.globalUserTable.serialTable.has(u.nSID)).toBe(false);
    expect(f.center.globalUserTable.userTable.has(u.m_strName)).toBe(false);
    expect(f.gs.nConnNo).toBe(0);
    expect(f.packets).toHaveLength(0); // no invented timeout/CM11 notification
  });

  test("move alone does not arm; matching establishment clears flag only", () => {
    const f = fixture(); const u = f.user(); const stamp = u.nConnectStamp;
    now++;
    u.SetConnectingToSvr(SVRCLASS_GAME, 0, f.center);
    expect([u.m_fConnecting, u.nConnectStamp]).toEqual([0, stamp]);
    expect(u.CheckConnectionEstablished(SVRCLASS_GAME, 0)).toBe(0);
    f.transfer(u, f.shop);
    expect(u.CheckConnectionEstablished(SVRCLASS_GAME, 0)).toBe(0);
    expect(u.CheckConnectionEstablished(SVRCLASS_SHOP, 1)).toBe(0);
    expect(u.CheckConnectionEstablished(SVRCLASS_SHOP, 0)).toBe(1);
    const armed = u.nConnectStamp;
    u.SetConnectionEstablished(); now += 99_000;
    expect(u.nConnectStamp).toBe(armed);
    expect(u.DeferDisconnectTimeout(f.center)).toBe(false);
    f.round();
    expect(f.center.globalUserTable.serialTable.get(u.nSID)).toBe(u);
    expect([f.gs.nConnNo, f.shop.nConnNo]).toEqual([0, 1]);
  });

  test("all refusal gates leave flag, stamp and counters untouched", () => {
    const f = fixture();
    const cases: { setup?: (u: CUser) => void; type: number; index: number; result: number }[] = [
      { setup: u => { u.fFree = 1; }, type: SVRCLASS_GAME, index: 0, result: 0 },
      { setup: u => { u.m_fConnecting = 1; }, type: SVRCLASS_GAME, index: 0, result: 0 },
      { type: SVRCLASS_LOGIN, index: 0, result: 0 },
      { type: SVRCLASS_GAME, index: -1, result: 0 },
      { type: SVRCLASS_GAME, index: 2, result: 0 },
      { type: 12, index: 0, result: 0 },
      { setup: () => { f.gs.socket = null; }, type: SVRCLASS_GAME, index: 0, result: 0 },
      { setup: () => { f.gs1.nType = 41; }, type: SVRCLASS_GAME, index: 1, result: 2 },
    ];
    for (const [i, c] of cases.entries()) {
      const u = f.user(i + 1); c.setup?.(u);
      const before = [u.m_fConnecting, u.nConnectStamp, f.ls.nConnNo, f.gs.nConnNo];
      now++;
      expect(u.CheckConnectingToSvr(f.center, c.type, c.index)).toBe(c.result);
      expect([u.m_fConnecting, u.nConnectStamp, f.ls.nConnNo, f.gs.nConnNo]).toEqual(before);
    }
  });

  test("SetFree is idempotent; timeout returns true again without double decrement", () => {
    const f = fixture(); const u = f.user(); f.transfer(u); now += 17_501;
    expect(u.DeferDisconnectTimeout(f.center)).toBe(true);
    expect(u.DeferDisconnectTimeout(f.center)).toBe(true);
    u.SetFree(f.center);
    expect([u.fFree, u.m_fConnecting, u.nSvrIdx, f.gs.nConnNo]).toEqual([1, 1, SERVER_IDX_NONE, 0]);
    expect(u.CheckConnectionEstablished(SVRCLASS_GAME, 0)).toBe(0);
    f.round(); expect(f.gs.nConnNo).toBe(0);
  });
});

describe("CGlobalUserTable connecting lists and cleanup", () => {
  test("serial buckets, not name hash; preincrement makes first bucket 1, last 0", () => {
    const f = fixture();
    const users = Array.from({ length: 6 }, (_, i) => f.user(i + 6, `same-prefix-${i}`));
    for (const u of users) f.transfer(u);
    now += 17_501;
    for (const bucket of [1, 2, 3, 4, 5, 0]) {
      f.center.globalUserTable.DeleteConnectionTimeoutUser();
      expect(users[bucket]!.fFree).toBe(1);
      expect(f.center.globalUserTable.serialTable.size).toBe(6 - f.center.globalUserTable.m_nSweepCounter);
    }
    expect(f.center.globalUserTable.userTable.size).toBe(0);
    expect(f.gs.nConnNo).toBe(0);
  });

  test("sweep counter wraps to bucket zero, not 2^32 modulo six", () => {
    const f = fixture(); const u = f.user(6); f.transfer(u); now += 17_501;
    f.center.globalUserTable.m_nSweepCounter = 0xffffffff;
    f.center.globalUserTable.DeleteConnectionTimeoutUser();
    expect(f.center.globalUserTable.m_nSweepCounter).toBe(0);
    expect(u.fFree).toBe(1);
  });

  test("serial bit31 stays unsigned", () => {
    const f = fixture(); const u = f.user(0xffffffff); f.transfer(u); now += 17_501;
    f.center.globalUserTable.DeleteConnectionTimeoutUser(); f.center.globalUserTable.DeleteConnectionTimeoutUser();
    expect(u.fFree).toBe(0);
    f.center.globalUserTable.DeleteConnectionTimeoutUser(); // 0xffffffff % 6 == 3
    expect(u.fFree).toBe(1);
  });

  test("only enqueued users expire, not every armed member of the user table", () => {
    const f = fixture(); const u = f.user();
    expect(u.CheckConnectingToSvr(f.center, SVRCLASS_GAME, 0)).toBe(1);
    now += 30_000; f.round();
    expect(u.fFree).toBe(0); expect(f.ls.nConnNo).toBe(1);
  });

  test("pending duplicates preserve insertion order and are all removed on expiration", () => {
    const f = fixture(); const a = f.user(1); const b = f.user(7);
    f.transfer(a); f.transfer(b); f.center.globalUserTable.InsertConnectingList(1);
    const order: number[] = [];
    for (const u of [a, b]) {
      const original = u.DeferDisconnectTimeout.bind(u);
      spyOn(u, "DeferDisconnectTimeout").mockImplementation(man => { order.push(u.nSID); return original(man); });
    }
    f.center.globalUserTable.DeleteConnectionTimeoutUser();
    expect(order).toEqual([1, 7, 1]);
    now += 17_501; order.length = 0; f.round();
    expect(order).toEqual([1, 7]); // second 1 is already missing, no double free
    expect(f.gs.nConnNo).toBe(0);
    // Reusing the key is test instrumentation to expose residual list nodes.
    const replacement = f.user(1); f.transfer(replacement); replacement.SetConnectionEstablished();
    f.round();
    expect(f.center.globalUserTable.serialTable.get(1)).toBe(replacement);
    const timeout = spyOn(replacement, "DeferDisconnectTimeout");
    f.round(); expect(timeout).not.toHaveBeenCalled();
  });

  test("established and missing entries are lazily removed, including all duplicates", () => {
    const f = fixture(); const a = f.user(1); const b = f.user(7);
    f.transfer(a); f.transfer(b); f.center.globalUserTable.InsertConnectingList(1); f.center.globalUserTable.InsertConnectingList(7);
    a.SetConnectionEstablished();
    b.SetFree(f.center); expect(f.center.globalUserTable.ExtractUser(7)).toBe(b);
    expect(f.center.globalUserTable.ExtractUser(7)).toBeUndefined();
    f.center.globalUserTable.DeleteConnectionTimeoutUser();
    const scan = spyOn(a, "DeferDisconnectTimeout");
    // Insert a new table row but don't enqueue it: stale 7 entries must be gone.
    const replacement = f.user(7); replacement.CheckConnectingToSvr(f.center, SVRCLASS_GAME, 0);
    now += 30_000; f.round();
    expect(scan).not.toHaveBeenCalled();
    expect(replacement.fFree).toBe(0);
    expect(f.center.globalUserTable.serialTable.get(1)).toBe(a);
  });

  test("ExtractUser alone neither frees nor decrements; server deletion follows current location", () => {
    const f = fixture(); const moved = f.user(1); const resident = f.user(2);
    f.transfer(moved); moved.SetConnectionEstablished();
    f.center.globalUserTable.DeleteAllUserOnSvr(SVRCLASS_LOGIN, 0);
    expect(resident.fFree).toBe(1); expect(moved.fFree).toBe(0);
    expect([f.ls.nConnNo, f.gs.nConnNo]).toEqual([0, 1]);
    expect(f.center.globalUserTable.serialTable.size).toBe(1);
    f.center.globalUserTable.DeleteAllUserOnSvr(SVRCLASS_GAME, 0);
    expect(moved.fFree).toBe(1); expect(f.gs.nConnNo).toBe(0);
    expect(f.center.globalUserTable.userTable.size).toBe(0);
    f.round(); expect(f.gs.nConnNo).toBe(0);
    const extracted = f.user(3);
    expect(f.center.globalUserTable.ExtractUser(3)).toBe(extracted);
    expect(extracted.fFree).toBe(0); expect(f.ls.nConnNo).toBe(1);
    extracted.SetFree(f.center);
    expect(f.ls.nConnNo).toBe(0); expect(f.packets).toHaveLength(0);
  });
});

describe("deadline and deletion lifecycle", () => {
  test("an exact-threshold sweep retains the list entry for the next round", () => {
    const f = fixture(); const u = f.user(); f.transfer(u);
    now += 17_500; f.round();
    expect(f.center.globalUserTable.serialTable.get(1)).toBe(u); expect(u.fFree).toBe(0);
    now++; f.round();
    expect(f.center.globalUserTable.serialTable.has(1)).toBe(false); expect(f.gs.nConnNo).toBe(0);
  });
  test("a second transfer before lazy cleanup uses the latest deadline for both entries", () => {
    const f = fixture(); const u = f.user(); f.transfer(u); u.SetConnectionEstablished();
    now += 10_000; f.transfer(u, f.shop);
    now += 10_000; f.round(); // first transfer is old, latest is not
    expect(u.fFree).toBe(0);
    expect([f.ls.nConnNo, f.gs.nConnNo, f.shop.nConnNo]).toEqual([0, 0, 1]);
    f.center.globalUserTable.DeleteAllUserOnSvr(SVRCLASS_GAME, 0);
    expect(f.center.globalUserTable.serialTable.get(1)).toBe(u);
    now += 7_501; f.round();
    expect(u.fFree).toBe(1); expect(f.shop.nConnNo).toBe(0);
    f.round(); expect(f.shop.nConnNo).toBe(0);
  });
  test("normal deletion ignores a former owner but extracts an already-freed user", () => {
    const f = fixture(); const u = f.user(); f.transfer(u);
    const p = new CSendPacket(2); p.Encode4(u.nSID);
    f.ls.OnDeleteUser(received(p), f.center);
    expect(f.center.globalUserTable.serialTable.get(1)).toBe(u); expect(f.gs.nConnNo).toBe(1);
    f.gs.OnDeleteUser(received(p), f.center);
    expect(f.center.globalUserTable.serialTable.has(1)).toBe(false); expect(f.center.globalUserTable.userTable.size).toBe(0);
    expect(u.fFree).toBe(1); expect(f.gs.nConnNo).toBe(0);
    const freed = f.user(); freed.SetFree(f.center);
    f.gs.OnDeleteUser(received(p), f.center); // free-state extraction is outside residency gate
    expect(f.center.globalUserTable.serialTable.has(1)).toBe(false); expect(f.ls.nConnNo).toBe(0);
    f.round(); expect(f.gs.nConnNo).toBe(0); expect(f.packets).toHaveLength(0);
  });
});

describe("OnReqConnectToSvr ordered native group results", () => {
  test("missing serial prevents every check, including earlier valid members", () => {
    const f = fixture(); const u = f.user();
    expect(f.request([1, 999]).Decode1()).toBe(0);
    expect(u.m_fConnecting).toBe(0);
  });
  test("later owner-index mismatch retains earlier flag/time without moving or enqueueing", () => {
    const f = fixture(); const a = f.user(); const b = f.user(2, "other", f.gs1);
    now = 200;
    expect(f.request([1, 2]).Decode1()).toBe(0);
    expect([a.m_fConnecting, a.nConnectStamp, b.m_fConnecting]).toEqual([1, 200, 0]);
    expect([a.nChannel, b.nSvrIdx]).toEqual([SVRCLASS_LOGIN, 1]);
    now += 30_000; f.round(); expect(f.center.globalUserTable.serialTable.size).toBe(2);
  });
  test("owner validation compares index, not class", () => {
    const f = fixture(); const u = f.user(1, "shop-owner", f.shop);
    expect(f.request([1]).Decode1()).toBe(1);
    expect(u.nChannel).toBe(SVRCLASS_GAME);
    expect([f.shop.nConnNo, f.gs.nConnNo]).toEqual([0, 1]);
  });
  for (const lastAccepted of [false, true]) {
    test(`premium pair: LAST result controls movement; last accepted=${lastAccepted}`, () => {
      const f = fixture(); f.gs.nType = 41;
      const a = f.user(1); const b = f.user(2);
      (lastAccepted ? b : a).nAuthencode = 1;
      const response = f.request([1, 2]);
      expect(response.Decode1()).toBe(lastAccepted ? 1 : 2);
      expect([a.m_fConnecting, b.m_fConnecting]).toEqual(lastAccepted ? [0, 1] : [1, 0]);
      expect([f.ls.nConnNo, f.gs.nConnNo]).toEqual(lastAccepted ? [0, 2] : [2, 0]);
      if (lastAccepted) {
        expect([response.Decode1(), response.Decode4(), response.Decode4(), response.Decode2()])
          .toEqual([SVRCLASS_GAME, 0, 0x7f000001, 14848]);
        now += 17_501; f.round();
        expect(a.fFree).toBe(0); expect(b.fFree).toBe(1);
        expect(f.gs.nConnNo).toBe(1);
      } else {
        now += 17_501; f.round(); expect(f.center.globalUserTable.serialTable.size).toBe(2);
      }
    });
  }
  test("earlier zero refusal is overwritten by later success and both users move", () => {
    const f = fixture(); const a = f.user(); f.transfer(a); const b = f.user(2);
    expect(f.request([1, 2]).Decode1()).toBe(1);
    expect([a.nChannel, b.nChannel, f.ls.nConnNo, f.gs.nConnNo]).toEqual([10, 10, 0, 2]);
  });
  test("duplicate serial: first check arms, second refuses; no invented rollback or enqueue", () => {
    const f = fixture(); const u = f.user(); now = 200;
    expect(f.request([1, 1]).Decode1()).toBe(0);
    expect([u.m_fConnecting, u.nConnectStamp, u.nChannel]).toEqual([1, 200, SVRCLASS_LOGIN]);
    now += 30_000; f.round(); expect(u.fFree).toBe(0);
  });

  test("GetSmallLoadedSvrIdx round-robin and active-socket fallback (0040B020)", () => {
    const f = fixture();
    // In fixture(), f.shop (idx 0) has a live socket.
    expect(f.center.GetSmallLoadedSvrIdx(SVRCLASS_SHOP)).toBe(0);
    // Non-shop class returns -1
    expect(f.center.GetSmallLoadedSvrIdx(SVRCLASS_GAME)).toBe(-1);

    // If shop socket is null (disconnected/shutdown), minimum nConnNo server with active socket is chosen
    f.shop.socket = null;
    expect(f.center.GetSmallLoadedSvrIdx(SVRCLASS_SHOP)).toBe(0);
  });
});

test("timer is nominally 400ms; every fourth tick sweeps BEFORE the even-tick broadcast", () => {
  const f = fixture(); const u = f.user(); f.transfer(u); now += 17_501;
  let tick: (() => void) | undefined;
  let interval: number | undefined;
  const unref = mock(() => {});
  spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, ms: number) => {
    tick = callback; interval = ms;
    return { unref };
  }) as unknown as typeof setInterval);
  const counts: number[] = [];
  spyOn(f.center, "SendLocalSvrStatePacket").mockImplementation(flag => {
    expect(flag).toBe(0); counts.push(f.gs.nConnNo);
  });
  new CTimerThread(f.center).Start();
  expect(interval).toBe(400); expect(unref).toHaveBeenCalledTimes(1);
  expect(tick).toBeDefined();
  tick!(); expect(counts).toEqual([]);
  tick!(); expect(counts).toEqual([1]);
  tick!(); expect(f.center.globalUserTable.m_nSweepCounter).toBe(0);
  tick!(); expect(f.center.globalUserTable.m_nSweepCounter).toBe(1); expect(counts).toEqual([1, 0]);
});
