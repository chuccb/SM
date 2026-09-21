/** Center app ownership and Bun-resource lifecycle regressions. */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { CCxCenterApp } from "../src/Center/CxCenterApp.ts";
import { CLoginServerApp } from "../src/LS/LoginServerApp.ts";
import { CFxServerApp } from "../src/FXGS/FxServerApp.ts";
import { CFxShopApp } from "../src/FXSS/FxShopApp.ts";
import { CUtilServerApp } from "../src/FXUS/UtilServerApp.ts";
import { CCxRelayApp } from "../src/Relay/CxRelayApp.ts";
import type { CServerConfig } from "../src/core/ServerConfig.ts";

function EmptyCenterConfig(): CServerConfig {
  return {
    GetNumAttribute: (key: string) => key === "CenterPort" ? 24_848 : 0,
    GetAttribute: () => "",
  } as unknown as CServerConfig;
}

afterEach(() => mock.restore());

describe("CCxCenterApp resource ownership", () => {
  test("CleanUp stops both listeners and the timer exactly once in native order", () => {
    const calls: string[] = [];
    const monitorStop = mock((_force?: boolean) => { calls.push("monitor"); });
    const centerStop = mock((_force?: boolean) => { calls.push("center"); });
    const listeners = [
      { stop: monitorStop },
      { stop: centerStop },
    ] as unknown as Bun.TCPSocketListener[];

    const listen = spyOn(Bun, "listen").mockImplementation(
      (() => listeners.shift()!) as unknown as typeof Bun.listen,
    );
    const unref = mock(() => {});
    const timer = { unref } as unknown as ReturnType<typeof setInterval>;
    spyOn(globalThis, "setInterval").mockImplementation(
      (() => timer) as typeof setInterval,
    );
    const clear = spyOn(globalThis, "clearInterval").mockImplementation((handle) => {
      expect(handle).toBe(timer);
      calls.push("timer");
    });
    spyOn(console, "log").mockImplementation(() => {});

    const app = new CCxCenterApp(EmptyCenterConfig());
    app.SetUp();

    expect(listen).toHaveBeenCalledTimes(2);
    expect(unref).toHaveBeenCalledTimes(1);

    app.CleanUp();
    app.CleanUp();

    expect(calls).toEqual(["center", "monitor", "timer"]);
    expect(centerStop).toHaveBeenCalledWith(true);
    expect(monitorStop).toHaveBeenCalledWith(true);
    expect(centerStop).toHaveBeenCalledTimes(1);
    expect(monitorStop).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
  });
});

describe("service app cleanup ownership", () => {
  test("each app releases active Bun resources in its native prefix order", () => {
    const calls: string[] = [];
    const call = (name: string) => () => { calls.push(name); };

    const login = Object.assign(Object.create(CLoginServerApp.prototype), {
      listenThread: { Stop: call("ls-listener") },
      mtudpServer: {
        m_dispatcher: { Terminate: call("ls-dispatcher") },
        Cleanup: call("ls-udp"),
      },
      timerThread: { Stop: call("ls-timer") },
      centerProcess: { Stop: call("ls-center") },
      db: { Close: call("ls-db") },
      loginPool: null,
    }) as CLoginServerApp;
    login.CleanUp();
    expect(calls.splice(0)).toEqual([
      "ls-listener", "ls-dispatcher", "ls-udp", "ls-timer", "ls-center", "ls-db",
    ]);

    const game = Object.assign(Object.create(CFxServerApp.prototype), {
      listenThread: { Stop: call("gs-listener") },
      udpDispatcher: { Terminate: call("gs-dispatcher") },
      mtudpServer: { Cleanup: call("gs-udp") },
      timerThreadNormal: { Stop: call("gs-timer-normal") },
      timerThreadTimeCritical: { Stop: call("gs-timer-critical") },
      centerProcess: { Stop: call("gs-center") },
      db: { Close: call("gs-db") },
    }) as CFxServerApp;
    game.CleanUp();
    expect(calls.splice(0)).toEqual([
      "gs-listener", "gs-dispatcher", "gs-udp", "gs-timer-normal",
      "gs-timer-critical", "gs-center", "gs-db",
    ]);

    const shop = Object.assign(Object.create(CFxShopApp.prototype), {
      listenThread: { Stop: call("shop-listener") },
      listenExThread: { Stop: call("shop-web-listener") },
      timerThread: { Stop: call("shop-timer") },
      billing: { Stop: call("shop-billing") },
      center: { Stop: call("shop-center") },
      db: { Close: call("shop-db") },
    }) as CFxShopApp;
    shop.CleanUp();
    expect(calls.splice(0)).toEqual([
      "shop-listener", "shop-web-listener", "shop-timer",
      "shop-billing", "shop-center", "shop-db",
    ]);

    const util = Object.assign(Object.create(CUtilServerApp.prototype), {
      listenThread: { Stop: call("util-listener") },
      timerThread: { Stop: call("util-timer") },
      centerProcess: { Stop: call("util-center") },
      mainPool: null,
      localUserTable: null,
      mainSystem: null,
    }) as CUtilServerApp;
    util.CleanUp();
    expect(calls.splice(0)).toEqual(["util-listener", "util-timer", "util-center"]);

    const relay = Object.assign(Object.create(CCxRelayApp.prototype), {
      server: { Cleanup: call("relay-udp") },
      dispatcher: { Terminate: call("relay-dispatcher") },
      timerThread: { Stop: call("relay-timer") },
    }) as CCxRelayApp;
    relay.CleanUp();
    expect(calls).toEqual(["relay-udp", "relay-dispatcher", "relay-timer"]);
  });
});
