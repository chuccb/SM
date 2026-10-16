import type { _USERINFO } from "../../Common/DB/Rows.ts";
import { CServerConfig } from "../../Common/CServerConfig.ts";
export function UserInfo(
  ID: string,
  extra: Partial<_USERINFO> = {},
): _USERINFO {
  return {
    SID: 1,
    ID,
    UserHashNo: 0,
    Name: ID,
    Email: "",
    EmailRcv: 0,
    Gender: 0,
    Address: "",
    Tel: "",
    Reveal: 0,
    Profile: "",
    PasswordQ: "",
    IdentityNo: "",
    Birthday: "",
    CommunitySvr: 0,
    GuildSn: 0,
    Authority: 0,
    TotalConn: 0,
    LastConn: null,
    CreatedAt: 0,
    BannedUntil: 0,
    Money: 0,
    Exp: 0,
    Win: 0,
    Draw: 0,
    Lose: 0,
    TicketDate: 0,
    ...extra,
  };
}
export function TestConfig() {
  const config = CServerConfig.Load();
  config.Runtime.Database = ":memory:";
  config.Runtime.HealthPort = 0;
  config.LS.Port = 0;
  config.FXGS.Channels = [
    { ...config.FXGS.Channels[0]!, Index: 0, Port: 0, MaxUser: 8, Type: 0 },
  ];
  return config;
}
