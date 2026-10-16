import { beforeAll, expect, test } from "bun:test";
import { CFastFile } from "../Common/CFastFile.ts";
import { CBomberAttr } from "../FXGS/CBomberAttr.ts";
import { CGameMapTmplList } from "../FXGS/CGameMapTmplList.ts";
import { CMapObjToTileInfo } from "../FXGS/CMapObjToTileInfo.ts";
const files = new CFastFile();
beforeAll(() => files.FastFileInit("FXGS/FxServer"));
test("actual official archive: 256 entries, exact data bounds and case-insensitive lookup", () => {
  expect(files.GetDataCount()).toBe(256);
  expect(files.Get("Attr/BomberAttr").length).toBe(570);
  expect(files.Get("attr/bomberattr")).toEqual(files.Get("Attr/BomberAttr"));
  expect(() => files.Get("../../etc/passwd")).toThrow();
  const h = files.FastFileOpen("Attr/BomberAttr")!;
  files.FastFileSeek(h, -1, 2);
  expect(files.FastFileRead(h, 1).length).toBe(1);
  expect(() => files.FastFileRead(h, 1)).toThrow();
});
test("all 226 official map headers preserve ordering, CRC, groups and thirteen themes", () => {
  const maps = new CGameMapTmplList();
  maps.CreateTmplList(files);
  expect(maps.GetMapCount()).toBe(226);
  expect(maps.m_aThemeInfo.length).toBe(13);
  expect(maps.GetMapTmpl(0).m_strName).toBe("Bula00");
  const village = maps.m_aMapTmpl.findIndex((m) => m.m_strName === "Village01");
  expect(maps.GetMapTmpl(village).m_nWidth).toBe(15);
  expect(maps.GetMapTmpl(village).m_nHeight).toBe(13);
  expect(maps.GetMapMaxPlayer(village)).toBe(8);
  expect(maps.GetMapMaxTeam(village)).toBe(8);
  expect(maps.IsPracticeMap(village)).toBe(true);
  expect(maps.m_mapMapGroup.has("PraticeMapGroup")).toBe(true);
  for (let i = 0; i < maps.GetMapCount(); i++) {
    expect(maps.GetMapTmpl(i).m_pMapBody.length).toBeGreaterThan(0);
    expect(maps.GetCRC(i)).toBeGreaterThanOrEqual(0);
  }
});
test("real bomber attributes: eight selectable, two random-only, random sentinel ten", () => {
  const attrs = new CBomberAttr();
  attrs.Load(files);
  expect(attrs.GetTotalCount()).toBe(10);
  expect(attrs.GetNormalCount()).toBe(8);
  expect(attrs.GetRandomBomberIdx()).toBe(10);
  expect(attrs.IsValidSelectIdx(7)).toBe(true);
  expect(attrs.IsValidSelectIdx(8)).toBe(false);
  expect(attrs.IsValidSelectIdx(9)).toBe(false);
  expect(attrs.IsValidSelectIdx(10)).toBe(true);
  expect(attrs.GetDefSpeed(0)).toBe(5);
  expect(attrs.GetDefBombCount(0)).toBe(1);
  expect(attrs.GetDefBombPower(0)).toBe(1);
});
test("actual TileInfo 721 records, all eleven DWORDs (44 bytes) preserved without fabricated meanings", () => {
  const tiles = new CMapObjToTileInfo();
  tiles.Load(files);
  expect(tiles.GetCount()).toBe(721);
});
