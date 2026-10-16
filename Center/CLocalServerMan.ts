import { CLocalServer } from "./CLocalServer.ts";
import { ServerType } from "../Common/OfficialValues.ts";
import type { ServerConfig } from "../Common/CServerConfig.ts";

export class CLocalServerMan {
  readonly m_aLocalServer: CLocalServer[] = [];
  constructor(config: ServerConfig) {
    this.m_aLocalServer.push(
      new CLocalServer(ServerType.Login, 0, "Login-0", config.LS.Port, 2048),
    );
    for (const c of config.FXGS.Channels)
      this.m_aLocalServer.push(
        new CLocalServer(
          ServerType.FXGame,
          c.Index,
          c.Name,
          c.Port,
          c.MaxUser,
          c.Type,
        ),
      );
    for (const [i, p] of config.FXSS.Ports.entries())
      this.m_aLocalServer.push(
        new CLocalServer(ServerType.FXShop, i, `FxShop-${i}`, p, 2048),
      );
  }
  GetSvr(type: number, index: number): CLocalServer | undefined {
    return this.m_aLocalServer.find(
      (s) => s.m_nServerType === type && s.m_nIdx === index,
    );
  }
  GetSvrNo(type: number): number {
    return this.m_aLocalServer.filter((s) => s.m_nServerType === type).length;
  }
}
