/** Port-only declaration module for CxLogin native constants — login result codes,
 * connect-to-server gate codes, and related magic values.
 *
 * These values are recovered from CxLogin.exe.c / CxLogin.exe.lst and are
 * used in multiple places (OnLogin, OnCenterResAddNewUser, CheckEnterGame,
 * OnReqConnectToSvrRes). Naming them avoids hardcoding and makes the
 * client-observable behavior explicit.
 */

/** Client 3 OnLoginRes result codes — native CxLogin 3 handler.
 *  0 success, 1 invalid id/password (DB proc -1), 2 center add-user failure,
 *  3 DB open failure (ExecStoredProc <0).
 *  The native OnLogin encodes 1 for inited 2..3, 3 for other failures (1),
 *  and OnCenterResAddNewUser encodes 2 when fAllAdded==0.
 */
export const LOGIN_RESULT = {
  Success: 0,
  InvalidCredentials: 1,
  CenterFailure: 2,
  DBFailure: 3,
} as const;

/** Client 4/5 OnNewUserConfirmId / OnNewUser result codes.
 *  ConfirmId: 0 free, 1 exists (prConfirmUnregisteredId).
 *  NewUser: 0 success, 1 SQL error (prCreateUser -1).
 */
export const NEWUSER_CONFIRM_RESULT = {
  Free: 0,
  Exists: 1,
} as const;

export const NEWUSER_RESULT = {
  Success: 0,
  Failure: 1,
} as const;

/** Client 6 OnReqConnectToSvrRes gate codes — CCenterProcess::CheckEnterGame (5964).
 *  0 no game state, 1 success, 4 version mismatch, 5 server type unavailable.
 *  Values 4/5 are also used as client-visible failure codes.
 */
export const CONNECT_GATE_RESULT = {
  NoGameState: 0,
  Success: 1,
  VersionMismatch: 4,
  ServerTypeUnavailable: 5,
} as const;

/** Game room code mask — `rand() & 3` at 0040EAFF..0040EB08. */
export const GAME_ROOM_CODE_MASK = 0x3;

/** Double-login notice strings — EUC-KR bytes preserved as latin1. */
export const STR_ALREADY_PLAYING = "\xc7\xf6\xc0\xe7 \xb0\xd4\xc0\xd3\xc0\xbb \xc7\xcf\xb0\xed \xb0\xe8\xbd\xc3\xb4\xc2 \xb0\xf7";
export const STR_PC = "PC";

/** Encrypted string keys for OnLogin's DecodeEncryptedStr. */
export const LOGIN_ENC_KEY_ID = 0x11223344;
export const LOGIN_ENC_KEY_PW = 0x44332211;

/** Channel cache hash mismatch flags — OnRequestEnterChannelStage. */
export const CHANNEL_HASH_MISMATCH = 1;
export const CHANNEL_HASH_MATCH = 0;

/** Advertisement rotation — client 11's trailing 60 (E2 60) is fixed. */
export const ADVERTISEMENT_TRAILING = 60;
