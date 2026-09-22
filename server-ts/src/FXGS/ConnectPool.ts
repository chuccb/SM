/** Native source unit: FX/FxServer/ConnectPool.cpp. */
import { CReceivedPacket, CSendPacket, CipherDegree } from "../core/Packet.ts";
import { INVENTORY_SLOT_NONE, ItemCategory, USER_INVENTORY_LOAD_LIMIT } from "../shared/Item.ts";
import { CDBMan } from "../db/DBMan.ts";
import { S2C_GamePacket, C2S_GameLobbyPacket } from "../protocol/PacketIDs.ts";
import { MC_GameServerSendPacket } from "../protocol/CenterProtocol.ts";
import { CUserPool } from "./UserPool.ts";
import { CChannelPool } from "./ChannelPool.ts";
import { CUserItemMan } from "./ItemMan.ts";
import { PreInventory, UserInventory } from "./Recordsets.ts";
import { CGameSessionTable } from "./GameSessionTable.ts";
import { CCenterProcess } from "./CenterProcess.ts";
import { CMainSystem } from "./MainSystem.ts";
import { CGuildTable } from "./Guild.ts";
import { CLocalUserTable } from "./LocalUserTable.ts";
import type { CClientSocket } from "./ClientSocket.ts";
import type { CUser } from "./User.ts";
import {
  CHANNEL_TYPE_GUILD,
  FxCLIENT_HASH_A,
  FxCLIENT_HASH_B,
  MAX_PRE_INVENTORY_ROWS,
} from "./Defs.ts";
import { RegisterConnectPool } from "./runtime/ClientSocketRuntime.ts";

/** CConnectPool — sockets between TCP accept and the channel move. */
export class CConnectPool extends CUserPool {
  static ms_pInstance: CConnectPool | null = null;

  constructor(public db: CDBMan) {
    super();
    CConnectPool.ms_pInstance = this;
    RegisterConnectPool(this);
  }

  /** CConnectPool::OnPacket — 7 ConnEstablished, else the RTT fallback. */
  override OnPacket(n: CReceivedPacket, socket: CClientSocket): void {
    if (n.Decode1() === C2S_GameLobbyPacket.OnConnEstablished) this.OnConnEstablished(n, socket);
    else {
      n.m_uOffset = 0;
      this.OnPacketFallback(n, socket);
    }
  }

  /** the CUserPool::OnPacket tail of CConnectPool::OnPacket */
  private OnPacketFallback(n: CReceivedPacket, socket: CClientSocket): void {
    super.OnPacket(n, socket);
  }

  /**
   * CConnectPool::OnConnEstablished — packet 7:
   * [E1 n=1|2][n×(EStr name, E4 gSN, E4 guildSN)][E4 x][E4 y][E1 z];
   * x^y must be one of the two client hashes or the client is flagged.
   */
  OnConnEstablished(n: CReceivedPacket, socket: CClientSocket): void {
    const count = n.Decode1();
    if (count !== 1 && count !== 2) {
      console.error("[GS] Connect Established UserNo Invalid");
      socket.PostClosePacket();
      return;
    }
    socket.AddNewUsers(count);
    this.AddNewSocket(socket);
    let i = 0;
    for (; i < count; i++) {
      const user = socket.GetUser(i)!;
      const name = n.DecodeStr();
      const gSN = n.Decode4();
      const guildSN = n.Decode4();
      user.SetName(name);
      user.SetGlobalSerialNo(gSN);
      user.SetGuildSerialNo(guildSN);
      if (CLocalUserTable.ms_pInstance!.Insert(user) === 0) break;
    }
    if (i < count) {
      console.error(`[GS] Cannot insert user to local user table, ${i} th user`);
      for (let j = 0; j < i; j++) CLocalUserTable.ms_pInstance!.Remove(socket.GetUser(j)!);
      socket.PostClosePacket();
      return;
    }
    const x = n.Decode4();
    const y = n.Decode4();
    const hash = (x ^ y) >>> 0;
    if (hash !== FxCLIENT_HASH_A && hash !== FxCLIENT_HASH_B) {
      console.error(`[GS] Red Alert: Modified FxClient (${socket.GetUser(0)!.GetName()}: 0x${hash.toString(16).padStart(8, "0")})!`);
      socket.m_fImpPoint = 1;
    }
    socket.GetUser(0)!.SetClientInitialized(n.Decode1() === 0 ? 1 : 0);

    // → center p3 OnConnEstablished [E1 n][n×(EStr, E4 gSN)]
    const p = new CSendPacket(MC_GameServerSendPacket.OnConnEstablished);
    p.Encode1(count);
    for (let j = 0; j < count; j++) {
      const u = socket.GetUser(j)!;
      p.EncodeStr(u.GetName());
      p.Encode4(u.GetGlobalSerialNo());
    }
    CCenterProcess.ms_pInstance?.SendPacket(p);
  }

  /**
   * CConnectPool::OnCenterResConnEstablished — center packet 2:
   * [E1 n][n×E4 gSN][n×E1 authencode][E1 flag].  On success the users get
   * their DB rows, 210/202(/207)/201 go out and the socket joins the lobby.
   */
  OnCenterResConnEstablished(n: CReceivedPacket): void {
    const count = n.Decode1();
    const serials: number[] = [];
    for (let i = 0; i < count; i++) serials.push(n.Decode4());
    const flags: number[] = [];
    for (let i = 0; i < count; i++) flags.push(n.Decode1());
    const flag = n.Decode1();

    // resolve the users (they must still be in this pool).  The official
    // failure tails split (:10536/:10568/:10718): a vanished user or a DB
    // miss answers the quiet "User[0] [%s]." Report + close; the flag gate
    // reports "Connection failed from center server(...)".
    const users: (CUser | null)[] = [];
    let ok = true;
    let fDbFail = false;
    for (let i = 0; i < count; i++) {
      const u = CLocalUserTable.ms_pInstance!.FindUserFromGlobalSerialNo(serials[i]);
      users.push(u);
      if (!u || !this.m_setUser.has(u)) {
        ok = false;
        break;
      }
    }
    if (ok && flag === 0) ok = false;

    if (ok) {
      for (let i = 0; i < count; i++) {
        const u = users[i]!;
        const info = this.db.prGetUserInfo(u.GetName());
        if (info.retval !== 0) {
          ok = false;
          fDbFail = true;
          break;
        }
        u.account.SN = info.SN;
        u.account.strID = u.GetName();
        u.account.strName = info.Name;
        u.account.Password = info.Password;
        u.account.Email = info.Email;
        u.account.EmailRcv = info.EmailRcv;
        u.account.Gender = info.Gender;
        u.account.Address = info.Address;
        u.account.Tel = info.Tel;
        u.account.Reveal = info.Reveal;
        u.account.Profile = info.Profile;
        u.account.TotalConn = info.TotalConn;
        u.account.Permission = info.Permission;
        u.account.ShopCardNo = info.ShopCardNo;
        u.account.CommunitySvr = info.CommunitySvr;
        u.account.Birthday = info.Birthday;
        u.account.GuildSn = info.GuildSn;
        u.dyn.strID = u.GetName();
        u.dyn.money = info.money;
        u.dyn.exp = info.exp;
        u.dyn.win = info.win;
        u.dyn.draw = info.draw;
        u.dyn.lose = info.lose;
        u.SetLevel();
        u.SetAuthenCode(flags[i]); // native user+2004; NOT the equipped level-icon flag
        if ((CMainSystem.ms_pInstance!.m_fInventoryDB & 1) !== 0 && !this.InitUserInventory(u)) {
          console.error("[GS] Fatal error: InitUserInventory failed from DB");
          ok = false;
          break;
        }
        if (u.GetGuildSerialNo() > 0) {
          const inserted = CGuildTable.ms_pInstance!.Insert(u.GetGuildSerialNo());
          if (inserted === 0 && CMainSystem.ms_pInstance!.m_nChannelType === CHANNEL_TYPE_GUILD) {
            console.error("[GS] Fatal error: Insert to GuildTable Failed"); // :10610
            const p = new CSendPacket(S2C_GamePacket.OnGuildBanRes, CipherDegree.kPacketEncryptedCRC8);
            users[0]!.m_pSocket?.SendPacket(p);
            return;
          }
        }
      }
    }
    if (!ok) {
      const u = users[0];
      if (u) {
        if (flag === 0 && !fDbFail && users.every((x) => x !== null)) {
          console.error(`[GS] Connection failed from center server(${u.GetName()}:0x${u.m_nGlobalSerialNo.toString(16).padStart(8, "0")})`); // %08x
        } else {
          // a vanished user or a DB miss — the quiet Report + close tail
          console.log(`[GS] OnCenterResConnEstablished User[0] [${u.GetName()}].`); // :10722
        }
        u.m_pSocket?.PostClosePacket();
      }
      return;
    }

    // → client 210 [E1 attr]; move the socket into the channel pool.
    const p210 = new CSendPacket(S2C_GamePacket.OnEnableShop, CipherDegree.kPacketEncryptedCRC8);
    p210.Encode1(CMainSystem.ms_pInstance!.m_fInventoryDB);
    const socket = users[0]!.m_pSocket!;
    socket.SendPacket(p210);
    if (this.DeleteSocket(socket) !== 0 && CChannelPool.ms_pInstance!.AddNewSocket(socket) !== 0) {
      let sent = false;
      if (users[0]!.IsClientInitialized() === 0) {
        const p202 = new CSendPacket(S2C_GamePacket.OnUserItemList, CipherDegree.kPacketEncryptedCRC8);
        CUserItemMan.ms_pInstance!.PutUserItemList(p202);
        socket.SendPacket(p202);
        sent = true;
      }
      if (users.some((u) => u && u.m_nPreInventoryCount > 0)) {
        const p207 = new CSendPacket(S2C_GamePacket.OnPreInventory, CipherDegree.kPacketEncryptedCRC8);
        p207.Encode1(count);
        for (const u of users) u!.MakePreInventoryPacket(p207);
        socket.SendPacket(p207);
        sent = true;
      }
      if (sent) {
        const p201 = new CSendPacket(S2C_GamePacket.OnUserInventory, CipherDegree.kPacketEncryptedCRC8);
        p201.Encode1(count);
        for (const u of users) u!.MakeUserInventoryPacket(p201);
        socket.SendPacket(p201);
      }
      // CConnectPool::OnCenterResConnEstablished tail (0x408A57): the entry
      // leaves the socket at the lobby stage (+468 = 1)
      socket.m_nPoolType = 1;
      CGameSessionTable.ms_pInstance!.PutAllSessionInfo(socket);
    } else {
      console.error("[GS] Failed in transferring user to channel pool, close connection");
      socket.PostClosePacket();
    }
  }

  /** CDBMan::InitUserInventory — pre-inventory claims + the live rows. */
  private InitUserInventory(user: CUser): boolean {
    if (!this.InitPreInventory(user)) return false;
    const id = user.GetName();
    let rows: ReturnType<CDBMan["GetUserInventoryRows"]>;
    try { rows = this.db.GetUserInventoryRows(id); }
    catch (error) {
      console.error("[GS] InitUserInventory: failed to open inventory rowset", error);
      return false;
    }
    // Native 0040B09D/0040B192: unknown definitions consume the budget,
    // expired rows do not. A SQL LIMIT or a vector-size limit is not equivalent.
    let counted = 0;
    for (const row of rows) {
      if (counted >= USER_INVENTORY_LOAD_LIMIT) break;
      const item = CUserItemMan.ms_pInstance!.GetUserItem(row.ItemSN);
      if (!item) {
        console.error("[GS] Mismatch: Shop Item Data");
        counted++;
        continue;
      }
      // CRSUserInventory reads a signed SHORT and a BYTE, not JS-wide numbers.
      const levelCreated = (row.LevelCreated << 16) >> 16;
      const dateCreated = row.DateCreated ? new Date(row.DateCreated) : null;
      const expired = user.m_nLevel >= levelCreated || !dateCreated ||
        Number.isNaN(dateCreated.getTime()) || dateCreated.getTime() < Date.now();
      if (expired) {
        // The native loader ignores DeleteInventory's failure result and keeps
        // walking. A SQLite exception must not disconnect an otherwise valid login.
        try { this.db.prDeleteInventory(id, row.ItemSN); }
        catch (error) { console.error("[GS] DeleteInventory failed", error); }
        continue;
      }
      const inv = new UserInventory();
      inv.ItemSN = row.ItemSN;
      inv.StockSn = row.StockSN;
      inv.Type = item.Type;
      inv.strAttr = item.strAttr;
      inv.nAttr1 = item.nAttr1;
      inv.nAttr2 = item.nAttr2;
      inv.nAttr3 = item.nAttr3;
      inv.SlotByte = row.Slot & 0xff;
      inv.Amount = row.Amount;
      inv.Verbose = row.Verbose;
      inv.DateCreated = dateCreated;
      inv.LevelCreated = levelCreated;
      user.AddInventory(inv);
      counted++;
      if (item.Type === ItemCategory.LevelIcon && inv.SlotByte !== INVENTORY_SLOT_NONE) {
        user.SetLevelIcon(1, row.ItemSN);
      }
      if (item.Type === ItemCategory.LevelChanger && inv.SlotByte !== INVENTORY_SLOT_NONE) user.SetFakeLevel(inv.nAttr1);
    }
    return true;
  }

  /** CDBMan::InitPreInventory — the 30 successfully claimed rows. */
  private InitPreInventory(user: CUser): boolean {
    let rows: ReturnType<CDBMan["GetPreInventoryRows"]>;
    try {
      rows = this.db.GetPreInventoryRows(user.GetName());
    } catch (error) {
      console.error("[GS] InitPreInventory: failed to open pre-inventory rowset", error);
      return false;
    }

    let claimed = 0;
    for (const row of rows) {
      if (claimed >= MAX_PRE_INVENTORY_ROWS) break;
      const item = CUserItemMan.ms_pInstance!.GetUserItem(row.ItemSN);
      if (!item) continue;

      let truncateOnly = 0;
      if (item.Type === ItemCategory.PremiumTicket) {
        const ticketSet = this.db.prSetPremiumTicket(user.GetName(), row.ValidityPeriod);
        if (ticketSet !== 0 && user.GetAuthencode() !== 1) {
          CCenterProcess.ms_pInstance?.SendAuthenCode(user.GetGlobalSerialNo(), 1);
        }
        truncateOnly = 1;
      }
      if (item.Type === ItemCategory.Experience) {
        user.IncDecExp(row.Amount);
        user.SetLevel();
        truncateOnly = 1;
      }
      if (item.Type === ItemCategory.Money) {
        user.IncDecMoney(row.Amount);
        truncateOnly = 1;
      }
      if (item.Type === ItemCategory.Money || item.Type === ItemCategory.Experience) {
        user.DeferFlushModifiedInfo(this.db, 1);
      }

      // 0040AEFD adds this row's ValidityLevel to the user's CURRENT level.
      // Unlike Shop purchases, zero is not replaced with the level-2000
      // permanent sentinel on this caller.
      const expiryLevel = (user.m_nLevel + row.ValidityLevel) | 0;
      let loadResult: number;
      try {
        loadResult = this.db.prLoadInventory(
          row.SN,
          user.GetName(),
          row.ItemSN,
          row.StockSN,
          row.Slot,
          row.Amount,
          row.ValidityPeriod,
          expiryLevel,
          truncateOnly,
        );
      } catch (error) {
        console.error("[GS] LoadOnUserInventory failed", error);
        continue;
      }
      // This SQLite stored-procedure adapter follows the repository's
      // zero-on-success convention; only that successful move consumes budget.
      if (loadResult !== 0) continue;

      const pre = new PreInventory();
      pre.SN = row.SN;
      pre.Type = row.Type;
      pre.ItemSn = row.ItemSN;
      pre.StockSn = row.StockSN;
      pre.Slot = row.Slot;
      pre.Amount = row.Amount;
      pre.strAttr = row.strAttr;
      pre.ValidityPeriod = row.ValidityPeriod;
      pre.ValidityLevel = row.ValidityLevel;
      pre.Description = row.Description;
      user.m_apPreInventory[user.m_nPreInventoryCount] = pre;
      user.m_nPreInventoryCount++;
      claimed++;
    }
    return true;
  }
}
