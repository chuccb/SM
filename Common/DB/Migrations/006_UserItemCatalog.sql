-- Column names proven by FXGS0040F9FA select + CRSUserItem00411EE1 and
-- PutUserItemList0040EFEE. This is ONLY the item-DEFINITION table, NOT shop
-- stock/pricing, ItemSn/StockSn inventory mapping or a SQL Server restore.
-- Rename only: preserve every existing value (including signed/unsigned DWORD
-- spellings), account, inventory and all four immutable gameplay receipt tables.
ALTER TABLE FxItem RENAME COLUMN ItemID TO SN;
ALTER TABLE FxItem RENAME COLUMN Type TO Category;
ALTER TABLE FxItem RENAME COLUMN TmplName TO strAttr;
ALTER TABLE FxItem RENAME COLUMN OpaqueColumn3 TO nAttr1;
ALTER TABLE FxItem RENAME COLUMN OpaqueColumn4 TO nAttr2;
ALTER TABLE FxItem RENAME COLUMN OpaqueColumn5 TO nAttr3;
ALTER TABLE FxItem RENAME COLUMN Verbose TO strName;
