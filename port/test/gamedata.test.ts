/**
 * CItemAttr against the SHIPPED data package (FXGS/FxServer.idx/.idd).
 *
 * The Attr/ItemAttr blob the original installs carries 71 item records; the
 * port's parser once mis-walked the file (a phantom 60-byte map section) and
 * loaded zero of them, which made CGameSession::OnRequestEatItem disconnect
 * every player who ate a box ("Invalid item idx from user ...").  These
 * tests pin the real layout so a parse regression cannot ship silently.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CIDFMan } from "../src/FXGS/IDFMan.ts";
import { CItemAttr } from "../src/FXGS/ItemAttr.ts";

describe("CItemAttr (Attr/ItemAttr, FxServer.exe.c:17080)", () => {
  let saved: CIDFMan | null;

  beforeAll(() => {
    saved = CIDFMan.ms_pInstance;
    // the real package next to FXGS_000.cfg — the base the GS boot derives
    // from dirname(cfg) + "/FxServer"
    new CIDFMan(join(import.meta.dir, "..", "..", "FXGS", "FxServer"));
  });

  afterAll(() => {
    CIDFMan.ms_pInstance = saved;
  });

  test("Load parses the shipped records", () => {
    const attr = new CItemAttr();
    attr.Load();
    expect(attr.m_vtName.length).toBe(71);
    expect(attr.m_vtEffect.length).toBe(71);
    expect(attr.m_vtAmount.length).toBe(71);
    // the load order: the Item/* records first, then the bare names
    expect(attr.m_vtName[0]).toBe("Item/ItemBomb");
    expect(attr.m_vtName[1]).toBe("Item/ItemFire");
  });

  test("the lucci gem (effect 99) is LucciBronze paying 10", () => {
    const attr = new CItemAttr();
    attr.Load();
    const gem = attr.m_vtEffect.findIndex((e) => e === 99);
    expect(gem).toBeGreaterThan(0); // OnRequestEatItem's +35 == 99 branch
    expect(attr.m_vtName[gem]).toBe("LucciBronze");
    expect(attr.m_vtAmount[gem]).toBe(10);
  });

  test("GetItemidx strips Item/Item (9) or Item/ (5) from BOTH sides", () => {
    const attr = new CItemAttr();
    attr.Load();
    expect(attr.GetItemidx("Item/ItemBomb")).toBe(0);
    expect(attr.GetItemidx("Item/ItemFire")).toBe(1);
    // no prefix on the query — no match (the official's strips never fire)
    expect(attr.GetItemidx("ItemBomb")).toBe(-1);
    expect(attr.GetItemidx("Item/NoSuchItem")).toBe(-1);
  });
});
