/** Port-only local billing server; this is not an original Crazy Arcade binary unit. */
import { CBillingSocketTw } from "../FXSS/BillingSocket.ts";
import { CSendPacket } from "../FXSS/Packet.ts";
import type { CDBMan } from "../db/DBMan.ts";
import { Shop2Billing_TwPacket as Request, Billing2Shop_TwPacket as Reply, TW_BILLING_SEND_NAMES, TW_BILLING_RECEIVED_NAMES } from "../protocol/PacketIDs.ts";
import { PacketLog } from "../core/PacketLog.ts";
import type { CReceivedPacket } from "../core/Packet.ts";
import { BillingReader, purchaseReply, string8 } from "./Protocol.ts";
import { BillingStore } from "./Store.ts";
import { BILLING_GAME, BILLING_ERROR, BillingError, BILLING_IDLE_SECONDS, MAX_BILLING_FRAME, MAX_BILLING_PEERS, type BillingConfig } from "./Defs.ts";

const AUTH_FAILURE_WINDOW_MS = 60_000;
const MAX_AUTH_FAILURES_PER_ACCOUNT = 10;
const MAX_AUTH_FAILURE_KEYS = 1024;
const HELLO_TIMEOUT_SECONDS = 10;

interface Peer { wire: CBillingSocketTw; world: number | null }
/** A locally trusted Shop peer, NOT a public payment gateway. Tw has no TLS
 * or server-authentication field. Binding outside loopback is disallowed.
 */
export class BillingServer {
  private listener: Bun.TCPSocketListener<Peer> | null = null;
  private peers = new Set<Bun.Socket<Peer>>();
  private authFailures = new Map<string, { count: number; since: number }>();
  constructor(readonly store: BillingStore) {
    PacketLog.Register("LOCALBILL", "recv", TW_BILLING_SEND_NAMES);
    PacketLog.Register("LOCALBILL", "send", TW_BILLING_RECEIVED_NAMES);
  }
  get port(): number { return this.listener?.port ?? 0; }
  listen(host = "127.0.0.1", port = 0): void {
    if (host !== "127.0.0.1") throw new BillingError("Local billing must bind to loopback; Tw is not an Internet-safe protocol.");
    this.listener = Bun.listen<Peer>({
      hostname: host, port,
      socket: {
        open: transport => {
          if (this.peers.size >= MAX_BILLING_PEERS) { transport.end(); return; }
          const peer: Peer = {
            wire: new CBillingSocketTw(false, { onPacket: (_wire, packet) => this.receive(peer, packet) }),
            world: null,
          };
          peer.wire.m_nMaxPacketLen = MAX_BILLING_FRAME;
          peer.wire.m_szLogTag = "Billing";
          peer.wire.m_szLogTable = "LOCALBILL";
          peer.wire.bunSocket = transport as unknown as Bun.Socket;
          peer.wire.m_bConnected = true;
          transport.data = peer;
          transport.timeout(HELLO_TIMEOUT_SECONDS); // greeting deadline; unauthenticated peers cannot pin slots
          this.peers.add(transport);
        },
        data: (transport, bytes) => transport.data?.wire.OnReceive(bytes),
        drain: transport => transport.data?.wire.Flush(),
        close: transport => { transport.data?.wire.Close(); this.peers.delete(transport); },
        timeout: transport => { transport.end(); },
        error: transport => { transport.end(); },
      },
    });
  }
  close(): void {
    for (const peer of this.peers) { peer.data.wire.Close(); peer.terminate(); }
    this.peers.clear();
    this.listener?.stop(true); this.listener = null;
  }
  private receive(peer: Peer, packet: CReceivedPacket): void {
    try {
      const n = new BillingReader(packet.m_pBlock.subarray(0, packet.m_uLength));
      const id = n.u32();
      if (id === Request.OnConnEstablished) {
        const game = n.u32(), world = n.u32(); n.end();
        if (peer.world !== null || game !== BILLING_GAME) throw new BillingError("Invalid billing hello");
        peer.world = world;
        peer.wire.bunSocket?.timeout(BILLING_IDLE_SECONDS);
        return; // native does not require a 332 reply
      }
      if (peer.world === null) throw new BillingError("Billing hello required");
      if (id === Request.TwRequestRTT) {
        const token = n.u8(); n.end();
        const p = new CSendPacket(Reply.OnTwRTT); p.Encode1(token); peer.wire.SendPacket(p);
      } else if (id === Request.RequestDigiQAuthorization) {
        const account = n.string(), password = n.string(), name = n.string(); n.end();
        if (name.length > 32) throw new BillingError("Character name exceeds native response buffer");
        const p = new CSendPacket(Reply.OnDigiQAuthen);
        try {
          const now = Date.now();
          for (const [key, failed] of this.authFailures) if (now - failed.since >= AUTH_FAILURE_WINDOW_MS) this.authFailures.delete(key);
          const failed = this.authFailures.get(account);
          if ((failed?.count ?? 0) >= MAX_AUTH_FAILURES_PER_ACCOUNT || (!failed && this.authFailures.size >= MAX_AUTH_FAILURE_KEYS))
            throw new BillingError(BILLING_ERROR.authorization);
          let wallet;
          try { wallet = this.store.authorize(account, password, name, peer.world); }
          catch (error) {
            this.authFailures.set(account, { count: (failed?.count ?? 0) + 1, since: failed?.since ?? now });
            throw error;
          }
          this.authFailures.delete(account);
          p.Encode4(wallet.SID); p.Encode4(wallet.BID); string8(p, name); p.Encode4(0);
        } catch {
          p.Encode4(0); p.Encode4(0); string8(p, name); p.Encode4(1); string8(p, BILLING_ERROR.authorization);
        }
        peer.wire.SendPacket(p);
      } else if (id === Request.RequestRemainCashTw || id === Request.RequestPurchaseTw) {
        const sid = n.u32(); n.u32(); // BID; authorization is by explicitly verified character/world, not spoofable IDs
        const game = n.u32(), world = n.u32(), name = n.string();
        if (game !== BILLING_GAME || world !== peer.world || name.length > 32) throw new BillingError("Invalid billing scope");
        if (id === Request.RequestRemainCashTw) {
          const serial = n.u32(); n.string(); n.end(); // client IP is trace metadata, never authentication
          const p = new CSendPacket(Reply.OnRemainCashTw);
          p.Encode4(sid); string8(p, name); p.Encode4(serial);
          try { p.Encode4(this.store.balance(name, world)); p.Encode4(0); }
          catch { p.Encode4(0); p.Encode4(1); string8(p, BILLING_ERROR.authorization); }
          peer.wire.SendPacket(p);
        } else {
          const price = n.u32(), count = n.u32(), serial = n.u32(), stock = n.u32(), quantity = n.u32();
          n.string(); n.end();
          try {
            if (count !== 1 || quantity !== 1) throw new BillingError(BILLING_ERROR.product);
            const hold = this.store.reserve({ name, world, serial, stock, price });
            peer.wire.SendPacket(purchaseReply(Reply.OnPurchaseOKTw, hold.Reference, serial, "", stock));
          } catch (error) {
            peer.wire.SendPacket(purchaseReply(Reply.OnPurchaseOKTw, "", serial,
              error instanceof BillingError ? error.message : BILLING_ERROR.unavailable, stock));
          }
        }
      } else if (id === Request.PurchaseConfirmTw) {
        const reference = n.string(), serial = n.u32(), stock = n.u32(), result = n.u32(); n.end();
        if (reference.length > 32 || result > 2) throw new BillingError("Invalid confirmation");
        let error = "";
        try {
          const hold = this.store.confirm(reference, peer.world, serial, stock, result);
          error = hold.State === "committed" ? "" : hold.Error;
        } catch (e) {
          if (!(e instanceof BillingError)) throw e; // uncertain storage: retry, not fabricated final failure
          error = e.message;
        }
        peer.wire.SendPacket(purchaseReply(Reply.OnPurchaseConfirmTw, reference, serial, error));
      } else {
        throw new BillingError("Unsupported billing packet family");
      }
    } catch {
      // Deliberately no raw packet, name, password, or database exception in logs.
      console.warn("[Billing] Invalid/unavailable request; closing Shop peer for safe retry.");
      peer.wire.Close();
    }
  }
}

export function startBilling(db: CDBMan, config: BillingConfig): BillingServer {
  const server = new BillingServer(new BillingStore(db));
  server.listen(config.host, config.port);
  console.log(`[Billing] local service listening on ${config.host}:${server.port}; zero initial points, existing game credentials`);
  return server;
}
