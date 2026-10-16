import { CDBSession } from "../../Common/DB/CDBSession.ts";
import { CFastFile } from "../../Common/CFastFile.ts";
import { CTextCodec } from "../../Common/CTextCodec.ts";
import { CUser } from "../../Common/CUser.ts";
import { CSendPacket } from "../../Common/CSendPacket.ts";
import { HOSTHANDLE } from "../../Common/HOSTHANDLE.ts";
import { ChannelType } from "../../Common/OfficialValues.ts";
import { CDBMan } from "../../FXGS/CDBMan.ts";
import { CItemAttr } from "../../FXGS/CItemAttr.ts";
import { CGameClock } from "../../FXGS/CGameClock.ts";
import { CGameSessionTable } from "../../FXGS/CGameSessionTable.ts";
import type { CGameMapTmplList } from "../../FXGS/CGameMapTmplList.ts";
import type { CGameSession } from "../../FXGS/CGameSession.ts";
import { ResultResources } from "./GameResult.ts";
import { MemoryClient, Received } from "./Clients.ts";
import { UserInfo } from "./Accounts.ts";

const files = new CFastFile();
files.FastFileInit("FXGS/FxServer");
export const LaunchItems = new CItemAttr();
LaunchItems.Load(files);
LaunchItems.LoadAirplaneItemInfo("FXGS/iteminfo.txt");
export const LaunchResources = { ...ResultResources, items: LaunchItems };
let serial = 1000;
/** Kernel/service integration, NOT synthetic Running. Only authentication/DB
 * fixture rows are injected;106,109 and discovery must perform the launch. */
export function GameLaunchFixture(
  counts: readonly number[] = [2, 1],
  channelType: number = ChannelType.Normal,
  initialRandom: () => number = () => 1,
  joinTime = 100,
  maps: CGameMapTmplList = ResultResources.maps,
  options: {
    readonly UserNames?: readonly string[];
    readonly Items?: CItemAttr;
  } = {},
) {
  if (
    options.UserNames &&
    options.UserNames.length !== counts.reduce((a, b) => a + b, 0)
  )
    throw new Error("Fixture username count must match local user groups");
  let tick = joinTime,
    random: () => number = initialRandom,
    userIndex = 0;
  const clock = new CGameClock(() => tick),
    session = new CDBSession(":memory:"),
    db = new CDBMan(session);
  const notices: number[] = [],
    clients: MemoryClient[] = [],
    rank: number[] = [];
  const table = new CGameSessionTable(
    new CTextCodec(),
    ResultResources.bombers,
    maps,
    channelType,
    (packet) => notices.push(packet.m_nPacketType),
    {
      DB: db,
      ChannelIndex: 0,
      UpdateRankList: (user) => rank.push(user.GetGlobalSerialNo()),
    },
    {
      Items: options.Items ?? LaunchItems,
      Random: () => random(),
      CreateClock: () => clock,
    },
  );
  for (const count of counts) {
    const peer = new MemoryClient();
    clients.push(peer);
    for (let self = 0; self < count; self++) {
      const defaultName = `Launch${++serial}`;
      const info = UserInfo(options.UserNames?.[userIndex++] ?? defaultName),
        user = new CUser(info, serial);
      peer.m_aUser.push(user);
      user.m_pClientSocket = peer;
      // Explicit test rows, not an alternate registration/authentication API.
      session.db
        .query(
          "INSERT INTO FxUserAccount(ID,UserHashNo,Password) VALUES(?,?,'disabled-test-fixture')",
        )
        .run(info.ID, db.GetUserHashNo(info.ID));
      session.db.query("INSERT INTO FxUserDynamic(ID) VALUES(?)").run(info.ID);
    }
  }
  table.OnPacket(
    Received(
      new CSendPacket(80)
        .EncodeStr("Native launch")
        .EncodeStr("")
        .Encode1(0)
        .Encode1(counts[0]!)
        .EncodeBuffer(Buffer.alloc(counts[0]!)),
    ),
    clients[0]!,
  );
  const room = table.GetSession(clients[0]!)!;
  for (const peer of clients.slice(1))
    table.DoJoinSession(
      peer,
      room.m_nIdx,
      room.m_ulSerialNo,
      "",
      peer.m_aUser.map(() => 0),
    );
  for (const peer of clients.slice(1))
    room.OnPacket(Received(new CSendPacket(96).Encode1(1)), peer);
  room.m_nMapIdx = 200;
  clients.forEach((peer) => peer.Clear());
  notices.length = 0;
  return {
    room,
    table,
    session,
    db,
    clients,
    clock,
    notices,
    rank,
    time: (value: number) => {
      tick = value;
    },
    random: (source: () => number) => {
      random = source;
    },
    clear: () => {
      clients.forEach((peer) => peer.Clear());
      notices.length = 0;
    },
    close: () => {
      clients.forEach((peer) => peer.Close());
      session.Close();
    },
  };
}
export function LaunchReadyPacket(
  room: CGameSession,
  peer: MemoryClient,
): CSendPacket {
  const packet = new CSendPacket(109).Encode4(
    room.maps.GetCRC(room.m_nMapIdxPlaying),
  );
  for (const user of peer.m_aUser) {
    const bomber = room.m_aBomberIdxPlaying[user.m_nSlotIdx]!;
    packet
      .Encode1(bomber)
      .Encode1(room.bombers.GetDefBombCount(bomber))
      .Encode1(room.bombers.GetDefBombPower(bomber))
      .Encode1(room.bombers.GetDefSpeed(bomber));
  }
  return packet;
}
export function DiscoverLaunchPeer(
  room: CGameSession,
  peer: MemoryClient,
  port = 40000,
): boolean {
  return room.OnUDPPeerInfo(
    peer.m_aUser[0]!,
    HOSTHANDLE.FromAddress(peer.address, port),
    [0, 0],
    [0, 0],
  );
}
