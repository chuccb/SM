import { CChatPool } from "./CChatPool.ts";
import type { CClientSocket } from "../Common/CClientSocket.ts";
import type { CReceivedPacketBase } from "../Common/CReceivedPacketBase.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CProtocolError } from "../Common/CProtocolError.ts";
import {
  ClientRequest,
  ServerResponse,
} from "../Common/Protocol/PacketTypes.ts";
import type { CUser } from "../Common/CUser.ts";
import { g_nLevel2ExpTable } from "../Common/Protocol/OfficialTables.ts";
import { UserCount, IntegerRange } from "../Common/OfficialValues.ts";
import { ServerType } from "../Common/OfficialValues.ts";
import { IPv4Number } from "../Common/CIPAddress.ts";
import type { CCenterProcess } from "../Common/CCenterProcess.ts";
import type { CChannelCache } from "../LS/CChannelCache.ts";
import type { CGameSessionTable } from "./CGameSessionTable.ts";

export class CChannelPool extends CChatPool {
  private readonly m_vRankList: CUser[] = [];
  // Modern detach-safe ownership: in-process handoff empties the old socket's
  // user array BEFORE its close callback. Native used service-local copies.
  private readonly m_mapRankUsers = new Map<CClientSocket, readonly CUser[]>();
  /** 00404EFD: cached level DESC, unsigned global serial ASC, per-user insert.
   * Modern whole-group validation is atomic; repeat attach is idempotent. */
  InsertRankList(socket: CClientSocket): void {
    const users = socket.m_aUser.slice();
    const previous = this.m_mapRankUsers.get(socket);
    if (
      !socket.IsConnected() ||
      users.length < UserCount.Minimum ||
      users.length > UserCount.Maximum ||
      (previous &&
        (previous.length !== users.length ||
          !previous.every((u, i) => users[i] === u)))
    )
      throw new CProtocolError("Invalid rank-list attachment");
    const serials = new Set(
      this.m_vRankList
        .filter((u) => !previous?.includes(u))
        .map((u) => u.GetGlobalSerialNo()),
    );
    for (const [index, user] of users.entries()) {
      const serial = user.GetGlobalSerialNo(),
        level = user.GetLevel();
      if (
        user.IsSetFree() ||
        user.m_pClientSocket !== socket ||
        user.GetSelfidx() !== index ||
        !Number.isInteger(serial) ||
        serial < 0 ||
        serial > IntegerRange.UInt32Maximum ||
        serials.has(serial) ||
        !Number.isInteger(level) ||
        level < 1 ||
        level > g_nLevel2ExpTable.length
      )
        throw new CProtocolError("Invalid or duplicate rank-list user");
      serials.add(serial);
    }
    if (previous) return; // validated idempotent authenticated attachment
    for (const user of users) this.InsertRankUser(user);
    this.m_mapRankUsers.set(socket, users);
  }
  /** 00403B99. Also handles a source socket already detached by a handoff. */
  DeleteRankList(socket: CClientSocket): void {
    const users = this.m_mapRankUsers.get(socket);
    if (!users) return;
    for (const user of users) {
      const index = this.m_vRankList.indexOf(user);
      if (index >= 0) this.m_vRankList.splice(index, 1);
    }
    this.m_mapRankUsers.delete(socket);
  }
  override DeleteSocket(socket: CClientSocket): void {
    this.DeleteRankList(socket);
    super.DeleteSocket(socket);
  }
  /** 00404F97: erase/reinsert ONLY an existing pointer, not a global sort.
   * Native result163 invokes this only on level direction >0, not level-down. */
  UpdateRankList(user: CUser): void {
    const index = this.m_vRankList.indexOf(user);
    if (index < 0) return;
    this.m_vRankList.splice(index, 1);
    this.InsertRankUser(user);
  }
  /** Modern detached array for inspection/tests; CUser identities stay live. */
  GetRankList(): readonly CUser[] {
    return this.m_vRankList.slice();
  }
  private InsertRankUser(user: CUser): void {
    const index = this.m_vRankList.findIndex(
      (other) =>
        user.GetLevel() > other.GetLevel() ||
        (user.GetLevel() === other.GetLevel() &&
          user.GetGlobalSerialNo() < other.GetGlobalSerialNo()),
    );
    this.m_vRankList.splice(
      index < 0 ? this.m_vRankList.length : index,
      0,
      user,
    );
  }

  constructor(
    sessions: CGameSessionTable,
    readonly center: CCenterProcess,
    readonly channels: CChannelCache,
  ) {
    super(sessions);
  }
  override async OnPacket(
    packet: CReceivedPacketBase,
    socket: CClientSocket,
  ): Promise<void> {
    this.RequireAuthenticated(socket);
    if (this.sessions.IsRemovingPlayer(socket))
      throw new CProtocolError("Channel packet during player removal");
    const kind = packet.Decode1();
    switch (kind) {
      case ClientRequest.ReqConnectToSvr: {
        const type = packet.Decode1();
        const index = packet.Decode4();
        if (type !== ServerType.FXShop) packet.Decode2();
        packet.AssertEnd();
        const response = this.center.RequestConnection(socket, type, index);
        const out = new CSendPacket(
          ServerResponse.ConnectToSvr,
          undefined,
          socket.text,
        ).Encode1(response.result);
        if (response.server)
          out
            .Encode1(response.server.m_nServerType)
            .Encode4(response.server.m_nIdx)
            .Encode4(IPv4Number(this.channels.config.Runtime.AdvertisedIP))
            .Encode2(response.server.m_nListenPort);
        socket.SendPacket(out);
        return;
      }
      case ClientRequest.EnterLobbyStage:
        packet.AssertEnd();
        this.sessions.DestroyPlayer(socket);
        socket.m_nPoolType = "Lobby";
        socket.SendPacket(
          new CSendPacket(
            ServerResponse.EnterLobbyStage,
            undefined,
            socket.text,
          ),
        );
        this.sessions.PutAllSessionInfo(socket);
        return;
      case ClientRequest.EnterChannelStage:
        packet.AssertEnd();
        this.sessions.DestroyPlayer(socket);
        socket.m_nPoolType = "Channel";
        socket.SendPacket(this.channels.GetStatePacket());
        socket.SendPacket(this.channels.MakeChannelsGameStatePacket());
        return;
      case ClientRequest.ReqChannelsState:
        packet.AssertEnd();
        if (socket.m_nPoolType !== "Channel")
          throw new CProtocolError("Not in channel selection");
        socket.SendPacket(this.channels.GetStatePacket());
        socket.SendPacket(this.channels.MakeChannelsGameStatePacket());
        return;
      case ClientRequest.RequestUserInventory: {
        packet.AssertEnd();
        const p = new CSendPacket(
          ServerResponse.UserInventory,
          undefined,
          socket.text,
        ).Encode1(socket.GetUserCount());
        for (const user of socket.m_aUser) user.MakeUserInventoryPacket(p);
        socket.SendPacket(p);
        return;
      }
      case ClientRequest.CreateSession:
      case ClientRequest.JoinSession:
      case ClientRequest.AutoJoinSession:
      case ClientRequest.RequestSessionInfoDetail:
        packet.Rewind();
        this.sessions.OnPacket(packet, socket);
        return;
      default:
        packet.Rewind();
        if (kind > 95 && kind < 190) this.sessions.OnPacket(packet, socket);
        else await super.OnPacket(packet, socket);
    }
  }
}
