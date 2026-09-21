/** A10: FxServer MTUDP delayed startup is owned by the FXGS config. */
import { expect, spyOn, test } from "bun:test";
import { CServerConfig } from "../src/core/ServerConfig.ts";
import { MTUDPServer } from "../src/FXGS/MTUDPServer.ts";
import { MTUDP_UDP_PORT_OFFSET } from "../src/shared/MTUDP.ts";

test("StartupBase retains FXGS ServerPort after the process-wide singleton changes", async () => {
  const game = new CServerConfig([["ServerPort", ""]]);
  game.ParseConfigString("ServerPort 16300");
  const other = new CServerConfig([["ServerPort", ""]]);
  other.ParseConfigString("ServerPort 28000");
  const previous = CServerConfig.ms_pInstance;
  const previousServer = MTUDPServer.ms_pInstance;
  CServerConfig.ms_pInstance = other;

  let options: { hostname?: string; port?: number } | undefined;
  const fakeSocket = { close() {} } as never;
  const udp = spyOn(Bun, "udpSocket").mockImplementation((async (value: typeof options) => {
    options = value;
    return fakeSocket;
  }) as typeof Bun.udpSocket);
  const log = spyOn(console, "log").mockImplementation(() => {});
  const server = new MTUDPServer(() => {}, game);
  try {
    await server.StartupBase();
    expect(options).toMatchObject({ hostname: "0.0.0.0", port: 16_300 + MTUDP_UDP_PORT_OFFSET });
    expect(server.m_nPort).toBe(16_300 + MTUDP_UDP_PORT_OFFSET);
  } finally {
    server.m_nSocket = null;
    server.Cleanup();
    udp.mockRestore();
    log.mockRestore();
    MTUDPServer.ms_pInstance = previousServer;
    CServerConfig.ms_pInstance = previous;
  }
});
