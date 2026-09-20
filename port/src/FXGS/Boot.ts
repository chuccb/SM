/** CUDPPacketDispatcher::OnUDPPacket — the MTUDP check packets — and
 *  main(): CFxServerApp::SetUp. */

import { CHANNEL_TYPE_GUILD } from "./Defs";
import { CServerConfig } from "../core/Config.ts";
import { CReceivedPacket, CipherDegree, kPacketEncryptedCRC8 } from "../core/Packet.ts";
import { PacketLog } from "../core/PacketLog.ts";
import { CDBMan } from "../db/DBMan.ts";
import { CIDFMan } from "./CData.ts";
import { HOSTHANDLE, MTUDP_TYPE_PEER_INFO, MTUDP_TYPE_READY_FOR_IMMEDIATE_START, MTUDP_UDP_PORT_OFFSET, SplitDatagram } from "./MTUDP.ts";
import { CLIENT_SOCKET_CENSUS_MS } from "../lib/S2S.ts";
import { FXSERVER_STR_KEYS } from "../core/Config.ts";
import { PACKET_NAME_TABLES } from "../lib/PacketIDs.ts";
import { CChannelPool } from "./Chat";
import { CBomberAttr, CGameMapTmplList, CItemAttr } from "./GameData";
import { CConnectPool } from "./Pools";
import { CUserItemMan } from "./CUserItemMan";
import { CGameSessionTable } from "./SessionTable";
import { CCenterProcess, CMainSystem } from "./System";
import { CGuildTable, CLocalUserTable } from "./Tables";
import { CClientSocket } from "./User";

// ============================ boot ============================

/** CFxServerApp::SetUp — the process entry. */
/**
 * CUDPPacketDispatcher::OnUDPPacket (416619) — one MTUDP frame body.
 * type 1 = the OnReadyForImmediateStart check (35 bytes), type 11 =
 * OnUDPPeerInfo (23 bytes); anything else reports and drops.
 */
export function OnUDPPacket(payload: Uint8Array, host: HOSTHANDLE): void {
  const type = payload[0];
  if (type === MTUDP_TYPE_READY_FOR_IMMEDIATE_START) {
    if (payload.length !== 35) {
      console.error(`[GS] Invalid CheckUDPPacket from the Host ${host.ip},${host.port}`);
      return;
    }
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const user = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(dv.getUint32(1, false));
    if (!user) return;
    const idx = dv.getUint16(5, false);
    const serial = dv.getUint32(7, false);
    // hosts[2]/ports[2] at 11..22 and the dword at 23 are passed by the
    // original but only re-read from the body by the session: rewind to 27.
    const body = new CReceivedPacket();
    body.SetRcvPacket(payload.subarray(27), payload.length - 27);
    CGameSessionTable.ms_pInstance!.OnReadyForImmediateStart(idx, serial, user, body);
    return;
  }
  if (type === MTUDP_TYPE_PEER_INFO) {
    if (payload.length !== 23) {
      console.error(`[GS] Invalid CheckUDPPacket from the Host ${host.ip},${host.port}`);
      return;
    }
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const user = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(dv.getUint32(1, false));
    if (!user) return;
    const idx = dv.getUint16(5, false);
    const serial = dv.getUint32(7, false);
    const hosts = [dv.getUint32(11, false), dv.getUint32(17, false)];
    const ports = [dv.getUint16(15, false), dv.getUint16(21, false)];
    CGameSessionTable.ms_pInstance!.OnUDPPeerInfo(idx, serial, user, host, hosts, ports);
    return;
  }
  console.error(`[GS] Invalid CheckUDPPacket from the Host ${host.ip},${host.port}`);
}

export async function main(cfgFile: string, dbDir: string): Promise<void> {
  const cfg = new CServerConfig(FXSERVER_STR_KEYS);
  cfg.Init(cfgFile);
  CServerConfig.ms_pInstance = cfg;

  PacketLog.Configure("GS");
  PacketLog.Register("GS", "recv", ...PACKET_NAME_TABLES.GS.recv);
  PacketLog.Register("GS", "send", ...PACKET_NAME_TABLES.GS.send);

  // CBomberAttr / CItemAttr / CGameMapTmplList load from the IDF package
  // (FxServer.idd/.idx, CIDFMan::CIDFMan hardcodes the "FxServer" base —
  // FxServer.exe.c:13436 loads them right after CUserItemMan).  The package
  // ships in the server directory, next to the .cfg.
  new CIDFMan(require("node:path").join(require("node:path").dirname(cfgFile), "FxServer"));
  new CBomberAttr().Load();
  new CItemAttr().Load();
  new CGameMapTmplList().CreateTmplList();

  const db = new CDBMan(dbDir);
  const itemMan = new CUserItemMan();
  itemMan.Init(db);
  new CLocalUserTable();
  const mainSystem = new CMainSystem(cfg);
  const connectPool = new CConnectPool(db);
  const channelPool = new CChannelPool(db);
  new CGuildTable(db);
  const center = new CCenterProcess(db);
  void mainSystem;
  void connectPool;
  void channelPool;

  // CCenterProcess::Init (FxServer.exe.c:13383) — the WinMain order is the
  // center attach (with the endless 3 s retry loop) BEFORE CListenThread.
  await center.Init(cfg);
  // The session ctors bind their strategy from MainSystem+8 (:37220), so
  // the channel table has to be in before CGameSessionTable constructs its
  // 510 sessions (the original races this against its DB opens).
  await center.WaitChannelInfo();
  const sessionTable = new CGameSessionTable();

  // CListenThread — the client listener (ServerIP/ServerPort)
  const port = cfg.GetNumAttribute("ServerPort") || 4848;
  const clientSockets = new WeakMap<object, CClientSocket>();
  Bun.listen({
    hostname: "0.0.0.0",
    port,
    socket: {
      open: (t) => {
        const socket = new CClientSocket();
        clientSockets.set(t, socket);
        socket.bunSocket = t as Bun.Socket<any>;
        socket.m_bConnected = true;
        // CListenThread::Proc (FxServer.exe.c:18963-18966) — the accept packet
        // 0, then vtbl SetCipherDegree(2), then IssueReceive.  The client's
        // very first frame is already degree-2 (SES3 + CRC8), so the degree
        // must be armed before the first receive — exactly like the LS.
        mainSystem.OnConnEstablished(socket);
        socket.SetCipherDegree(CipherDegree.kPacketEncryptedCRC8);
      },
      data: (t, data) => {
        const s = clientSockets.get(t);
        if (s) {
          s.m_dwIdleTime = Date.now();
          s.OnReceive(new Uint8Array(data as Buffer));
        }
      },
      close: (t) => {
        clientSockets.get(t)?.Close();
      },
      error: (_t, err) => console.error(`[GS] ${String(err)}`),
    },
  });
  console.log(`[GS] listening on :${port}`);

  // MTUDPBase::StartupBase (42E828) — the UDP peer socket on ServerPort +
  // MTUDP_UDP_PORT_OFFSET, and CUDPPacketDispatcher::Proc (41678B) —
  // frame-split each datagram and route the launch-handshake check packets.
  const udpLogTag = PacketLog.tag; // snapshotted: the handler outlives main()
  // Bun.udpSocket() is async: await the bind so a taken port (a previous
  // GS instance still holding udp :14849) fails the startup loudly instead
  // of leaving a TCP-only server that silently never answers the launch
  // handshake — clients would load into the map and freeze.
  const udpServer = await Bun.udpSocket({
    hostname: "0.0.0.0",
    port: port + MTUDP_UDP_PORT_OFFSET,
    socket: {
      data: (_socket, data, port, address) => {
        if (PacketLog.ShowsClient()) PacketLog.Datagram("recv", new Uint8Array(data as Buffer), udpLogTag);
        // network order: BE Encode4 puts a.b.c.d back on the wire
        const host: HOSTHANDLE = {
          ip: String(address)
            .split(".")
            .reduce((acc: number, o) => ((acc << 8) | (Number(o) & 0xff)) >>> 0, 0),
          port: Number(port),
        };
        for (const frame of SplitDatagram(new Uint8Array(data as Buffer), host)) {
          OnUDPPacket(frame.payload, frame.host);
        }
      },
    },
  });
  console.log(`[GS] MTUDP initialized succefully (udp :${port + MTUDP_UDP_PORT_OFFSET})`);
  void udpServer;

  // CTimerThreadNormal::Proc (FxServer.exe.c:415B65) — one Sleep(0x190)
  // tick; every cadence below is a mod-counted defer with its own BSS
  // counter (dword_4AF678..68C), run in the original order.  The room
  // 85/86/87 broadcasts ride this timer in the original, not the request
  // path.  DeferUpdateFreeServerListCache (every 12th tick) refreshes the
  // table's cached free-room list (:422EC5 CacheGameServerList) — the list
  // has no readers anywhere in the binary, so it is not modeled (the
  // UpdateGameEtc table slot at vtbl+36 is equally uncalled in the binary);
  // the
  // trailing FlushLocalSocketSndBuffer/FlushClientSocketSndBuffer and the
  // per-socket CServerSocket::Flush in CChatPool::FlushAll are no-ops
  // (TS sockets write through on PutPacket); DeferTimeLog is log-only.
  let poolOnTimerCount = 0; // dword_4AF7B8 — one counter shared by both pools
  let flushRoomCount = 0; // dword_4AF678
  let flushTableCount = 0; // dword_4AF67C
  let flushUserCount = 0; // dword_4AF688
  let flushGuildCount = 0; // dword_4AF68C
  let censusTime = 0; // the static ::Time of FlushClientSocketSndBuffer
  // NB: the original's other timer thread (CTimerThreadTimeCritical::Proc)
  // additionally runs CheckCPUUsage every 3rd iteration — a host-side PDH
  // monitor logging "Abnormal CPU Usage" at >=80% (FxServer.exe.c:25855).
  // It touches no client-visible state and has no Bun equivalent.
  setInterval(() => {
    connectPool.OnTimer(++poolOnTimerCount);
    channelPool.OnTimer(++poolOnTimerCount); // shared counter: +2 per tick → 120 s sweep
    if (++flushRoomCount % 0xC === 0) sessionTable.FlushModifiedInfo(); // every 12th tick
    if (++flushTableCount % 3 === 0) sessionTable.FlushModifiedTableInfo(); // every 3rd
    if (++flushUserCount % 0x96 === 0) {
      CLocalUserTable.ms_pInstance!.ForEach((user) => user.DeferFlushModifiedInfo(db, 0));
      channelPool.FlushAll(0);
    }
    if (CMainSystem.ms_pInstance!.m_nChannelType === CHANNEL_TYPE_GUILD && ++flushGuildCount % 0x12C === 0) {
      CGuildTable.ms_pInstance!.ForEach((guild) => guild.DeferFlushModifiedInfo(0)); // every 0x12C ticks = 120 s
    }
    sessionTable.UpdateGameSessions();
    // CClientSocket::FlushClientSocketSndBuffer (004071A6) — the flush
    // itself writes through, but the 5-minute census line stays observable
    const now = Date.now() & 0x7fffffff;
    if (censusTime === 0) censusTime = now;
    if (now - censusTime > CLIENT_SOCKET_CENSUS_MS) {
      let sockets = 0;
      let users = 0;
      for (const s of CClientSocket.ms_tblSN2Obj.values()) {
        const c = s.GetUserCount();
        if (c !== 0) {
          sockets++;
          users += c;
        }
      }
      if (sockets !== 0 && users !== 0) console.log(`[GS] Socket count(${sockets}), UserCount(${users})`);
      censusTime = now;
    }
  }, 0x190);
}
