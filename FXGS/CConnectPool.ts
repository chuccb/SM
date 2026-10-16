import type { CClientSocket } from "../Common/CClientSocket.ts";
import type { CReceivedPacketBase } from "../Common/CReceivedPacketBase.ts";
import { CSendPacket } from "../Common/CSendPacket.ts";
import { CUser } from "../Common/CUser.ts";
import { NormalizeID } from "../Common/CIDCompare.ts";
import { CProtocolError } from "../Common/CProtocolError.ts";
import {
  ClientRequest,
  ServerResponse,
} from "../Common/Protocol/PacketTypes.ts";
import {
  OpaqueOfficial,
  UserCount,
  UserFieldSize,
} from "../Common/OfficialValues.ts";
import type { CCenterProcess } from "../Common/CCenterProcess.ts";
import type { CDBMan } from "./CDBMan.ts";
import type { CUserItemMan } from "./CUserItemMan.ts";
import type { CGameSessionTable } from "./CGameSessionTable.ts";

/** GS 004081EF / 0040860C. There is no invented opcode-7 success acknowledgment. */
export class CConnectPool {
  constructor(
    readonly db: CDBMan,
    readonly center: CCenterProcess,
    readonly items: CUserItemMan,
    readonly sessions: CGameSessionTable,
    readonly gameAttr: number,
    private readonly onUsersAttached: (
      socket: CClientSocket,
    ) => void = () => {},
  ) {}
  OnPacket(packet: CReceivedPacketBase, socket: CClientSocket): void {
    if (packet.Decode1() !== ClientRequest.ConnEstablished)
      throw new CProtocolError("Expected connection establishment");
    this.OnConnEstablished(packet, socket);
  }
  OnConnEstablished(packet: CReceivedPacketBase, socket: CClientSocket): void {
    const n = packet.Decode1();
    if (n < UserCount.Minimum || n > UserCount.Maximum || socket.GetUserCount())
      throw new CProtocolError("Invalid connection user count");
    const ids = Array.from({ length: n }, () => ({
      ID: packet.DecodeStr(UserFieldSize.ID),
      GlobalSerialNo: packet.Decode4(),
      GuildSn: packet.Decode4(),
    }));
    const integrity = (packet.Decode4() ^ packet.Decode4()) >>> 0;
    const initialized = packet.Decode1() === 0;
    packet.AssertEnd();
    if (!OpaqueOfficial.FxClientIntegrityXor.includes(integrity))
      throw new CProtocolError("Unrecognized FxClient integrity value");
    // Authenticate the exact pending group BEFORE DB readers/encoding. The
    // exclusive lease does NOT consume/extend the single-use transfer yet.
    const authorization = this.center.AuthorizeConnection(socket, ids);
    try {
      const check = () =>
        this.center.CheckConnectionAuthorization(socket, authorization);
      // Read ONLY pre rows already installed by a trusted service-local caller.
      // This is NOT FxPreInventory SQL / InitPreInventory effects / an award.
      const preRows = this.center.CaptureAuthorizedPreInventory(
        socket,
        authorization,
      );
      if (
        preRows.length !== n ||
        preRows.some(
          (r, i) =>
            NormalizeID(r.ID) !== NormalizeID(ids[i]!.ID) ||
            r.GlobalSerialNo !== ids[i]!.GlobalSerialNo ||
            r.GuildSn !== ids[i]!.GuildSn,
        )
      )
        throw new CProtocolError("Pre-inventory owner mismatch");
      const accounts = ids.map((id) => {
        check();
        const raw = this.db.GetUserInfo(id.ID);
        check();
        return raw ? Object.freeze({ ...raw }) : undefined;
      });
      if (
        accounts.some(
          (a, i) =>
            !a ||
            typeof a.ID !== "string" ||
            NormalizeID(a.ID) !== NormalizeID(ids[i]!.ID) ||
            a.BannedUntil === -1 ||
            a.BannedUntil > Math.floor(Date.now() / 1000),
        )
      )
        throw new CProtocolError("Account not available");
      const inventories = ids.map((id) => {
        check();
        const raw = this.db.LoadInventory(id.ID);
        check();
        const rows = Object.freeze(
          [...raw].map((r) => Object.freeze({ ...r })),
        );
        if (
          rows.some(
            (r) =>
              typeof r.ID !== "string" ||
              NormalizeID(r.ID) !== NormalizeID(id.ID),
          )
        )
          throw new CProtocolError("Inventory owner mismatch");
        return rows;
      });
      // Final live values are separate mutable copies, captured BEFORE codecs.
      // Encoding may not change a DB adapter's returned objects into a different
      // authoritative value after the detached201 has already been prepared.
      const liveAccounts = accounts.map((a) => ({ ...a! })),
        liveInventories = inventories.map((rows) =>
          rows.map((r) => ({ ...r })),
        );
      check();
      // ONE immutable catalog generation is shared by202 and EVERY207 local,
      // even if a codec callback reloads the live manager during preflight.
      const definitions = this.items.CaptureSnapshot(),
        candidates = ids.map((id, i) => {
          const user = new CUser({ ...accounts[i]! }, id.GlobalSerialNo);
          user.m_aInventory = inventories[i]!.map((r) => ({ ...r }));
          user.InstallPreInventory(preRows[i]!.Rows, socket.text);
          check();
          return user;
        }),
        info = new CSendPacket(
          ServerResponse.UserSlotInfo,
          undefined,
          socket.text,
        ).Encode1(this.gameAttr);
      let catalog: CSendPacket | undefined,
        pre: CSendPacket | undefined,
        inventory: CSendPacket | undefined;
      if (!initialized) {
        catalog = new CSendPacket(
          ServerResponse.UserItemList,
          undefined,
          socket.text,
        );
        this.items.PutUserItemList(catalog, definitions);
        check();
      }
      //004089A0..00408A06: ANY pre local =>207 for ALL locals (including empty),
      // and207 forces201 even when the first client was already initialized.
      if (candidates.some((user) => user.GetPreInventoryCount() > 0)) {
        pre = new CSendPacket(
          ServerResponse.PreInventory,
          undefined,
          socket.text,
        ).Encode1(n);
        for (const user of candidates) {
          user.MakePreInventoryPacket(pre, definitions);
          check();
        }
      }
      if (catalog || pre) {
        inventory = new CSendPacket(
          ServerResponse.UserInventory,
          undefined,
          socket.text,
        ).Encode1(n);
        for (const user of candidates) {
          user.MakeUserInventoryPacket(inventory);
          check();
        }
      }
      const users = this.center.ConfirmAuthorizedConnection(
        socket,
        authorization,
      );
      for (const [i, user] of users.entries()) {
        user.m_userInfo = liveAccounts[i]!;
        user.SetLevel();
        user.m_aInventory = liveInventories[i]!;
      }
      users[0]!.m_bClientInitialized = initialized;
      socket.m_nPoolType = "Lobby";
      this.onUsersAttached(socket);
      socket.SendPacket(info);
      if (catalog) socket.SendPacket(catalog);
      if (pre) socket.SendPacket(pre);
      if (inventory) socket.SendPacket(inventory);
      this.sessions.PutAllSessionInfo(socket);
    } finally {
      // A read/encoding failure releases preparation only: source ownership,
      // original pending/deadline and capacity reservation remain retriable.
      this.center.ReleaseConnectionAuthorization(socket, authorization);
    }
  }
}
