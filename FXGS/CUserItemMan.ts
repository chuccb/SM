import type { CDBManBase } from "../Common/DB/CDBManBase.ts";
import { CSendPacketBase } from "../Common/CSendPacketBase.ts";
import { CProtocolError } from "../Common/CProtocolError.ts";
import type { UserItem } from "../Common/DB/Rows.ts";
import {
  CopyUserItem,
  UserItemKey,
  type UserItemSnapshot,
} from "../Common/UserItem.ts";
import { IntegerRange } from "../Common/OfficialValues.ts";
import { RuntimePolicy } from "../Common/RuntimePolicy.ts";

/** FXGS0040F9FA /0040F0EB /0040EFEE. ONLY the UserItem definition map.
 * No invented ShopItem table, prices, Init-success or stock/template mapping.
 * Single-event-loop immutable snapshots replace the native CRWLock/RB-tree.
 * Reload is trusted/offline, NOT wired to a guessed client refresh opcode. */
export class CUserItemMan {
  private m_mapUserItem: ReadonlyMap<number, Readonly<UserItem>> = new Map();
  private m_aUserItem: readonly Readonly<UserItem>[] = Object.freeze([]);
  private m_nRevision = 0;
  private m_bUpdating = false;
  constructor(readonly db: CDBManBase) {
    this.UpdateUserItemTable();
  }
  /** Modern all-or-nothing reload hardening: native clears AFTER opening the
   * rowset and insert_unique keeps the first duplicate. We instead validate the
   * WHOLE detached input, reject duplicates/errors and retain the previous map.
   * Errors propagate rather than hiding an unavailable/malformed catalog. */
  UpdateUserItemTable(): boolean {
    if (this.m_bUpdating) throw new CProtocolError("Reentrant UserItem reload");
    if (this.db.session.db.inTransaction)
      throw new CProtocolError("UserItem reload requires committed root data");
    if (this.m_nRevision >= IntegerRange.UInt32Maximum)
      throw new CProtocolError("UserItem revision exhausted");
    this.m_bUpdating = true;
    try {
      const source = this.db.GetUserItemList();
      if (source.length > RuntimePolicy.MaxUserItemDefinitions)
        throw new CProtocolError("Item catalog exceeds original count field");
      const map = new Map<number, Readonly<UserItem>>();
      for (const raw of source) {
        const row = CopyUserItem(raw, this.db.text);
        if (map.has(row.SN)) throw new CProtocolError("Duplicate UserItem SN");
        map.set(row.SN, row);
      }
      const rows = Object.freeze([...map.values()].sort((a, b) => a.SN - b.SN));
      if (this.db.session.db.inTransaction)
        throw new CProtocolError(
          "UserItem reload callback opened a transaction",
        );
      this.m_mapUserItem = map;
      this.m_aUserItem = rows;
      this.m_nRevision++;
      return true;
    } finally {
      this.m_bUpdating = false;
    }
  }
  /** Native int parameter is compared as an unsigned RB-tree key. Do not use
   * SQLite rowid, inventory SN, StockSn, resource index or a name fallback. */
  GetUserItem(sn: number): Readonly<UserItem> | undefined {
    return this.m_mapUserItem.get(UserItemKey(sn));
  }
  CaptureSnapshot(): UserItemSnapshot {
    const map = this.m_mapUserItem;
    return Object.freeze({
      Revision: this.m_nRevision,
      Count: this.m_aUserItem.length,
      GetUserItem: (sn: number) => map.get(UserItemKey(sn)),
    });
  }

  /** Modern detached count/revision diagnostics; no item/customer metadata. */
  GetState(): Readonly<{ Revision: number; Count: number }> {
    return Object.freeze({
      Revision: this.m_nRevision,
      Count: this.m_aUserItem.length,
    });
  }
  PutUserItemList(packet: CSendPacketBase): void {
    // Capture ONE generation and build with the CALLER'S codepage/cipher.
    // Append once only; even oversized/unrepresentable output cannot leave a
    // half-count/half-row in the caller, or re-query SQL midway through202.
    const rows = this.m_aUserItem,
      out = new CSendPacketBase(
        undefined,
        packet.GetCipherDegree(),
        packet.text,
      );
    out.Encode2(rows.length);
    for (const item of rows)
      out
        .Encode4(item.SN)
        .Encode1(item.Category)
        .EncodeStr(item.strAttr)
        .Encode4(item.nAttr1)
        .Encode4(item.nAttr2)
        .Encode4(item.nAttr3)
        .EncodeStr(item.strName);
    packet.EncodeBuffer(out.GetBuffer());
  }
}
