/**
 * Port-only ESM adapter for CGameMapTmpl::LoadMap's native call through the
 * CGameMapTmplList singleton. It keeps the two original source units from
 * value-importing each other during module initialization.
 */

export interface GameMapGroupLookup {
  IsMapInGroup(group: string, mapName: string): boolean;
}

let mapGroups: GameMapGroupLookup | null = null;

export function RegisterGameMapGroupLookup(lookup: GameMapGroupLookup | null): void {
  mapGroups = lookup;
}

export function IsMapInRegisteredGroup(group: string, mapName: string): boolean {
  return mapGroups?.IsMapInGroup(group, mapName) ?? false;
}
