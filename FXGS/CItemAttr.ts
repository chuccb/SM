import { readFileSync } from "node:fs";
import { CDataReader } from "../Common/CDataReader.ts";
import type { CFastFile } from "../Common/CFastFile.ts";
import { CProtocolError } from "../Common/CProtocolError.ts";
import { ItemAttrFormat, AirplaneItemRule } from "../Common/OfficialValues.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";

/** Resource row, NOT FXSS's FxItem SQL definition or stock/pricing row.
 * Descriptive property names below are tied to the native 164-byte row offsets. */
export interface ItemAttr {
  readonly Index: number;
  readonly Name: string;
  readonly ImageName: string;
  readonly ProbabilityWeight: number; // row+132
  readonly Opaque136: number;
  readonly Type: number; // row+140; 99 is a money pickup
  readonly Parameters: readonly number[]; // row+144..160; money delta when Type=99
}
export interface AirplaneItemProbability {
  readonly ItemIndex: number;
  readonly Weight: number;
}
export interface ShipAttr {
  readonly Index: number;
  readonly Code: number;
  readonly Name: string;
  readonly OpaqueWords: readonly number[]; // native row+72..100 (code is +68); not guessed as physics
}
/** CItemAttr::Load 0040EA1E, GetItemidx 0040E37A, GetItemCount/Attr 0041ACAB/AF.
 * Plain file strings are retained as plain strings; legacy SimpleCipher merely
 * obfuscates fixed buffers after loading into native process memory. */
export class CItemAttr {
  readonly m_aItemAttr: ItemAttr[] = [];
  readonly m_aShipAttr: ShipAttr[] = [];
  readonly m_mapShipCode = new Map<number, number>();
  private m_aHeader: readonly number[] = [];
  private m_airplaneProb:
    | readonly (readonly AirplaneItemProbability[])[]
    | undefined;
  /** Modern factoring of the iteminfo.txt read in004204EB. Capture once at
   * startup instead of doing filesystem IO in a live room; missing file means
   * native fopen failure (NO173), not a fabricated empty probability list. */
  LoadAirplaneItemInfo(path: string): void {
    let data: string;
    try {
      data = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.m_airplaneProb = undefined;
      return;
    }
    this.LoadAirplaneItemInfoData(data);
  }
  LoadAirplaneItemInfoData(data: string): void {
    const words = data.trim().split(/\s+/),
      sections: AirplaneItemProbability[][] = [];
    let offset = 0;
    const integer = (maximum: number): number => {
      const token = words[offset++];
      if (!token || !/^\d+$/.test(token))
        throw new CProtocolError("Invalid airplane item integer");
      const value = Number(token);
      if (!Number.isSafeInteger(value) || value > maximum)
        throw new CProtocolError("Airplane item integer out of bounds");
      return value;
    };
    for (let section = 0; section < AirplaneItemRule.Sections; section++) {
      const count = integer(AirplaneItemRule.MaximumEntries),
        entries: AirplaneItemProbability[] = [];
      for (let i = 0; i < count; i++) {
        const name = words[offset++];
        if (!name) throw new CProtocolError("Missing airplane item name");
        const item = this.GetItemidx(name),
          weight = integer(AirplaneItemRule.MaximumWeightByte);
        // Native GetItemidx returns -1 for unknown names; Encode1 must keep
        // its FF sentinel, not reject it or manufacture an item-zero fallback.
        entries.push(Object.freeze({ ItemIndex: item, Weight: weight }));
      }
      sections.push(entries);
    }
    if (offset !== words.length)
      throw new CProtocolError("Trailing airplane item data");
    this.m_airplaneProb = Object.freeze(
      sections.map((section) => Object.freeze(section)),
    );
  }
  GetAirplaneItemProbability(
    missionType: number,
  ): readonly AirplaneItemProbability[] | undefined {
    return this.m_airplaneProb?.[
      missionType === AirplaneItemRule.AlternateMissionType ? 1 : 0
    ];
  }
  private m_probability = Buffer.alloc(
    ItemAttrFormat.ProbabilityTableSize,
    ItemAttrFormat.UnassignedProbabilityByte,
  );
  get m_aOpaqueHeader(): readonly number[] {
    return this.m_aHeader;
  }
  /** Copy prevents a consumer from mutating the loaded lookup table. */
  GetProbabilityTable(): Buffer {
    return Buffer.from(this.m_probability);
  }
  Load(files: CFastFile): void {
    this.LoadData(files.Get("Attr/ItemAttr"));
  }
  LoadData(bytes: Uint8Array): void {
    const reader = new CDataReader(bytes);
    const header = Object.freeze([reader.i32(), reader.i32()]);
    const shipCount = reader.i32();
    if (shipCount < 0 || shipCount > RuntimePolicy.MaxShipAttributeRows)
      throw new CProtocolError("Invalid ship attribute count");
    const ships: ShipAttr[] = [];
    const codes = new Map<number, number>();
    for (let i = 0; i < shipCount; i++) {
      const Code = reader.i32();
      const Name = reader.string(ItemAttrFormat.NameBytes);
      if (!Name.length) throw new CProtocolError("Empty ship template name");
      ships.push(
        Object.freeze({
          Index: i,
          Code,
          Name,
          OpaqueWords: Object.freeze(
            Array.from({ length: ItemAttrFormat.ShipAttributeWords }, () =>
              reader.i32(),
            ),
          ),
        }),
      );
      codes.set(Code, i); // native map assignment: last duplicate code wins
    }
    const items: ItemAttr[] = [];
    const probability = Buffer.alloc(
      ItemAttrFormat.ProbabilityTableSize,
      ItemAttrFormat.UnassignedProbabilityByte,
    );
    let weight = 0;
    while (reader.remaining) {
      if (items.length >= ItemAttrFormat.MaximumItems)
        throw new CProtocolError("Too many game item attributes");
      const Name = reader.string(ItemAttrFormat.NameBytes);
      const ImageName = reader.string(ItemAttrFormat.NameBytes);
      if (!Name.length || !ImageName.length)
        throw new CProtocolError("Empty item template name");
      const ProbabilityWeight = reader.i32();
      if (
        ProbabilityWeight < 0 ||
        ProbabilityWeight > ItemAttrFormat.MaximumWeight - weight
      )
        throw new CProtocolError("Invalid item probability weight");
      const row: ItemAttr = Object.freeze({
        Index: items.length,
        Name,
        ImageName,
        ProbabilityWeight,
        Opaque136: reader.i32(),
        Type: reader.i32(),
        Parameters: Object.freeze(
          Array.from({ length: ItemAttrFormat.ParameterWords }, () =>
            reader.i32(),
          ),
        ),
      });
      probability.fill(row.Index, weight, weight + ProbabilityWeight);
      weight += ProbabilityWeight;
      items.push(row);
    }
    reader.end();
    // Publish only a fully parsed resource; truncated reloads cannot half-replace it.
    this.m_aHeader = header;
    this.m_aItemAttr.splice(0, this.m_aItemAttr.length, ...items);
    this.m_aShipAttr.splice(0, this.m_aShipAttr.length, ...ships);
    this.m_mapShipCode.clear();
    for (const [code, index] of codes) this.m_mapShipCode.set(code, index);
    this.m_probability = probability;
    this.m_airplaneProb = undefined; // item IDs must be rebound after a resource reload
  }
  GetItemCount(): number {
    return this.m_aItemAttr.length;
  }
  GetItemAttr(index: number): ItemAttr {
    if (!Number.isInteger(index) || index < 0 || index >= this.GetItemCount())
      throw new CProtocolError("Game item index out of bounds");
    return this.m_aItemAttr[index]!;
  }
  private stripPrefix(name: string): string {
    for (const prefix of ItemAttrFormat.TemplatePrefixes)
      if (name.toLowerCase().startsWith(prefix.toLowerCase()))
        return name.slice(prefix.length);
    return name;
  }
  GetItemidx(name: string): number {
    const full = name.toLowerCase();
    const short = this.stripPrefix(name).toLowerCase();
    return this.m_aItemAttr.findIndex(
      (row) =>
        row.Name.toLowerCase() === full ||
        this.stripPrefix(row.Name).toLowerCase() === short,
    );
  }
}
