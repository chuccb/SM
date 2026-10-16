-- Modern SQLite durability/idempotency boundary, NOT a recovered official table.
-- One opaque, server-created round ID binds one immutable canonical request and
-- scalar-coded 163 body to its atomic dynamic updates. No delivery guarantee,
-- player-session recovery or verdict authorization is implied by this receipt.
CREATE TABLE RuntimeGameResult (
  RoundID TEXT PRIMARY KEY NOT NULL CHECK (length(RoundID) = 36),
  Digest TEXT NOT NULL CHECK (length(Digest) = 64),
  ChannelIndex INTEGER NOT NULL CHECK (ChannelIndex BETWEEN 0 AND 4294967295),
  SessionIndex INTEGER NOT NULL CHECK (SessionIndex BETWEEN 0 AND 254),
  SessionSerialNo INTEGER NOT NULL CHECK (SessionSerialNo BETWEEN 0 AND 4294967295),
  Payload TEXT NOT NULL,
  Packet BLOB NOT NULL,
  CommittedAt INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
CREATE INDEX IX_RuntimeGameResult_Room
  ON RuntimeGameResult(ChannelIndex, SessionIndex, SessionSerialNo, CommittedAt);
-- Do not accidentally prune receipts and reopen an already-paid round key.
-- Retention/privacy policy and archival require a separately designed migration.
CREATE TRIGGER RuntimeGameResult_NoUpdate BEFORE UPDATE ON RuntimeGameResult
BEGIN SELECT RAISE(ABORT, 'Game result receipts are immutable'); END;
CREATE TRIGGER RuntimeGameResult_NoDelete BEFORE DELETE ON RuntimeGameResult
BEGIN SELECT RAISE(ABORT, 'Game result receipts are immutable'); END;
