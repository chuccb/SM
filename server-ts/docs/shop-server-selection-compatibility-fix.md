# Shop Server Selection Compatibility Fix

## Issue Summary
Under certain conditions, players entering the Shop server (`FXSSNumber >= 1`) failed to connect, with `CxCenter` logging:
```
[Center] User try to connect to shutdown server
```
This error occurred when transitioning between servers (such as Game Server -> Shop Server), preventing users from entering the shop.

## Root Cause Analysis

### 1. `CLocalServerMan::GetSmallLoadedSvrIdx` (Disassembly 0040B020, `CxCenter.exe.c:11735`)
In the original binary:
```c
int __thiscall CLocalServerMan::GetSmallLoadedSvrIdx(CLocalServerMan *this, unsigned __int8 n11)
{
  int v2 = 0;
  int n2000 = 2000;
  if ( n11 != 11 )
    return -1;
  ++dword_481088;
  v5 = *((_DWORD *)this + 8); // FXSSNumber count
  result = dword_481088 % v5;
  if ( dword_481088 % v5 < 0
    || result >= v5
    || (v6 = *((_DWORD *)this + 4) + 96 * result) == 0
    || *(_DWORD *)(v6 + 52) == 0 ) // check socket != NULL
  {
    v7 = 0;
    if ( v5 > 0 )
    {
      v8 = 0;
      do
      {
        if ( v8 < 0 || v7 >= v5 )
          v9 = 0;
        else
          v9 = v8 + *((_DWORD *)this + 4);
        if ( *(_DWORD *)(v9 + 52) != 0 ) // check socket != NULL
        {
          n2000_1 = *(_DWORD *)(v9 + 48); // nConnNo
          if ( n2000_1 < n2000 )
          {
            n2000 = n2000_1;
            v2 = v7;
          }
        }
        ++v7;
        v8 += 96;
      }
      while ( v7 < v5 );
    }
    return v2;
  }
  return result;
}
```

In the previous TypeScript port:
`GetSmallLoadedSvrIdx` was implemented as:
```typescript
GetSmallLoadedSvrIdx(nServerClass: number): number {
  let best: CLocalServer | null = null;
  for (const s of this.servers) {
    if (s.nServerClass !== nServerClass) continue;
    if (!best || s.nConnNo < best.nConnNo) best = s;
  }
  return best ? best.nSvrIdx : 0;
}
```
Flaws in the previous implementation:
1. It did NOT check `s.socket !== null`. If multiple shop servers were configured in `center.cfg` or a shop server disconnected/shutdown, it could return an unattached or shutdown server index whose socket was null.
2. It lacked the native round-robin static counter `dword_481088` and the fallback scan with `nConnNo < 2000` over active servers with `socket !== null`.
3. When `s.socket === null`, `CUser::CheckConnectingToSvr` (004153B0) hit:
   ```typescript
   if (!svr || svr.socket === null) {
     console.error("[Center] User try to connect to shutdown server");
     return 0;
   }
   ```
   causing the client connection request to be rejected with code 0.

## Implementation Details

1. Updated `CLocalServerMan::GetSmallLoadedSvrIdx` in `server-ts/src/Center/LocalServerMan.ts`:
   - Enforce `nServerClass === SVRCLASS_SHOP` (class 11), returning -1 for other classes.
   - Advance monotonic counter `m_dwSmallLoadedSvrIdx` (`++dword_481088`).
   - Test if the round-robin candidate has `candidate.socket !== null`; if so, select it.
   - Otherwise, iterate configured shop servers, filtering by `svr.socket !== null && svr.nConnNo < minConnNo` (starting at 2000).
   - If no active server exists, return 0.

2. Verified with unit tests in `server-ts/test/center-timeout.test.ts`.
