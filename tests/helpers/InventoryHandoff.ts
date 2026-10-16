import { CDBSession } from "../../Common/DB/CDBSession.ts";
import { CSendPacket } from "../../Common/CSendPacket.ts";
import type { ConnectionIdentity } from "../../Center/ConnectionAuthorization.ts";
import type { UserItem } from "../../Common/DB/Rows.ts";
import { OpaqueOfficial, ServerType } from "../../Common/OfficialValues.ts";
import { CDBMan } from "../../FXGS/CDBMan.ts";
import { CConnectPool } from "../../FXGS/CConnectPool.ts";
import { CUserItemMan } from "../../FXGS/CUserItemMan.ts";
import { ChannelFixture } from "./Channel.ts";
import { MemoryClient, Received } from "./Clients.ts";

export const HandoffDefinitions: readonly Readonly<UserItem>[] = Object.freeze(
  [7, 0x80000000].map((SN, i) =>
    Object.freeze({
      SN,
      Category: i ? 100 : 101,
      strAttr: `catalog-attribute${i}`,
      strName: `catalog-name${i}`,
      nAttr1: -7,
      nAttr2: -2147483648,
      nAttr3: 2147483647,
    }),
  ),
);
export function SeedHandoffDefinitions(
  session: CDBSession,
  rows = HandoffDefinitions,
) {
  const q = session.db.query(
    "INSERT INTO FxItem(SN,Category,strAttr,nAttr1,nAttr2,nAttr3,strName) VALUES(?,?,?,?,?,?,?)",
  );
  for (const r of rows)
    q.run(r.SN, r.Category, r.strAttr, r.nAttr1, r.nAttr2, r.nAttr3, r.strName);
}
export function HandoffRequest(
  ids: readonly ConnectionIdentity[],
  initialized = false,
) {
  const p = new CSendPacket(7).Encode1(ids.length);
  for (const id of ids)
    p.EncodeStr(id.ID).Encode4(id.GlobalSerialNo).Encode4(id.GuildSn);
  return p
    .Encode4(0)
    .Encode4(OpaqueOfficial.FxClientIntegrityXor[0]!)
    .Encode1(initialized ? 0 : 1);
}
/** Explicit trusted read-side attachment fixture, NOT native SQL / awards.
 * Real CConnectPool / lease / catalog / schema6 are exercised; transport here
 * is MemoryClient, while separate tests below use real TCP peers. */
export function HandoffFixture(
  options: { Users?: number; GameAttr?: number; Exp?: readonly number[] } = {},
) {
  let now = 1800000000000,
    hook: (() => void) | undefined,
    callbacks = 0;
  const channel = ChannelFixture(() => {
      hook?.();
      return now;
    }),
    session = new CDBSession(":memory:"),
    db = new CDBMan(session),
    source = new MemoryClient(),
    target = new MemoryClient();
  const names = ["First", "Second"].slice(0, options.Users ?? 2);
  for (const [i, ID] of names.entries()) {
    session.db
      .query(
        "INSERT INTO FxUserAccount(ID,UserHashNo,Password) VALUES(?,0,'disabled-test-fixture')",
      )
      .run(ID);
    session.db
      .query("INSERT INTO FxUserDynamic(ID,Money,Exp) VALUES(?,?,?)")
      .run(ID, 37 + i, options.Exp?.[i] ?? (i ? 0 : 250000));
  }
  SeedHandoffDefinitions(session);
  const items = new CUserItemMan(db),
    users = channel.ls.RegisterConnection(
      source,
      names.map((id) => db.GetUserInfo(id)!),
    ),
    ids = users.map((u) => ({
      ID: u.GetName(),
      GlobalSerialNo: u.GetGlobalSerialNo(),
      GuildSn: u.m_userInfo.GuildSn,
    }));
  channel.pool.AddNewSocket(target);
  const connect = new CConnectPool(
    db,
    channel.gs,
    items,
    channel.sessions,
    options.GameAttr ?? 1,
    (socket) => {
      callbacks++;
      channel.pool.InsertRankList(socket);
    },
  );
  const reserved = channel.ls.RequestConnection(source, ServerType.FXGame, 0);
  if (reserved.result !== 1)
    throw new Error("Fixture MUST reserve real Center group");
  const pending = users[0]!.m_pendingConnection!;
  return {
    ...channel,
    session,
    db,
    items,
    users,
    ids,
    source,
    target,
    connect,
    pending,
    tick(ms: number) {
      now += ms;
    },
    clockHook(next?: () => void) {
      hook = next;
    },
    callbacks: () => callbacks,
    run(initialized = false, to = target, group = ids) {
      connect.OnPacket(Received(HandoffRequest(group, initialized)), to);
    },
    close() {
      target.Close();
      source.Close();
      session.Close();
    },
  };
}
export type HandoffEnvironment = ReturnType<typeof HandoffFixture>;
