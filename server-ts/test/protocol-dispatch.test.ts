/** Native dispatch-path regressions for protocol ids whose context matters. */
import { describe, expect, mock, test } from "bun:test";
import { MakeLower } from "../src/core/MakeLower.ts";
import { CReceivedPacket, CSendPacket, enSocket } from "../src/core/Packet.ts";
import { CServerConfig } from "../src/core/ServerConfig.ts";
import {
  CLocalSocket,
  CLocalServer,
  CLoginServer,
  CGameServer,
  CShopServer,
  CUser as CenterUser,
  CCxCenterApp,
  CLocalServerMan,
  CMonitorSocket,
} from "../src/Center/CxCenter.ts";
import { CChannelPool } from "../src/FXGS/ChannelPool.ts";
import { CBomberAttr } from "../src/FXGS/BomberAttr.ts";
import { CGameSessionTable } from "../src/FXGS/GameSessionTable.ts";
import type { CClientSocket as GameClientSocket } from "../src/FXGS/ClientSocket.ts";
import {
  C2S_GameChatPacket,
  C2S_GameLobbyPacket,
  Center2Monitor_Packet,
} from "../src/core/protocol/PacketIDs.ts";
import {
  MC_GameServerSendPacket,
  MC_LoginServerSendPacket,
  MC_ShopServerSendPacket,
  SVRCLASS_GAME,
  SVRCLASS_LOGIN,
  SVRCLASS_SHOP,
} from "../src/core/protocol/CenterProtocol.ts";

function receivedFrom(packet: CSendPacket): CReceivedPacket {
  const received = new CReceivedPacket();
  received.SetCipherDegree(packet.m_nCipherDegree);
  received.SetRcvPacket(packet.m_pBlock.subarray(0, packet.m_uOffset), packet.m_uOffset);
  return received;
}

function packetWithId(id: number, encode?: (packet: CSendPacket) => void): CReceivedPacket {
  const packet = new CSendPacket(id);
  encode?.(packet);
  return receivedFrom(packet);
}

function fakeCenter(): CLocalServerMan {
  return new CLocalServerMan({
    GetNumAttribute: () => 0,
    GetAttribute: () => "",
  } as unknown as CServerConfig);
}

function dispatchCenter(center: CLocalServerMan, owner: CLocalServer, packet: CReceivedPacket): void {
  owner.OnPacket(packet.Decode1(), packet, center);
}

describe("FxServer inherited packet dispatch", () => {
  test("CChannelPool rewinds every top-level chat opcode into the exact CChatPool slot", () => {
    const pool = Object.create(CChannelPool.prototype) as CChannelPool;
    const calls: string[] = [];
    pool.OnChatMsg = () => { calls.push("chat"); };
    pool.OnAdminNotifyMsg = () => { calls.push("admin"); };
    pool.OnWhisper = () => { calls.push("whisper"); };
    pool.OnItemMsg = () => { calls.push("item"); };
    pool.OnKickoffUser = () => { calls.push("kickoff"); };
    pool.OnSystemMsg = () => { calls.push("system"); };
    pool.OnShoutMsg = () => { calls.push("shout"); };
    pool.OnSystemCmd = () => { calls.push("command"); };
    const cases = [
      [C2S_GameChatPacket.OnChatMsg, "chat"],
      [C2S_GameChatPacket.OnAdminNotifyMsg, "admin"],
      [C2S_GameChatPacket.OnWhisper, "whisper"],
      [C2S_GameChatPacket.OnItemMsg, "item"],
      [C2S_GameChatPacket.OnKickoffUser, "kickoff"],
      [C2S_GameChatPacket.OnSystemMsg, "system"],
      [C2S_GameChatPacket.OnShoutMsg, "shout"],
      [C2S_GameChatPacket.OnSystemCmd, "command"],
    ] as const;
    for (const [id, expected] of cases) {
      calls.length = 0;
      pool.OnPacket(packetWithId(id), {} as GameClientSocket);
      expect(calls).toEqual([expected]);
    }

    // Native's explicit 208 comparison ultimately reaches the same base tail,
    // but CChatPool has no 208 handler and no nested opcode follows it.
    calls.length = 0;
    pool.OnPacket(packetWithId(208), {} as GameClientSocket);
    expect(calls).toEqual([]);
  });

  test("slash chat passes the already-decoded command string to OnSpecialCommand", () => {
    const pool = Object.create(CChannelPool.prototype) as CChannelPool;
    const special = mock((_command: string, _socket: GameClientSocket) => {});
    pool.OnSpecialCommand = special;
    const socket = {} as GameClientSocket;
    const n = packetWithId(C2S_GameChatPacket.OnChatMsg, (p) => p.EncodeStr("/who"));
    n.Decode1();
    pool.OnChatMsg(n, socket);
    expect(special).toHaveBeenCalledWith("/who", socket);
    expect(n.IsEOS()).toBe(true);
  });

  test("packet 84 decodes password/game/count/selects and supplies the CP949 guild title", () => {
    const previous = CBomberAttr.ms_pInstance;
    CBomberAttr.ms_pInstance = { GetTotalCount: () => 3 } as unknown as CBomberAttr;
    try {
      const table = Object.create(CGameSessionTable.prototype) as CGameSessionTable;
      const create = mock((_socket: GameClientSocket, _title: string, _password: string, _selections: number[], _gameType: number) => {});
      table.DoCreateSession = create;
      const socket = { GetUserCount: () => 2 } as GameClientSocket;
      const request = packetWithId(C2S_GameLobbyPacket.OnRequestCreateGuildSession, (p) => {
        p.EncodeStr("secret");
        p.Encode1(7);
        p.Encode1(2);
        p.Encode1(5); // modulo (3 + 1) => 1
        p.Encode1(6); // => 2
      });
      request.Decode1(); // CChannelPool consumed and rewound before vtbl+56; method sees body
      table.CreateSessionGuild(request, socket);
      expect(create).toHaveBeenCalledTimes(1);
      const [actualSocket, title, password, selections, gameType] = create.mock.calls[0]!;
      expect(actualSocket).toBe(socket);
      expect(Buffer.from(title as string, "latin1").toString("hex")).toBe("b1e6b5e5b9e6");
      expect([password, selections, gameType]).toEqual(["secret", [1, 2], 7]);
    } finally {
      CBomberAttr.ms_pInstance = previous;
    }
  });

  test("packet 84 count mismatch closes without creating a room", () => {
    const table = Object.create(CGameSessionTable.prototype) as CGameSessionTable;
    const create = mock((_socket: GameClientSocket, _title: string, _password: string, _selections: number[], _gameType: number) => {});
    const close = mock(() => {});
    table.DoCreateSession = create;
    const socket = { GetUserCount: () => 2, PostClosePacket: close } as unknown as GameClientSocket;
    const request = packetWithId(C2S_GameLobbyPacket.OnRequestCreateGuildSession, (p) => {
      p.EncodeStr("secret"); p.Encode1(1); p.Encode1(1); p.Encode1(0);
    });
    request.Decode1();
    table.CreateSessionGuild(request, socket);
    expect(close).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("CLocalServerMan class-aware dispatch and monitor wire", () => {
  test("CCxCenterApp composes, rather than inherits, the native manager", () => {
    const app = new CCxCenterApp({
      GetNumAttribute: () => 0,
      GetAttribute: () => "",
    } as unknown as CServerConfig);
    expect(app).not.toBeInstanceOf(CLocalServerMan);
    expect(app.localServerMan).toBeInstanceOf(CLocalServerMan);
  });

  test("MakeLower folds ASCII names without corrupting a CP949 trail byte", () => {
    expect(MakeLower("AB\x81CDE\0tail")).toBe("ab\x81Cde");
  });

  test("failed MC 0 batches stop inserting, roll back every constructed user, and retain peak", () => {
    const center = fakeCenter();
    const owner = new CLoginServer("LS", SVRCLASS_LOGIN, 0, "127.0.0.1", 0);
    const sent: CSendPacket[] = [];
    owner.socket = { SendPacket: (packet: CSendPacket) => { sent.push(packet); return enSocket.kioOk; } } as CLocalSocket;
    center.servers.push(owner);

    const resident = new CenterUser("TaKeN", SVRCLASS_LOGIN, 0, 900, 0, 0, center);
    expect(center.globalUserTable.AddNewUser(resident, new Date(2026, 8, 21))).toBe(1);
    expect(owner.nConnNo).toBe(1);

    const request = packetWithId(0, (p) => {
      p.Encode4(0x0100007f);
      p.EncodeBuffer(new Uint8Array(16));
      p.Encode4(0);
      p.Encode1(3);
      // The duplicate row deliberately reuses the resident's account SID;
      // this port must not extract the older object during native-style rollback.
      for (const [name, serial] of [["fresh", 101], ["taken", 900], ["after", 103]] as const) {
        p.EncodeStr(name); p.Encode4(serial); p.Encode1(0); p.Encode1(0);
      }
      p.Encode4(77);
    });
    request.Decode1();
    owner.OnAddNewUser(request, center);

    // 900/101/103 are the packet account SIDs (CUser+80). The serial table and
    // ExtractUser key CSerialObject::m_nSerialNo (+28), which the ctor assigns
    // by InterlockedIncrement and never from that SID (CxCenter.exe.c:15235, 21338).
    expect(resident.nSID).toBe(900);
    expect(center.globalUserTable.userTable.get("taken")).toBe(resident);
    expect(center.globalUserTable.userTable.has("fresh")).toBe(false);
    expect(center.globalUserTable.userTable.has("after")).toBe(false);
    expect(center.globalUserTable.serialTable.get(resident.m_nGlobalSerial)).toBe(resident);
    expect(center.globalUserTable.serialTable.has(101)).toBe(false);
    expect(center.globalUserTable.serialTable.has(103)).toBe(false);
    expect(owner.nConnNo).toBe(1);
    expect(center.globalUserTable.m_nDailyPeakUsers).toBe(2);

    const reply = receivedFrom(sent[0]!);
    expect(reply.Decode1()).toBe(0);
    expect([reply.Decode4(), reply.Decode4(), reply.Decode1()]).toEqual([77, 0, 3]);
    expect([reply.Decode4(), reply.Decode4(), reply.Decode4(), reply.IsEOS()]).toEqual([0, 0, 0, true]);
  });

  test("MC 9 from GS is ignored while the Shop-class packet updates auth code", () => {
    const center = fakeCenter();
    const user = new CenterUser("alice", SVRCLASS_GAME, 0, 0x1234, 1, 0);
    (user as any).m_nGlobalSerial = 0x1234;
    center.globalUserTable.serialTable.set(0x1234, user);

    const game = new CGameServer("GS", SVRCLASS_GAME, 0, "127.0.0.1", 0);
    dispatchCenter(center, game, packetWithId(MC_GameServerSendPacket.SendAuthenCode, (p) => {
      p.Encode4(0x1234); p.Encode1(2);
    }));
    expect(user.GetAuthencode()).toBe(0);

    const shop = new CShopServer("Shop", SVRCLASS_SHOP, 0, "127.0.0.1", 0);
    dispatchCenter(center, shop, packetWithId(MC_ShopServerSendPacket.SendAuthenCode, (p) => {
      p.Encode4(0x1234); p.Encode1(3);
    }));
    expect(user.GetAuthencode()).toBe(3);
  });

  test("MC 100 frees the reserved sentinel only in the login-server context", () => {
    const center = fakeCenter();
    const sentinel = new CenterUser("center", SVRCLASS_LOGIN, 0, 0xffffffff, 0, 0);
    center.globalUserTable.serialTable.set(0xffffffff, sentinel);

    const game = new CGameServer("GS", SVRCLASS_GAME, 0, "127.0.0.1", 0);
    dispatchCenter(center, game, packetWithId(MC_LoginServerSendPacket.OnDestructCenterSvr));
    expect(sentinel.fFree).toBe(0);

    const login = new CLoginServer("LS", SVRCLASS_LOGIN, 0, "127.0.0.1", 0);
    dispatchCenter(center, login, packetWithId(MC_LoginServerSendPacket.OnDestructCenterSvr));
    expect(sentinel.fFree).toBe(1);
  });

  test("monitor packet 0 is [E4 current][E4 local-day peak]", () => {
    const center = fakeCenter();
    center.globalUserTable.userTable.set("a", new CenterUser("a", 1, 0, 1, 1, 0));
    center.globalUserTable.userTable.set("b", new CenterUser("b", 1, 0, 2, 2, 0));
    center.globalUserTable.UpdateDailyPeak(new Date(2026, 8, 21, 12));
    center.globalUserTable.userTable.delete("b");
    center.globalUserTable.UpdateDailyPeak(new Date(2026, 8, 21, 13));

    const monitor = new CMonitorSocket(center);
    const sent: CSendPacket[] = [];
    monitor.SendPacket = (packet) => { sent.push(packet); return enSocket.kioOk; };
    monitor.OnRequestCurrentUserStat();

    const n = receivedFrom(sent[0]!);
    expect(n.Decode1()).toBe(Center2Monitor_Packet.OnRequestCurrentUserStat);
    expect([n.Decode4(), n.Decode4(), n.IsEOS()]).toEqual([1, 2, true]);

    center.globalUserTable.UpdateDailyPeak(new Date(2026, 8, 22, 1));
    expect(center.globalUserTable.m_nDailyPeakUsers).toBe(1);
  });

  test("monitor packet 1 preserves class/index/name and disconnected -1", () => {
    const center = fakeCenter();
    const online = new CLocalServer("Game A", 10, 2, "127.0.0.1", 4848);
    online.socket = {} as CLocalSocket;
    online.nConnNo = 7;
    const offline = new CLocalServer("Shop A", 11, 3, "127.0.0.1", 9801);
    center.servers.push(online, offline);

    const monitor = new CMonitorSocket(center);
    let sent: CSendPacket | null = null;
    monitor.SendPacket = (packet) => { sent = packet; return enSocket.kioOk; };
    monitor.OnRequestSvrState();

    const n = receivedFrom(sent!);
    expect(n.Decode1()).toBe(Center2Monitor_Packet.OnRequestSvrState);
    expect(n.Decode4()).toBe(2);
    expect([n.Decode1(), n.Decode2(), n.DecodeStr(), n.Decode4()]).toEqual([10, 2, "Game A", 7]);
    expect([n.Decode1(), n.Decode2(), n.DecodeStr(), n.Decode4()]).toEqual([11, 3, "Shop A", 0xffffffff]);
    expect(n.IsEOS()).toBe(true);
  });
});
