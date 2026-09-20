# Practice result compatibility fix

## Symptom

A Practice round launched normally, but the original client crashed immediately after this native game-end sequence:

1. client `146` event 4 reports the AI death,
2. server relays `159`,
3. client `146` event 6 reports the human finish,
4. server sends `163` (`OnGameResult`, 35 bytes for one human plus one AI),
5. the client exits before the normal delayed `164` return.

The packet shape and length were already native-compatible. The mismatch was a value inside the human result row.

## Native storage chain

`CGameSession+11684` is one complete `CDynInfoCalculator` object of size `0x254`. The four result arrays are members of that object, not separate session arrays:

| Session offset | Calculator offset | Native accessor |
| --- | --- | --- |
| `+12016` (`+0x2EF0`) | `+0x14C` | `GetSaveCount(slot)` (`0041AB0C`) |
| `+12048` (`+0x2F10`) | `+0x16C` | `GetKillCount(slot)` (`0041AAFE`) |
| `+12208` (`+0x2FB0`) | `+0x20C` | `GetMyTeamNo(slot)` (`0041AB2C`) |
| `+12240` (`+0x2FD0`) | `+0x22C` | `GetOtherTeamNo(slot)` (`0041AB3A`) |

The native update path is:

- `CDynInfoCalculator::Init` (`0040B337`) clears the arrays at launch.
- `CGameSession::OnSetBomberEvent` event 4 calls `SetKillerIndex` (`0040B1DC`).
- `SetKillerIndex(victim, killer)` increments calculator `+0x16C + 4*killer`.
- `CPracticeSession::SendGameResult` (`004260E4`) reads session `+12048`, which is that same calculator kill array.

For the reported AI-slot-1 death with human-slot-0 as killer, the native human row therefore carries `kill=1`.

## Port defect

The port correctly incremented `m_DynInfoCalculator.m_vtKills[0]`, but its result serializer read a second, independently allocated `CGameSession.m_rgWinDetailB` array. That second array was never updated, so the server sent `kill=0` in the human row. The AI row had the same split-storage problem.

The fix removes the duplicate session storage and routes all result/detail reads through the native calculator accessors. The adjacent native aliases were corrected at the same time:

- `+12112` uses `CDynInfoCalculator::SetNice`,
- `+12272` uses `SetHasPremium`,
- `+12276` uses `IsInvalidGame`,
- result/detail logic uses `GetKillCount`, `GetSaveCount`, `GetMyTeamNo`, and `GetOtherTeamNo`.

No `163` field was removed, inserted, reordered, or resized. In the reported one-human/one-AI result, only the encrypted human kill byte changes from the encoding of zero to the encoding of one.

## Return-stage compatibility

The complete settlement path was retained and regression-tested:

- `163` enters phase 2,
- `164` is still delayed until more than 8,000 ms after `EndGame`,
- Practice `164` still carries code `3`,
- human and AI seats remain in the Practice room,
- round-only state is cleared,
- a subsequent `106` can launch another round,
- `CPracticeSession::DeferBanChief` is the native empty override (`004259CE`), so the ordinary-room chief-ban state machine cannot run after Practice returns idle,
- `DoReturnPrepareStage` invokes the native strategy tail with a fresh packet.

## Regression coverage

`test/practice-start.test.ts` now drives the real encrypted dispatch path:

- `106 -> 115 -> 116 -> 173 -> 150`,
- `146/event4(AI slot 1, killer human slot 0) -> 159`,
- `146/event6(human slot 0) -> 163`,
- verifies the exact 35-byte row layout and human `kill=1`,
- verifies the AI marker/result/count/level fields,
- verifies the inverse AI path writes `kill=1` and `save=1` into the AI row,
- advances the native return gate and verifies `164(code=3)`, idle behavior, retained roster, and relaunch.

The ordinary-room end-to-end result test now also verifies that the event-4 killer count appears in its `163` row.

## Verification

Run from `port/` with the pinned preview toolchain:

```sh
bun run check:toolchain
bun run typecheck
bun test
```

The server-side native difference is fixed and covered, but the final crash determination still requires one retest with the original client binary. Restart the Game Server, reconnect, create a new Practice room, defeat the AI, and allow the result screen to continue through the delayed return to the preparation stage.
