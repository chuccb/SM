import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isIPv4 } from "node:net";
import type { LegacyEncoding } from "./CTextCodec.ts";
import { CTextCodec } from "./CTextCodec.ts";
import { GameUDPFormat } from "./OfficialValues.ts";
import { RuntimePolicy } from "./RuntimePolicy.ts";

export interface GameServerConfig {
  Index: number;
  Name: string;
  Port: number;
  MaxUser: number;
  Type: number;
  LevelLimit: number;
  Community: number;
  EnterableType: number;
}
export interface ServerConfig {
  Runtime: {
    Host: string;
    AdvertisedIP: string;
    Database: string;
    Encoding: LegacyEncoding;
    Resources: string;
    Registration: boolean;
    HealthPort: number;
  };
  LS: { Port: number; Greetings: string[] };
  FXGS: { Channels: GameServerConfig[]; UDPEnabled: boolean };
  FXSS: { Ports: number[] };
  Relay: { Enabled: boolean; Port: number };
}
function object(
  value: unknown,
  name: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid config section ${name}`);
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result))
    if (!keys.includes(key))
      throw new Error(`Unknown config key ${name}.${key}`);
  return result;
}
function integer(
  o: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number {
  const n = o[key];
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < min || n > max)
    throw new Error(`Invalid config ${key}: expected ${min}..${max}`);
  return n;
}
function string(o: Record<string, unknown>, key: string): string {
  const n = o[key];
  if (typeof n !== "string" || !n.length || n.includes("\0"))
    throw new Error(`Invalid config string ${key}`);
  return n;
}
function boolean(o: Record<string, unknown>, key: string): boolean {
  const n = o[key];
  if (typeof n !== "boolean") throw new Error(`Invalid config boolean ${key}`);
  return n;
}
function port(n: unknown): number {
  return integer({ port: n }, "port", 1, 65535);
}
/** Validated modern deployment format. It does not execute old .cfg commands. */
export class CServerConfig {
  static Load(path = "Config/Server.toml"): ServerConfig {
    const root = object(Bun.TOML.parse(readFileSync(path, "utf8")), "root", [
      "Runtime",
      "LS",
      "FXGS",
      "FXSS",
      "Relay",
    ]);
    const runtime = object(root.Runtime, "Runtime", [
      "Host",
      "AdvertisedIP",
      "Database",
      "Encoding",
      "Resources",
      "Registration",
      "HealthPort",
    ]);
    const ls = object(root.LS, "LS", ["Port", "Greetings"]);
    const gs = object(root.FXGS, "FXGS", ["Channels", "UDPEnabled"]);
    const ss = object(root.FXSS, "FXSS", ["Ports"]);
    const relay = object(root.Relay, "Relay", ["Enabled", "Port"]);
    const host = string(runtime, "Host");
    if (!isIPv4(host))
      throw new Error(
        "Runtime.Host must be an IPv4 bind address (use 0.0.0.0 for all interfaces)",
      );
    const ip = string(runtime, "AdvertisedIP");
    if (!isIPv4(ip) || ip === "0.0.0.0")
      throw new Error(
        "Runtime.AdvertisedIP must be a reachable IPv4 address, not 0.0.0.0",
      );
    const encoding = string(runtime, "Encoding") as LegacyEncoding;
    if (!["big5", "cp949", "gb18030", "utf8"].includes(encoding))
      throw new Error("Invalid Runtime.Encoding");
    if (
      !Array.isArray(gs.Channels) ||
      gs.Channels.length < 1 ||
      gs.Channels.length > 255
    )
      throw new Error("Expected 1..255 FXGS.Channels");
    const codec = new CTextCodec(encoding);
    const channels = gs.Channels.map(
      (value: unknown, index: number): GameServerConfig => {
        const c = object(value, `FXGS.Channels[${index}]`, [
          "Name",
          "Port",
          "MaxUser",
          "Type",
          "LevelLimit",
          "Community",
          "EnterableType",
        ]);
        const Name = string(c, "Name");
        codec.AssertSize(Name, 32, "channel name", 1);
        return {
          Index: index,
          Name,
          Port: port(c.Port),
          MaxUser: integer(c, "MaxUser", 1, RuntimePolicy.MaxPlayersPerChannel),
          Type: integer(c, "Type", 0, 255),
          LevelLimit: integer(c, "LevelLimit", 0, 65535),
          Community: integer(c, "Community", 0, 255),
          EnterableType: integer(c, "EnterableType", 0, 255),
        };
      },
    );
    if (!Array.isArray(ss.Ports) || ss.Ports.length > 255)
      throw new Error("Invalid FXSS.Ports");
    if (
      !Array.isArray(ls.Greetings) ||
      !ls.Greetings.length ||
      !ls.Greetings.every((v: unknown) => typeof v === "string")
    )
      throw new Error("LS.Greetings must be non-empty strings array");
    const greetings = ls.Greetings as string[];
    for (const greeting of greetings)
      codec.AssertSize(greeting, RuntimePolicy.MaxGreetingBytes, "greeting", 1);
    const database = string(runtime, "Database");
    const config: ServerConfig = {
      Runtime: {
        Host: host,
        AdvertisedIP: ip,
        Database: database === ":memory:" ? database : resolve(database),
        Encoding: encoding,
        Resources: resolve(string(runtime, "Resources")),
        Registration: boolean(runtime, "Registration"),
        HealthPort: integer(runtime, "HealthPort", 0, 65535),
      },
      LS: { Port: port(ls.Port), Greetings: greetings },
      FXGS: {
        Channels: channels,
        UDPEnabled:
          gs.UDPEnabled === undefined ? false : boolean(gs, "UDPEnabled"),
      },
      FXSS: { Ports: ss.Ports.map(port) },
      Relay: { Enabled: boolean(relay, "Enabled"), Port: port(relay.Port) },
    };
    const ports = [
      config.LS.Port,
      ...channels.map((c) => c.Port),
      ...config.FXSS.Ports,
      ...(config.Relay.Enabled ? [config.Relay.Port] : []),
      ...(config.Runtime.HealthPort ? [config.Runtime.HealthPort] : []),
    ];
    if (new Set(ports).size !== ports.length)
      throw new Error("Duplicate listening ports in configuration");
    if (config.FXGS.UDPEnabled) {
      const udpPorts = channels.map(
        (channel) => channel.Port + GameUDPFormat.PortOffset,
      );
      if (udpPorts.some((p) => p > 65535))
        throw new Error("FXGS UDP requires TCP port <= 65534");
      if (config.Relay.Enabled) udpPorts.push(config.Relay.Port);
      if (new Set(udpPorts).size !== udpPorts.length)
        throw new Error("Duplicate UDP listening ports in configuration");
    }
    return config;
  }
}
