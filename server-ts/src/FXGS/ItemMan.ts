/** Native source unit: FX/FxServer/ItemMan.cpp. */
import type { CSendPacket } from "../core/Packet.ts";
import { CDBMan } from "../db/DBMan.ts";
import type { ShopItem, UserItem } from "./Recordsets.ts";

/** CUserItemMan — the FxItem/FxStock cache (CUserItemMan::Init). */
export class CUserItemMan {
  static ms_pInstance: CUserItemMan | null = null;

  m_vtUserItem = new Map<number, UserItem>();
  m_vtShopItem = new Map<number, ShopItem>();

  constructor() {
    CUserItemMan.ms_pInstance = this;
  }

  /** CUserItemMan::Init (also re-run on center packet 14). */
  Init(db: CDBMan): boolean {
    const a = this.UpdateUserItemTable(db);
    const b = this.UpdateShopItemTable(db);
    return a && b;
  }

  /** CUserItemMan::UpdateUserItemTable — "SN, Category, strAttr, nAttr1, nAttr2, nAttr3, strName". */
  UpdateUserItemTable(db: CDBMan): boolean {
    this.m_vtUserItem.clear();
    for (const r of db.GetItemInfo()) {
      this.m_vtUserItem.set(r.SN, {
        Type: r.Category,
        strAttr: r.strAttr,
        nAttr1: r.nAttr1,
        nAttr2: r.nAttr2,
        nAttr3: r.nAttr3,
        strName: r.strName,
      });
    }
    return true;
  }

  /** CUserItemMan::UpdateShopItemTable — "SN, Category, Name, Description, ItemSN, Unit, DataFile, Price, …". */
  UpdateShopItemTable(db: CDBMan): boolean {
    this.m_vtShopItem.clear();
    for (const r of db.GetShopStock()) this.m_vtShopItem.set(r.SN, { ...r });
    return true;
  }

  /** CUserItemMan::GetUserItem */
  GetUserItem(SN: number): UserItem | null {
    return this.m_vtUserItem.get(SN) ?? null;
  }

  /** CUserItemMan::GetShopItem */
  GetShopItem(SN: number): ShopItem | null {
    return this.m_vtShopItem.get(SN) ?? null;
  }

  /** CUserItemMan::PutUserItemList — packet 202 body. */
  PutUserItemList(packet: CSendPacket): void {
    packet.Encode2(this.m_vtUserItem.size);
    for (const [sn, item] of this.m_vtUserItem) {
      packet.Encode4(sn);
      packet.Encode1(item.Type);
      packet.EncodeStr(item.strAttr);
      packet.Encode4(item.nAttr1);
      packet.Encode4(item.nAttr2);
      packet.Encode4(item.nAttr3);
      packet.EncodeStr(item.strName);
    }
  }
}
