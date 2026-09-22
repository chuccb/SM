# Practice result compatibility fix

## Symptom

A Practice round launched and completed normally, but the original Taiwan
client exited as soon as it received packet `163`:

1. client `146`, event 4 reported the AI death,
2. server relayed `159`,
3. client `146`, event 6 reported the human finish,
4. server sent a 35-byte `163`,
5. the client exited before the delayed `164` return.

The first repair corrected the human kill count from `0` to the native value
`1`, but the client still exited. That proved that the result statistics were
a real server mismatch but not the packet-decoding failure.

## Complete-build comparison

The repository does not contain one single FxServer build:

- `FXGS/FxServer.exe` was built on 2005-01-04.
- `FXGS/FxServer.pdb` is the exact PDB for that executable. Its stream-1 GUID
  is `0ec2136f-6c71-4610-9f6e-cd26f7de33b9`, age `1`, exactly matching the
  executable's RSDS record.
- `FXGS/FxServer.map` was built on 2004-08-06 and describes the earlier
  client-compatible protocol.

The PDB's C11 line table maps the 2005
`CPracticeSession::SendGameResult` at `004260E4..00426296` to
`PracticeSession.cpp` lines 697..768. The older map places the same function
at `0001:0002322C..000233D4`, lines 697..767.

The important normalized line boundaries are:

| Operation area | 2004 map | 2005 PDB |
| --- | --- | --- |
| function | line 697, `+0x00` | line 697, `+0x00` |
| packet construction | line 702, `+0x0B` | line 702, `+0x0B` |
| result flag | line 703, `+0x1D` | line 703, `+0x1D` |
| winner | line 704, `+0x27` | line 704, `+0x27` |
| next old header field / inserted field | line 705, `+0x2F` | line 705, `+0x31` |
| final old header field | line 706, `+0x37` | line 707, `+0x41` |
| seat loop | line 712, `+0x58` | line 713, `+0x62` |
| final mapped line | line 767, `+0x1A4` | line 768, `+0x1AE` |
| function size | `0x1A8` | `0x1B2` |

The ten-byte machine-code increase is therefore not a changed result row. It
is one inserted `Encode1` call in the header plus the compiler's two-byte
instruction-size change around the adjacent calls.

The ordinary `CGameSession::SendGameResult` line tables identify the new
field unambiguously. The 2004 map goes from the winner field directly to the
later calculator setup. The exact 2005 PDB has one extra source line there,
and the corresponding assembly calls strategy vtable `+44`,
`GetResultViewType()`. The later wire head is:

```text
flag, winner, result-view, ladder, different-team-used-item
```

The matching 2004 client head is:

```text
flag, winner, ladder, different-team-used-item
```

Practice writes zero for each non-winner header value, which hid the semantic
difference in packet logs. It did not hide the byte insertion: the fifth zero
made the client consume that byte as slot 0's row marker, shifting every
remaining field and eventually overrunning its expected result layout.

For one human and one AI, the compatible packet is therefore 34 bytes,
including packet type, rather than 35 bytes.

## Fix

Both result serializers now emit the four-byte Taiwan-client header:

- `CGameSession::SendGameResult` omits the later strategy result-view byte.
- `CPracticeSession::SendGameResult` emits four header values before the seat
  rows.

The strategy classes retain `GetResultViewType()` because it is a real member
of the exact 2005 object/vtable layout and guild logic still identifies that
build accurately. It is not serialized into the older client protocol.

No result-row value, marker, or tail was removed:

- human marker remains `1`,
- AI marker remains `2`,
- human global serial remains `E4`,
- result/kill/save remain `E1`,
- both experience percentages and look level remain `E2`,
- AI level remains `E2`,
- empty seats remain marker `0`,
- the per-human trailing zero remains present.

## Statistics storage correction retained

`CGameSession+11684` is one `CDynInfoCalculator` object of size `0x254`.
Result statistics must come from that object:

| Session offset | Calculator offset | Native accessor |
| --- | --- | --- |
| `+12016` (`+0x2EF0`) | `+0x14C` | `GetSaveCount(slot)` |
| `+12048` (`+0x2F10`) | `+0x16C` | `GetKillCount(slot)` |
| `+12208` (`+0x2FB0`) | `+0x20C` | `GetMyTeamNo(slot)` |
| `+12240` (`+0x2FD0`) | `+0x22C` | `GetOtherTeamNo(slot)` |

Event 4 calls `SetKillerIndex(victim, killer)`, so the reported AI-slot-1
death with human slot 0 as killer still produces human `kill=1` in `163`.

`LaunchGameStage` now also reproduces native `00420D66..00420DEF`: every
valid seat starts with an inclusive own-team count of one, each later
same-colour pair increments both own-team counts, and each different-colour
pair increments both opposing-team counts. Practice AI seats participate via
the virtual `IsPlayerSet` predicate.

## Adjacent native corrections

The same full-chain audit also corrected two confirmed differences:

- packet 80/81/86 bomber selections are decoded modulo
  `CBomberAttr::GetTotalCount() + 1`, as in the native inline loops;
- a non-standby chief in either `CanStartGame` implementation causes the
  native error report and virtual `DumpLog()` call, but does not return error
  2 from that branch.

These changes do not alter Practice's immediate-start behavior or ordinary
rooms' TCP109/UDP readiness gate.

## Return-stage compatibility

The settlement chain remains intact:

- `163` enters phase 2,
- `164` waits for more than 8,000 ms after `EndGame`,
- Practice `164` carries code `3`,
- the human and AI roster remains seated,
- round-only state is cleared,
- a later `106` can launch another round,
- Practice's `DeferBanChief` remains the native empty override.

## Regression coverage

The tests now cover:

- the complete encrypted Practice `106 -> 115 -> 116 -> 173 -> 150` start,
- `146/event4 -> 159 -> 146/event6 -> 163`,
- the exact 34-byte one-human/one-AI result boundaries,
- human and AI kill/save counters,
- delayed `164(code=3)` and relaunch,
- the four-byte ordinary-room result header,
- native own-team/opposing-team initialization, including Practice AI,
- packet-86 bomber-selection modulo,
- the diagnostic-only non-standby-chief branch,
- ordinary-room TCP109 plus UDP readiness behavior.

Run from `server-ts/` with the pinned preview toolchain:

```sh
bun run check:toolchain
bun run typecheck
bun test
```
