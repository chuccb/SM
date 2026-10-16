import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:net";
import { CServerApp } from "../CServerApp.ts";
import { ServerType } from "../Common/OfficialValues.ts";
import { TestConfig } from "./helpers/Accounts.ts";
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No TCP address");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
test("HTTP is read-only, accepts preview Host, and readiness explicitly does not mean a complete official server", async () => {
  const config = TestConfig();
  config.Runtime.HealthPort = await freePort();
  const app = new CServerApp(config);
  try {
    expect(app.GetStatus().processReady).toBe(false);
    await app.SetUp();
    const base = `http://127.0.0.1:${app.healthPort}`;
    const status = await fetch(`${base}/readyz`, {
      headers: { Host: "status-preview.e2b.app" },
    });
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toBe("no-store");
    const body = (await status.json()) as ReturnType<CServerApp["GetStatus"]>;
    expect(body.processReady).toBe(true);
    expect(body.completeOfficialRewrite).toBe(false);
    expect(body.officialClientVerified).toBe(false);
    expect(body.centerTransport).toBe("in-process");
    expect(
      body.gameUpdate.every(
        (s) =>
          s.running &&
          s.scope === "ordinary-loading-running-result" &&
          s.scheduledRounds === 0 &&
          s.pendingResults === 0 &&
          s.failedRooms === 0 &&
          s.failedTicks === 0,
      ),
    ).toBe(true);
    expect(
      body.listeners.some(
        (s) => s.service === "Health HTTP" && s.port === app.healthPort,
      ),
    ).toBe(true);
    expect(body.resources.maps).toBe(226);
    expect(body.resources.gameItems).toBe(71);
    expect(body.resources.ships).toBe(10);
    expect(JSON.stringify(body)).not.toContain(config.Runtime.Database);
    const html = await fetch(base);
    expect(html.status).toBe(200);
    expect(html.headers.get("x-frame-options")).toBeNull();
    expect(html.headers.get("content-security-policy")).not.toContain(
      "frame-ancestors 'none'",
    );
    expect(await html.text()).toContain("未完成");
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/healthz`, { method: "POST" })).status).toBe(
      405,
    );
    expect((await fetch(`${base}/api/users`)).status).toBe(404);
    await expect(app.SetUp()).rejects.toThrow("twice");
    expect(app.GetStatus().processReady).toBe(true);
  } finally {
    const a = app.CleanUp();
    expect(app.CleanUp()).toBe(a);
    await a;
  }
  const closed = app.GetStatus();
  expect(closed.processReady).toBe(false);
  expect(closed.gameUpdate.every((s) => !s.running)).toBe(true);
  expect(closed.listeners.every((s) => s.port === 0)).toBe(true);
  expect(() => app.m_dbSession.db.query("SELECT 1").get()).toThrow();
});
test("startup bind failure rolls back LS/GS, offline registration and SQLite exactly once", async () => {
  const config = TestConfig();
  const occupied = createServer();
  await new Promise<void>((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "0.0.0.0", resolve);
  });
  const address = occupied.address();
  if (!address || typeof address === "string")
    throw new Error("No TCP address");
  config.Runtime.HealthPort = address.port;
  const app = new CServerApp(config);
  try {
    await expect(app.SetUp()).rejects.toThrow();
    const state = app.GetStatus();
    expect(state.processReady).toBe(false);
    expect(state.gameUpdate.every((s) => !s.running)).toBe(true);
    expect(state.listeners.every((s) => s.port === 0)).toBe(true);
    expect(
      app.m_center.m_localServerMan.m_aLocalServer.every(
        (s) => !s.m_bConnected,
      ),
    ).toBe(true);
    expect(() => app.m_dbSession.db.query("SELECT 1").get()).toThrow();
    await app.CleanUp();
  } finally {
    await app.CleanUp();
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});

test("GS timer startup failure AFTER online registration rolls back the GS without closing shared SQLite early", async () => {
  const app = new CServerApp(TestConfig());
  const game = app.m_gameServers[0]!;
  const registration = app.m_center.m_localServerMan.GetSvr(
    ServerType.FXGame,
    game.channel.Index,
  )!;
  // Deterministic failure at Start, after TCP listen and online registration.
  // Invoke the GS directly so app.CleanUp cannot mask a missing GS rollback.
  game.m_timerThreadNormal.Stop();
  try {
    await expect(game.SetUp()).rejects.toThrow("after cleanup");
    expect(registration.m_nListenPort).toBeGreaterThan(0);
    expect(registration.m_bConnected).toBe(false);
    expect(game.m_timerThreadNormal.IsRunning()).toBe(false);
    expect(game.m_listenSocket.port).toBe(0);
    expect(game.m_udpServer.port).toBe(0);
    expect(app.m_dbSession.db.query("SELECT 1").get()).not.toBeNull();
  } finally {
    await app.CleanUp();
  }
  expect(() => app.m_dbSession.db.query("SELECT 1").get()).toThrow();
});

async function deadline<T>(
  promise: Promise<T>,
  milliseconds = 4000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Main subprocess timed out")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function started(
  stdout: ReadableStream<Uint8Array>,
  stderr: ReadableStream<Uint8Array>,
) {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done)
        throw new Error(
          `Main exited without a startup record: ${await new Response(stderr).text()}`,
        );
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        const data = JSON.parse(line) as ReturnType<CServerApp["GetStatus"]> & {
          event: string;
        };
        if (data.event === "server-started") return data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`actual Main process: reads custom config, starts all five GS, exits cleanly on ${signal}`, async () => {
    mkdirSync(".analysis/tests", { recursive: true });
    const dir = mkdtempSync(".analysis/tests/main-");
    const configPath = `${dir}/Server.toml`;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const template = readFileSync("Config/Server.toml", "utf8");
      expect(template).toContain('Database = "var/CA.sqlite"');
      expect(template).toContain("HealthPort = 8080");
      // TOML deliberately forbids production port 0. Reserve distinct free ports
      // for LS/five GS, release them, then immediately start the actual process.
      const ports = await Promise.all(
        Array.from({ length: 6 }, () => freePort()),
      );
      expect(new Set(ports).size).toBe(6);
      let portIndex = 0;
      const config = template
        .replace('Database = "var/CA.sqlite"', 'Database = ":memory:"')
        .replace("HealthPort = 8080", "HealthPort = 0")
        .replace(/^Port = \d+$/gm, (line) =>
          portIndex < ports.length ? `Port = ${ports[portIndex++]!}` : line,
        );
      expect(portIndex).toBe(6);
      writeFileSync(configPath, config);
      const process = Bun.spawn(
        [globalThis.process.execPath, "Main.ts", "--config", configPath],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      child = process;
      const status = await deadline(started(process.stdout, process.stderr));
      expect(status.processReady).toBe(true);
      expect(status.completeOfficialRewrite).toBe(false);
      expect(status.officialClientVerified).toBe(false);
      expect(status.runtime.bun).toBe("1.4.3");
      expect(status.listeners.length).toBe(6);
      expect(status.listeners.every((s) => s.port > 0)).toBe(true);
      expect(status.gameUpdate.length).toBe(5);
      expect(
        status.gameUpdate.every(
          (s) => s.running && s.scheduledRounds === 0 && s.pendingResults === 0,
        ),
      ).toBe(true);
      expect(status.resources.maps).toBe(226);
      process.kill(signal);
      expect(await deadline(process.exited)).toBe(0);
      expect(await new Response(process.stderr).text()).toContain(
        "INCOMPLETE PORT",
      );
    } finally {
      if (child && child.exitCode === null) {
        child.kill("SIGKILL");
        await deadline(child.exited);
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10000);
}
