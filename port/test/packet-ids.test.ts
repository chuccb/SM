/** Protocol registry regression tests: wire contexts must never collapse reused ids. */
import { describe, expect, test } from "bun:test";
import {
  BILLING_PACKET_LOG_CONTEXT,
  BNB_TAIWAN_PacketFamily,
  C2S_GameChatPacket,
  GS_CLIENT_SEND_NAMES,
  C2S_LoginPacket,
  PACKET_NAME_TABLES,
  PacketIdDescriptor,
  PacketIdName,
  Shop2Billing_TwPacket,
} from "../src/protocol/PacketIDs.ts";
import {
  CM_GameServerPacket,
  CM_LoginServerPacket,
  CM_PACKET_NAMES_BY_SERVER_CLASS,
  CM_ShopServerPacket,
  CM_UtilServerPacket,
  LOCALSOCKET_SEQ,
  LOCALSOCKET_SEQ_DELTA,
  MC_DISPATCH_NAMES_BY_SERVER_CLASS,
  MC_GameServerSendPacket,
  MC_PACKET_NAMES_BY_SERVER_CLASS,
  MC_ShopServerSendPacket,
  MONITOR_HEADER_CODE_MODIFIER,
  MONITOR_HEADER_CODE_RCV,
  MONITOR_HEADER_CODE_SND,
  MONITOR_SEQ,
  MONITOR_SEQ_DELTA,
  SVRCLASS_GAME,
  SVRCLASS_LOGIN,
  SVRCLASS_SHOP,
  SVRCLASS_UTIL,
} from "../src/protocol/CenterProtocol.ts";
import { STANDARD_PACKET_OPCODE_BYTES, TAIWAN_BILLING_OPCODE_BYTES } from "../src/protocol/PacketNames.ts";

function ids(record: Readonly<Record<string, number>>): number[] {
  return [...new Set(Object.values(record))].sort((a, b) => a - b);
}
function registeredIds(serverClass: number, dispatch = false): number[] {
  const table = (dispatch ? MC_DISPATCH_NAMES_BY_SERVER_CLASS : MC_PACKET_NAMES_BY_SERVER_CLASS)[serverClass]!;
  return Object.keys(table.names).map(Number).sort((a, b) => a - b);
}

describe("nPacketType context registry", () => {
  test("the same numeric id resolves by socket, direction and dispatch context", () => {
    expect(PacketIdName("LS", "recv", 1)).toBe("OnAskMultiServer");
    expect(PacketIdName("LS", "send", 1)).toBe("OnAskMultiServerRes");
    expect(PacketIdName("GS", "recv", 25)).toBe("OnChatMsg");
    expect(PacketIdName("GS", "send", 25)).toBe("OnChatMsg");
    expect(PacketIdName("Shop", "recv", 205)).toBe("RequestRemainCashTw");
    expect(PacketIdName("Shop", "send", 205)).toBe("OnStringTable");
    expect(PacketIdName("MON", "recv", 1)).toBe("OnRequestSvrState");
    expect(PacketIdName("MON", "send", 1)).toBe("OnRequestSvrState");
    expect(PacketIdName("GS", "recv", 208)).toBeNull();
    expect(PacketIdName("missing", "recv", 1)).toBeNull();
  });

  test("CChatPool is a top-level inherited dispatch, not a nested packet family", () => {
    expect(Object.values(C2S_GameChatPacket).sort((a, b) => a - b))
      .toEqual([25, 26, 27, 29, 30, 31, 71, 216]);
    expect(PACKET_NAME_TABLES.GS.recv).toHaveLength(3);
    const chat = PacketIdDescriptor("GS", "recv", C2S_GameChatPacket.OnSystemCmd)!;
    expect(chat).toMatchObject({
      family: "enGameServerPacket",
      direction: "client-to-server",
      context: "FxServer::CChatPool",
      opcodeBytes: STANDARD_PACKET_OPCODE_BYTES,
      canonicalName: "OnSystemCmd",
    });
  });

  test("aliases remain visible without changing the canonical construction-site name", () => {
    expect(GS_CLIENT_SEND_NAMES.names[25]).toEqual({
      canonicalName: "OnChatMsg",
      aliases: ["OnItemMsg"],
      containsCredentials: false,
    });
    expect(GS_CLIENT_SEND_NAMES.names[26]).toEqual({
      canonicalName: "OnKickoffUser",
      aliases: ["OnAdminNotifyMsg"],
      containsCredentials: false,
    });
  });

  test("opcode width and credential metadata follow each wire context", () => {
    expect(PacketIdDescriptor("LS", "recv", C2S_LoginPacket.OnLogin))
      .toMatchObject({ canonicalName: "OnLogin", containsCredentials: true });
    expect(PacketIdDescriptor("LS", "recv", C2S_LoginPacket.OnNewUser))
      .toMatchObject({ canonicalName: "OnNewUser", containsCredentials: true });
    expect(TAIWAN_BILLING_OPCODE_BYTES).toBe(4);
    expect(PacketIdDescriptor(BILLING_PACKET_LOG_CONTEXT.Taiwan, "send", Shop2Billing_TwPacket.RequestDigiQAuthorization))
      .toMatchObject({
        family: "enGeneralServerPacket", opcodeBytes: 4, containsCredentials: true,
        canonicalName: "RequestDigiQAuthorization",
      });
    expect(PacketIdDescriptor(BILLING_PACKET_LOG_CONTEXT.Billing, "send", 7))
      .toMatchObject({
        family: "enBillingPacket", opcodeBytes: 1, containsCredentials: false,
        canonicalName: "RequestGift",
      });
    expect(PacketIdDescriptor(BILLING_PACKET_LOG_CONTEXT.Coupon, "send", 0))
      .toMatchObject({
        family: "enCouponPacket", opcodeBytes: 1, containsCredentials: true,
        canonicalName: "RequestCheckCoupon",
      });
    expect(BNB_TAIWAN_PacketFamily).toEqual({ Billing: 0, Coupon: 1 });
    expect(PacketIdDescriptor(BILLING_PACKET_LOG_CONTEXT.Billing, "recv", 7)).toBeNull();
    expect(PacketIdDescriptor(BILLING_PACKET_LOG_CONTEXT.Coupon, "recv", 0)).toBeNull();
  });
});

describe("MC/CM class-aware protocol", () => {
  test("local and monitor links retain their independent fixed-code framing", () => {
    expect([LOCALSOCKET_SEQ, LOCALSOCKET_SEQ_DELTA]).toEqual([40, 0]);
    expect([
      MONITOR_HEADER_CODE_RCV,
      MONITOR_HEADER_CODE_SND,
      MONITOR_HEADER_CODE_MODIFIER,
      MONITOR_SEQ,
      MONITOR_SEQ_DELTA,
    ]).toEqual([102, 102, 231, 0, 0]);
  });

  test("center receive subsets exactly match each native derived OnPacket", () => {
    expect(registeredIds(SVRCLASS_LOGIN, true)).toEqual([0, 1, 2, 3, 100]);
    expect(registeredIds(SVRCLASS_GAME, true)).toEqual([1, 2, 3, 4, 7, 10, 11]);
    expect(registeredIds(SVRCLASS_SHOP, true)).toEqual([1, 2, 3, 4, 7, 9]);
    expect(registeredIds(SVRCLASS_UTIL, true)).toEqual([1, 2, 3, 4, 5, 7, 10, 11]);
  });

  test("GS MC 9 is a real send site but remains rejected by CGameServer dispatch", () => {
    expect(MC_GameServerSendPacket.SendAuthenCode).toBe(9);
    expect(MC_PACKET_NAMES_BY_SERVER_CLASS[SVRCLASS_GAME]!.names[9]?.canonicalName).toBe("SendAuthenCode");
    expect(MC_DISPATCH_NAMES_BY_SERVER_CLASS[SVRCLASS_GAME]!.names[9]).toBeUndefined();
    expect(MC_ShopServerSendPacket.SendAuthenCode).toBe(9);
    expect(MC_DISPATCH_NAMES_BY_SERVER_CLASS[SVRCLASS_SHOP]!.names[9]?.canonicalName).toBe("OnSetAuthenCode");
  });

  test("center-to-local registries expose only the destination class's CM subset", () => {
    expect(Object.keys(CM_PACKET_NAMES_BY_SERVER_CLASS)).toEqual(["1", "10", "11", "99"]);
    expect(ids(CM_LoginServerPacket)).toEqual([0, 1, 2, 3, 4, 5, 7, 8, 11, 13]);
    expect(ids(CM_GameServerPacket)).toEqual([1, 2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14]);
    expect(ids(CM_ShopServerPacket)).toEqual([1, 2, 6, 8, 12, 14]);
    expect(ids(CM_UtilServerPacket)).toEqual([8, 10, 12]);
    expect(CM_PACKET_NAMES_BY_SERVER_CLASS[SVRCLASS_LOGIN]!.names[14]).toBeUndefined();
    expect(CM_PACKET_NAMES_BY_SERVER_CLASS[SVRCLASS_SHOP]!.names[6]?.canonicalName).toBe("OnShopServerInfo");
  });
});
