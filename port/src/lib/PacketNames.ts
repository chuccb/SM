/**
 * Typed packet-name metadata shared by PacketIDs.ts, S2S.ts and PacketLog.
 *
 * Packet ids are only unique inside a wire family + endpoint + direction.
 * More than one official handler/sender may legitimately use the same id;
 * those names are aliases, not entries that may overwrite one another.
 */

/** Opcode widths accepted by the native packet constructors. */
export const STANDARD_PACKET_OPCODE_BYTES = 1;
export const WORD_PACKET_OPCODE_BYTES = 2;
export const TAIWAN_BILLING_OPCODE_BYTES = 4;

/** Enum-like packet-id object (`{ OnLogin: 3, ... }`). */
export type PacketIdTable = Readonly<Record<string, number>>;

/** The seven packet enum families retained by the original server symbols. */
export type OfficialPacketFamily =
  | "enGeneralServerPacket"
  | "enGameServerPacket"
  | "enLocalPacket"
  | "enBillingPacket"
  | "enCouponPacket"
  | "enCenterPacket"
  | "enMonitorPacket";

export type PacketWireDirection =
  | "client-to-server"
  | "server-to-client"
  | "local-to-center"
  | "center-to-local"
  | "monitor-to-center"
  | "center-to-monitor"
  | "shop-to-billing"
  | "billing-to-shop";

/** One unambiguous reverse-lookup result. */
export interface PacketNameInfo {
  readonly canonicalName: string;
  readonly aliases: readonly string[];
  /** The payload must never be emitted in a packet trace. */
  readonly containsCredentials: boolean;
}

/** Fully-qualified result of a context-aware reverse lookup. */
export interface PacketDescriptor extends PacketNameInfo {
  readonly id: number;
  readonly family: OfficialPacketFamily;
  readonly context: string;
  readonly direction: PacketWireDirection;
  readonly opcodeBytes: 1 | 2 | 4;
}

/** A packet table plus the context needed to interpret its reused ids. */
export interface PacketNameTable<TIds extends PacketIdTable = PacketIdTable> {
  readonly family: OfficialPacketFamily;
  readonly context: string;
  readonly direction: PacketWireDirection;
  readonly opcodeBytes: 1 | 2 | 4;
  readonly ids: TIds;
  readonly names: Readonly<Record<number, PacketNameInfo>>;
}

export interface PacketNameTableOptions<TIds extends PacketIdTable> {
  /** Explicit canonical name for ids with aliases; otherwise declaration order wins. */
  readonly canonical?: Readonly<Partial<Record<TIds[keyof TIds], keyof TIds & string>>>;
  /** Fields carried by these packet names contain credentials/private identity data. */
  readonly credentials?: readonly (keyof TIds & string)[];
  /** Most families use a one-byte nPacketType; Taiwan billing uses four. */
  readonly opcodeBytes?: 1 | 2 | 4;
}

/** Build and freeze an alias-preserving reverse index for one packet table. */
export function DefinePacketNameTable<TIds extends PacketIdTable>(
  family: OfficialPacketFamily,
  context: string,
  direction: PacketWireDirection,
  ids: TIds,
  options: PacketNameTableOptions<TIds> = {},
): PacketNameTable<TIds> {
  const grouped = new Map<number, string[]>();
  for (const [name, id] of Object.entries(ids)) {
    const names = grouped.get(id);
    if (names === undefined) grouped.set(id, [name]);
    else if (!names.includes(name)) names.push(name);
  }

  const credentialIds = new Set<number>();
  for (const name of options.credentials ?? []) credentialIds.add(ids[name]!);

  const index: Record<number, PacketNameInfo> = {};
  for (const [id, declaredNames] of grouped) {
    const requested = (options.canonical as Readonly<Record<number, string>> | undefined)?.[id];
    const canonicalName = requested !== undefined && declaredNames.includes(requested)
      ? requested
      : declaredNames[0]!;
    index[id] = Object.freeze({
      canonicalName,
      aliases: Object.freeze(declaredNames.filter((name) => name !== canonicalName)),
      containsCredentials: credentialIds.has(id),
    });
  }

  return Object.freeze({
    family,
    context,
    direction,
    opcodeBytes: options.opcodeBytes ?? STANDARD_PACKET_OPCODE_BYTES,
    ids,
    names: Object.freeze(index),
  });
}

/** Resolve an id without discarding its family, direction or endpoint context. */
export function ResolvePacketName(table: PacketNameTable, id: number): PacketDescriptor | null {
  const info = table.names[id];
  if (info === undefined) return null;
  return Object.freeze({
    id,
    family: table.family,
    context: table.context,
    direction: table.direction,
    opcodeBytes: table.opcodeBytes,
    ...info,
  });
}

/** Convert a raw enum-like object to a reverse index (for small local protocols). */
export function PacketNamesFromIds(ids: PacketIdTable): Readonly<Record<number, PacketNameInfo>> {
  return DefinePacketNameTable("enGeneralServerPacket", "unscoped", "client-to-server", ids).names;
}

/** Merge tables without losing aliases. Earlier canonical names stay canonical. */
export function MergePacketNameInfo(
  current: PacketNameInfo | undefined,
  incoming: PacketNameInfo,
): PacketNameInfo {
  if (current === undefined) return incoming;
  const names = [current.canonicalName, ...current.aliases];
  for (const name of [incoming.canonicalName, ...incoming.aliases]) {
    if (!names.includes(name)) names.push(name);
  }
  return Object.freeze({
    canonicalName: names[0]!,
    aliases: Object.freeze(names.slice(1)),
    containsCredentials: current.containsCredentials || incoming.containsCredentials,
  });
}

/** Stable human-readable label used by PacketLog. */
export function PacketNameLabel(info: PacketNameInfo): string {
  return info.aliases.length === 0
    ? info.canonicalName
    : `${info.canonicalName}|${info.aliases.join("|")}`;
}
