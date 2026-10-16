import type { CDBSession } from "../../Common/DB/CDBSession.ts";

/** Test fixture ONLY: existing migration tests deliberately reset user_version
 * to3/4 after removing newer receipt tables. They must ALSO restore the actual
 * old catalog column names; lowering the pragma alone is not an old schema.
 * Never used by production, never a supported database downgrade. */
export function RestoreV5CatalogColumnsForFixture(s: CDBSession): void {
  s.db.exec(`ALTER TABLE FxItem RENAME COLUMN SN TO ItemID;
    ALTER TABLE FxItem RENAME COLUMN Category TO Type;
    ALTER TABLE FxItem RENAME COLUMN strAttr TO TmplName;
    ALTER TABLE FxItem RENAME COLUMN nAttr1 TO OpaqueColumn3;
    ALTER TABLE FxItem RENAME COLUMN nAttr2 TO OpaqueColumn4;
    ALTER TABLE FxItem RENAME COLUMN nAttr3 TO OpaqueColumn5;
    ALTER TABLE FxItem RENAME COLUMN strName TO Verbose;`);
}
