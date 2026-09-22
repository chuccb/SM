/**
 * Port-only declaration boundary for native CxLogin database row values.
 *
 * The original emits these values from RSMultiServer.cpp and
 * RSLoginServer.cpp. The port's SQLite readers live in the shared DBMan
 * infrastructure, so this unit preserves the native row names without
 * pretending that a Recordsets.cpp owner or unused CRS* wrapper exists.
 */

/** RSMultiServer.cpp::_MULTISERVER. */
export interface _MULTISERVER {
  SN: number;
  strName: string;
  strIp: string;
  dwParam: number;
  dwCurrent: number;
}

/** RSLoginServer.cpp::_LOGINSERVER. */
export interface _LOGINSERVER {
  SN: number;
  strIp: string;
  nPort: number;
  nFlag: number;
}

/** RSMultiServer.cpp::_MULTISERVERNOTICE. */
export interface _MULTISERVERNOTICE {
  sn: number;
  nType: number;
  strValue: string;
  strAttr: string;
}
