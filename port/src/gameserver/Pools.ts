/** CUserPool and CConnectPool — the socket sets, the RTT and hacking
 *  checks, and the client entry (OnConnEstablished → DB login → the
 *  channel pool). */

import { Decode1, Decode4, Encode1, Encode4 } from "../core/BufferManipulator.ts";
import { CReceivedPacket, CSendPacket, CipherDegree, kPacketEncryptedCRC8 } from "../core/Packet.ts";
import { CDBMan } from "../db/DBMan.ts";
import { GS_ClientSend, GS_ReceivedPacket } from "../lib/PacketIDs.ts";
import { MC_ReceivedPacket } from "../lib/S2S.ts";
import { CChannelPool } from "./Chat";
import { CUserItemMan, PreInventory, UserInventory } from "./Rows";
import { CGameSessionTable } from "./SessionTable";
import { CCenterProcess, CMainSystem } from "./System";
import { CGuildTable, CLocalUserTable } from "./Tables";
import { CClientSocket, CUser, GetInfoStr } from "./User";
import { CHANNEL_TYPE_GUILD, FxCLIENT_HASH_A, FxCLIENT_HASH_B, RTT_HASH, RTT_HASH_INV, RTT_MIN_INTERVAL, SOCKET_TIMEOUT } from "./Defs";

// ============================ CUserPool (base) ============================

/** CUserPool — the socket/user set shared by the connect and channel pools. */
export class CUserPool {
  m_setSocket = new Set<CClientSocket>();
  m_setUser = new Set<CUser>();

  /** CUserPool::AddSocket */
  AddSocket(socket: CClientSocket): void {
    this.m_setSocket.add(socket);
  }

  /** CUserPool::DelSocket */
  DelSocket(socket: CClientSocket): void {
    this.m_setSocket.delete(socket);
  }

  /** CUserPool::AddNewSocket — seat the users, then OnAddNewSocket.  The
   *  set insert failing on an already-resident user aborts the whole seat:
   *  the users added so far are erased and the socket is refused (:29641). */
  AddNewSocket(socket: CClientSocket): number {
    const added: CUser[] = [];
    for (const user of socket.m_apUser) {
      if (!user) continue;
      if (this.m_setUser.has(user)) {
        console.error(`[GS] Try to insert already resident user in user room`);
        for (const u of added) this.m_setUser.delete(u);
        return 0;
      }
      this.m_setUser.add(user);
      added.push(user);
    }
    this.AddSocket(socket);
    this.OnAddNewSocket(socket);
    return 1;
  }

  /** CUserPool::DeleteSocket — 0 when a user was not resident. */
  DeleteSocket(socket: CClientSocket): number {
    for (const user of socket.m_apUser) {
      if (user && !this.m_setUser.has(user)) return 0;
    }
    for (const user of socket.m_apUser) {
      if (user) this.m_setUser.delete(user);
    }
    this.OnDeleteSocket(socket);
    this.DelSocket(socket);
    return 1;
  }

  /** CUserPool::OnAddNewSocket — a no-op in the base. */
  OnAddNewSocket(_socket: CClientSocket): void {}

  /** CUserPool::OnDeleteSocket — a no-op in the base. */
  OnDeleteSocket(_socket: CClientSocket): void {}

  /** CUserPool::OnPacket — the 20 RTT fallback with the GS anti-cheat checks. */
  OnPacket(n: CReceivedPacket, socket: CClientSocket): void {
    if (n.Decode1() !== GS_ReceivedPacket.OnEstimateRTT) return;
    const packet = new CSendPacket(GS_ClientSend.OnEstimateRTTRes, CipherDegree.kPacketEncryptedCRC8);
    const rttValue = n.Decode4(); // the client's stamp, echoed verbatim
    const hash = n.Decode4();
    const now = Date.now() & 0x7fffffff;
    packet.Encode4(rttValue);
    packet.Encode4(now);
    const last = socket.m_dwLastRTT;
    socket.m_dwLastRTT = now;
    socket.SendPacket(packet);
    if (last !== 0 && now - last < RTT_MIN_INTERVAL) {
      const name = socket.GetUser(0)?.GetName() ?? socket.bunSocket?.remoteAddress ?? "";
      console.error(`[GS] Hacking Suspected [${name}] : SpeedHack. Disconnect.`);
      socket.PostClosePacket();
      return;
    }
    if (hash !== RTT_HASH && hash !== RTT_HASH_INV) {
      const name = socket.GetUser(0)?.GetName() ?? socket.bunSocket?.remoteAddress ?? "";
      console.error(`[GS] Hacking Suspected [${name}] : Memory Modification. Disconnect. Received Hash Value : [${hash.toString(16)}]`);
      socket.PostClosePacket();
    }
  }

  /** CUserPool::CreateSocketList (FxServer.exe.c:29563) — snapshot the pool
   *  into a broadcast list; fLobbyOnly keeps the lobby-stage sockets only. */
  CreateSocketList(fLobbyOnly: number): CClientSocket[] {
    const list: CClientSocket[] = [];
    for (const socket of this.m_setSocket) {
      if (fLobbyOnly !== 0 && socket.m_nPoolType !== 1) continue;
      list.push(socket);
    }
    return list;
  }

  /** CUserPool::SendAll (FxServer.exe.c:29361) — the FlushModifiedInfo
   *  broadcast: walk the pre-built list, and a not-connected zombie only
   *  leaves the LIST (report + PostClosePacket), never the pool. */
  static SendAll(packet: CSendPacket, sockets: CClientSocket[]): void {
    for (const socket of [...sockets]) {
      if (socket.m_bConnected) {
        socket.SendPacket(packet);
        continue;
      }
      console.error(`[GS] Not connected socket (${socket.bunSocket?.remoteAddress ?? ""}) in user pool. Post Close Packet.`);
      socket.PostClosePacket();
      sockets.splice(sockets.indexOf(socket), 1);
    }
  }

  /** CUserPool::OnTimer (:29605) — every pool bumps the ONE shared BSS
   *  counter each tick (dword_4AF7B8, +2 per CTimerThreadNormal tick) and
   *  the sweep fires at %0x258 — 300 ticks = 120 s with both pools wired. */
  OnTimer(count: number): void {
    if (count % 0x258 === 0) this.DisconnectTimeoutSocket();
  }

  /** CUserPool::DisconnectTimeoutSocket (:29397) — 0x9C40 ms without RTT,
   *  then the count summary Report. */
  DisconnectTimeoutSocket(): void {
    const now = Date.now();
    let count = 0;
    for (const socket of [...this.m_setSocket]) {
      if (now - socket.m_dwIdleTime > SOCKET_TIMEOUT) {
        console.error(`[GS] Disconnect timeout socket (${GetInfoStr(socket)})`);
        socket.PostClosePacket();
        count++;
      }
    }
    if (count > 0) console.log(`[GS] Disconnect time-out users: (${count})`);
  }
}

// ============================ CConnectPool ============================

/** CConnectPool — sockets between TCP accept and the channel move. */
export class CConnectPool extends CUserPool {
  static ms_pInstance: CConnectPool | null = null;

  constructor(public db: CDBMan) {
    super();
    CConnectPool.ms_pInstance = this;
  }

  /** CConnectPool::OnPacket — 7 ConnEstablished, else the RTT fallback. */
  OnPacket(n: CReceivedPacket, socket: CClientSocket): void {
    if (n.Decode1() === GS_ReceivedPacket.OnConnEstablished) this.OnConnEstablished(n, socket);
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
    socket.GetUser(0)!.m_fModifiedClient = n.Decode1() === 0 ? 1 : 0;

    // → center p3 OnConnEstablished [E1 n][n×(EStr, E4 gSN)]
    const p = new CSendPacket(MC_ReceivedPacket.OnConnEstablished);
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
   * [E1 n][n×(E4 gSN, E1 authencode)][E1 flag].  On success the users get
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
        u.m_nPremiumSvrId = flags[i];
        if ((CMainSystem.ms_pInstance!.m_fInventoryDB & 1) !== 0 && !this.InitUserInventory(u)) {
          console.error("[GS] Fatal error: InitUserInventory failed from DB");
          ok = false;
          break;
        }
        if (u.GetGuildSerialNo() > 0) {
          const inserted = CGuildTable.ms_pInstance!.Insert(u.GetGuildSerialNo());
          if (inserted === 0 && CMainSystem.ms_pInstance!.m_nChannelType === CHANNEL_TYPE_GUILD) {
            console.error("[GS] Fatal error: Insert to GuildTable Failed"); // :10610
            const p = new CSendPacket(GS_ClientSend.OnGuildBanRes, CipherDegree.kPacketEncryptedCRC8);
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
          console.error(`[GS] Connection failed from center server(${u.GetName()}:0x${u.m_nGlobalSerialNo.toString(16)})`);
        } else {
          // a vanished user or a DB miss — the quiet Report + close tail
          console.log(`[GS] OnCenterResConnEstablished User[0] [${u.GetName()}].`); // :10722
        }
        u.m_pSocket?.PostClosePacket();
      }
      return;
    }

    // → client 210 [E1 attr]; move the socket into the channel pool.
    const p210 = new CSendPacket(GS_ClientSend.OnEnterGame, CipherDegree.kPacketEncryptedCRC8);
    p210.Encode1(CMainSystem.ms_pInstance!.m_fInventoryDB);
    const socket = users[0]!.m_pSocket!;
    socket.SendPacket(p210);
    if (this.DeleteSocket(socket) !== 0 && CChannelPool.ms_pInstance!.AddNewSocket(socket) !== 0) {
      let sent = false;
      if (users[0]!.m_nFlushCount === 0) {
        const p202 = new CSendPacket(GS_ClientSend.OnUserItemList, CipherDegree.kPacketEncryptedCRC8);
        CUserItemMan.ms_pInstance!.PutUserItemList(p202);
        socket.SendPacket(p202);
        sent = true;
      }
      if (users.some((u) => u && u.m_nPreInventoryCount > 0)) {
        const p207 = new CSendPacket(GS_ClientSend.OnPreInventory, CipherDegree.kPacketEncryptedCRC8);
        p207.Encode1(count);
        for (const u of users) u!.MakePreInventoryPacket(p207);
        socket.SendPacket(p207);
        sent = true;
      }
      if (sent) {
        const p201 = new CSendPacket(GS_ClientSend.OnUserInventory, CipherDegree.kPacketEncryptedCRC8);
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
    const rows = this.db.GetUserInventoryRows(id);
    const now = Date.now();
    for (const row of rows) {
      const item = CUserItemMan.ms_pInstance!.GetUserItem(row.ItemSN);
      if (!item) {
        console.error("[GS] Mismatch: Shop Item Data");
        return false;
      }
      const expired =
        user.m_nLevel >= row.LevelCreated || !row.DateCreated || Number.isNaN(Date.parse(row.DateCreated)) || Date.parse(row.DateCreated) < now;
      if (expired) {
        this.db.prDeleteInventory(id, row.ItemSN);
        continue;
      }
      const inv = new UserInventory();
      inv.ItemSN = row.ItemSN;
      inv.StockSn = row.StockSN;
      inv.Type = item.Type;
      inv.strName = item.strName;
      inv.strAttr = item.strAttr;
      inv.nAttr1 = item.nAttr1;
      inv.nAttr2 = item.nAttr2;
      inv.nAttr3 = item.nAttr3;
      inv.SlotByte = row.Slot;
      inv.Amount = row.Amount;
      inv.Verbose = row.Verbose;
      inv.DateCreated = row.DateCreated ? new Date(row.DateCreated) : null;
      inv.LevelCreated = row.LevelCreated;
      user.AddInventory(inv);
      if (item.Type === 5 && inv.SlotByte !== 0xff) {
        user.m_fPremiumTicket = 1;
        user.m_nPremiumSvrIdx = row.ItemSN;
      }
      if (item.Type === 6 && inv.SlotByte !== 0xff) user.m_nPremiumSvrId = inv.nAttr1;
    }
    return true;
  }

  /** CDBMan::InitPreInventory — the 30 pre-inventory slots. */
  private InitPreInventory(user: CUser): boolean {
    const rows = this.db.GetPreInventoryRows(user.GetName());
    let n = 0;
    for (const row of rows) {
      if (n >= 30) break;
      const item = CUserItemMan.ms_pInstance!.GetUserItem(row.ItemSN);
      if (!item) continue;
      let truncate = 0;
      if (item.Type === 9) {
        this.db.prSetPremiumTicket(user.GetName(), row.ValidityPeriod);
        if (user.m_fPremiumTicket !== 1) {
          CCenterProcess.ms_pInstance?.SendAuthenCode(user.GetGlobalSerialNo(), 1);
        }
        truncate = 1;
      }
      if (item.Type === 101) {
        user.IncDecExp(row.Amount);
        user.SetLevel();
        truncate = 1;
      }
      if (item.Type === 100) {
        user.IncDecMoney(row.Amount);
        truncate = 1;
      }
      if (item.Type === 100 || item.Type === 101) user.DeferFlushModifiedInfo(this.db, 1);
      if (
        this.db.prLoadInventory(row.SN, user.GetName(), row.ItemSN, row.StockSN, row.Slot, row.Amount, row.ValidityPeriod, user.m_nLevel, truncate) !== 0
      ) {
        continue;
      }
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
      n++;
    }
    return true;
  }
}
