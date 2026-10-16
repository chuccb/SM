-- Modern independent house161/178 receipt. NOT a native table, Type99 money144
-- receipt, or complete world/restart journal. Each ordinal freezes board/counts,
-- generated-box allocator, full request, native wallet calculation and exact178.
CREATE TABLE RuntimeHouseClaim (
  RoundID TEXT NOT NULL CHECK (length(RoundID) = 36),
  ClaimSequence INTEGER NOT NULL CHECK (ClaimSequence BETWEEN 1 AND 4294967295),
  Digest TEXT NOT NULL CHECK (length(Digest) = 64),
  ChannelIndex INTEGER NOT NULL CHECK (ChannelIndex BETWEEN 0 AND 4294967295),
  SessionIndex INTEGER NOT NULL CHECK (SessionIndex BETWEEN 0 AND 254),
  SessionSerialNo INTEGER NOT NULL CHECK (SessionSerialNo BETWEEN 0 AND 4294967295),
  StartTick INTEGER NOT NULL CHECK (StartTick BETWEEN 0 AND 4294967295),
  Payload TEXT NOT NULL,
  -- Maximum195 distinct board cells and124 generated drops: 5+2*195+4*124=891.
  Packet BLOB NOT NULL CHECK (length(Packet) BETWEEN 5 AND 891),
  CommittedAt INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (RoundID, ClaimSequence)
) STRICT;
CREATE INDEX IX_RuntimeHouseClaim_Room
  ON RuntimeHouseClaim(ChannelIndex, SessionIndex, SessionSerialNo, CommittedAt);
CREATE TRIGGER RuntimeHouseClaim_NoUpdate BEFORE UPDATE ON RuntimeHouseClaim
BEGIN SELECT RAISE(ABORT, 'House claim receipts are immutable'); END;
CREATE TRIGGER RuntimeHouseClaim_NoDelete BEFORE DELETE ON RuntimeHouseClaim
BEGIN SELECT RAISE(ABORT, 'House claim receipts are immutable'); END;
CREATE TRIGGER RuntimeHouseClaim_ClosedRound BEFORE INSERT ON RuntimeHouseClaim
WHEN EXISTS (SELECT 1 FROM RuntimeGameResult WHERE RoundID = NEW.RoundID)
BEGIN SELECT RAISE(ABORT, 'House claim round is already settled'); END;
