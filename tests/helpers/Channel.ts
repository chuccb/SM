import { CCenterServer } from "../../Center/CCenterServer.ts";
import { CCenterProcess } from "../../Common/CCenterProcess.ts";
import { CTextCodec } from "../../Common/CTextCodec.ts";
import { ChannelType, ServerType } from "../../Common/OfficialValues.ts";
import { CChannelCache } from "../../LS/CChannelCache.ts";
import { CChannelPool } from "../../FXGS/CChannelPool.ts";
import { CGameSessionTable } from "../../FXGS/CGameSessionTable.ts";
import { ResultResources } from "./GameResult.ts";
import { TestConfig } from "./Accounts.ts";

export function ChannelFixture(clock?: () => number) {
  const config = TestConfig(),
    center = new CCenterServer(config, clock),
    text = new CTextCodec();
  for (const server of center.m_localServerMan.m_aLocalServer)
    server.m_bConnected = true;
  const ls = new CCenterProcess(
    center,
    center.m_localServerMan.GetSvr(ServerType.Login, 0)!,
  );
  const gs = new CCenterProcess(
    center,
    center.m_localServerMan.GetSvr(ServerType.FXGame, 0)!,
  );
  const cache = new CChannelCache(config, center, text);
  const sessions = new CGameSessionTable(
    text,
    ResultResources.bombers,
    ResultResources.maps,
    ChannelType.Normal,
    () => {},
  );
  const pool = new CChannelPool(sessions, gs, cache);
  return { config, center, ls, gs, cache, sessions, pool };
}
