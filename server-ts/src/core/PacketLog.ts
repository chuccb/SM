/**
 * PacketLog — an env-gated trace of everything the servers exchange with
 * clients and with each other, for byte-level verification against captures.
 *
 *   CA_PACKET_LOG=1        trace lines to the console
 *   CA_PACKET_LOG=<path>   append trace lines to that file instead
 *   CA_PACKET_LOG_HEX=<n>  hex-dump cap per packet in bytes (default 128)
 *   CA_PACKET_LOG_SCOPE=client|all  client links only (default) or + S2S/
 *                          monitor/billing/Relay infra links
 *
 * Purely observational: with the variable unset every hook is one boolean
 * check and nothing is emitted, so client-observable behavior is identical.
 *
 * Hook points (one funnel each, so the whole suite is covered):
 *   - CPacketSocket::GetPacket  — every framed TCP packet received
 *   - CPacketSocket::PutPacket  — every framed TCP packet sent
 *   - the MTUDP datagram paths  — raw UDP (LS 3839 / GS 4849 / Relay 9520)
 *
 * Line shape (direction is relative to the local server):
 *   [12:34:56.789] [LS] CClientSocket <- OnLogin(3) deg2 len=13 | 03 01 ...
 *   [12:34:56.789] [LS] udp <- len=5 | 00 00 00 00 07
 *
 * The hex dump is the packet's payload body image (type byte + fields) as it
 * sits in memory at that side: width-masked on send (exactly the wire body
 * minus code/length/CRC framing), as-decoded on recv — field readers unmask
 * per field at read time, so the dump shows the masked values both ways.
 *
 * Packet names resolve through the PacketIDs.ts tables registered per server
 * in its main(); unregistered flows print the bare id as p<N>.
 */
import { PacketIdDescriptor } from "./protocol/PacketIDs.ts";
import {
  MergePacketNameInfo,
  PacketNameLabel,
  PacketNamesFromIds,
  type PacketIdTable,
  type PacketNameInfo,
  type PacketNameTable,
} from "./protocol/PacketNames.ts";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class PacketLog {
  /** Per-process server tag ([LS] / [GS] / …), set by each main(). */
  static tag = "Srv";

  /** id → name tables keyed "<tableKey>:<recv|send>" (tableKey defaults to the tag). */
  static names = new Map<string, Map<number, PacketNameInfo>>();

  /** Test seam: when set, Emit hands the line here instead of console/file. */
  static out: ((line: string) => void) | null = null;

  /** last directory the file sink mkdir'd (avoids a syscall per packet) */
  private static fileDirMade: string | null = null;

  static Enabled(): boolean {
    const v = process.env.CA_PACKET_LOG;
    return v !== undefined && v !== "" && v !== "0";
  }

  /** CA_PACKET_LOG_SCOPE — "client" (default) traces only the client-facing
   *  links (CClientSocket / CWebSocket / the client MTUDP paths); "all" adds
   *  the infra links (S2S to center, monitor, billing, Relay). */
  static ShowsClient(): boolean {
    return PacketLog.Enabled();
  }

  static ShowsInfra(): boolean {
    if (!PacketLog.Enabled()) return false;
    const v = process.env.CA_PACKET_LOG_SCOPE;
    return v !== undefined && v !== "" && v !== "client";
  }

  /** PacketLog::Configure — name the local server for the [tag] prefix. */
  static Configure(tag: string): void {
    PacketLog.tag = tag;
  }

  /** Register context-bound tables for "<tableKey>:<dir>".  Reused ids
   * preserve the first canonical name and every later name as an alias. */
  static Register(
    tableKey: string,
    dir: "recv" | "send",
    ...tables: readonly (PacketNameTable | PacketIdTable)[]
  ): void {
    let map = PacketLog.names.get(`${tableKey}:${dir}`);
    if (map === undefined) {
      map = new Map<number, PacketNameInfo>();
      PacketLog.names.set(`${tableKey}:${dir}`, map);
    }
    for (const table of tables) {
      const names = "names" in table && "ids" in table ? table.names : PacketNamesFromIds(table);
      for (const [rawId, incoming] of Object.entries(names)) {
        const id = Number(rawId);
        map.set(id, MergePacketNameInfo(map.get(id), incoming));
      }
    }
  }

  /** One framed packet (payload = [type][body...], the decoded logical image). */
  static Packet(
    peer: string,
    tag: string,
    dir: "recv" | "send",
    nPacketType: number,
    nCipherDegree: number,
    payload: Uint8Array,
    tableKey: string | null = null,
  ): void {
    if (!PacketLog.Enabled()) return;
    const registryKey = tableKey ?? tag;
    const info = PacketLog.names.get(`${registryKey}:${dir}`)?.get(nPacketType) ??
      PacketIdDescriptor(registryKey, dir, nPacketType);
    const name = info === null || info === undefined ? `p${nPacketType}` : PacketNameLabel(info);
    PacketLog.Emit(
      `[${PacketLog.Timestamp()}] [${tag}] ${peer} ${dir === "recv" ? "<-" : "->"} ` +
        `${name}(${nPacketType}) deg${nCipherDegree} len=${payload.length} | ` +
        `${info?.containsCredentials === true ? "[credentials redacted]" : PacketLog.Hex(payload)}`,
    );
  }

  /** One raw UDP datagram or MTUDP frame payload. */
  static Datagram(dir: "recv" | "send", payload: Uint8Array, tag = PacketLog.tag): void {
    if (!PacketLog.Enabled()) return;
    PacketLog.Emit(
      `[${PacketLog.Timestamp()}] [${tag}] udp ${dir === "recv" ? "<-" : "->"} len=${payload.length}` +
        ` | ${PacketLog.Hex(payload)}`,
    );
  }

  static Emit(line: string): void {
    const v = process.env.CA_PACKET_LOG;
    if (v === undefined || v === "" || v === "0") return;
    if (PacketLog.out !== null) {
      PacketLog.out(line);
      return;
    }
    if (v === "1") {
      console.log(line);
      return;
    }
    // a path — append one line per packet (debug-only path; sync is fine)
    const dir = dirname(v);
    if (PacketLog.fileDirMade !== dir) {
      mkdirSync(dir, { recursive: true });
      PacketLog.fileDirMade = dir;
    }
    appendFileSync(v, `${line}
`);
  }

  /** CA_PACKET_LOG_HEX — hex dump capped per packet (default 128 bytes). */
  static Hex(p: Uint8Array): string {
    let cap = 128;
    const env = process.env.CA_PACKET_LOG_HEX;
    if (env !== undefined && env !== "") cap = Number.parseInt(env, 10) || 0;
    const n = Math.min(p.length, cap);
    let s = "";
    for (let i = 0; i < n; i++) s += `${p[i]!.toString(16).padStart(2, "0")} `;
    if (p.length > n) s += `…(+${p.length - n}B)`;
    return s.trimEnd();
  }

  static Timestamp(): string {
    const d = new Date();
    const p2 = (x: number) => x.toString().padStart(2, "0");
    return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${d.getMilliseconds().toString().padStart(3, "0")}`;
  }
}
