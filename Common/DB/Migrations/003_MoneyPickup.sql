-- Modern SQLite receipt, NOT a recovered native table or spawn authorization.
-- The server round UUID + contiguous successful-claim sequence identifies ONE
-- frozen money calculation. A box may legitimately reset and be claimed again;
-- neither box number nor wallet Before/After alone is a safe idempotency key.
CREATE TABLE RuntimeMoneyPickup (
  RoundID TEXT NOT NULL CHECK (length(RoundID) = 36),
  ClaimSequence INTEGER NOT NULL CHECK (ClaimSequence BETWEEN 1 AND 4294967295),
  Digest TEXT NOT NULL CHECK (length(Digest) = 64),
  ChannelIndex INTEGER NOT NULL CHECK (ChannelIndex BETWEEN 0 AND 4294967295),
  SessionIndex INTEGER NOT NULL CHECK (SessionIndex BETWEEN 0 AND 254),
  SessionSerialNo INTEGER NOT NULL CHECK (SessionSerialNo BETWEEN 0 AND 4294967295),
  StartTick INTEGER NOT NULL CHECK (StartTick BETWEEN 0 AND 4294967295),
  Payload TEXT NOT NULL,
  -- MoneyPickupRule.ResponseFieldCount4 + selector156: five scalar-coded bytes.
  Packet BLOB NOT NULL CHECK (length(Packet) = 5),
  CommittedAt INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (RoundID, ClaimSequence)
) STRICT;
CREATE INDEX IX_RuntimeMoneyPickup_Room
  ON RuntimeMoneyPickup(ChannelIndex, SessionIndex, SessionSerialNo, CommittedAt);
CREATE TRIGGER RuntimeMoneyPickup_NoUpdate BEFORE UPDATE ON RuntimeMoneyPickup
BEGIN SELECT RAISE(ABORT, 'Money pickup receipts are immutable'); END;
CREATE TRIGGER RuntimeMoneyPickup_NoDelete BEFORE DELETE ON RuntimeMoneyPickup
BEGIN SELECT RAISE(ABORT, 'Money pickup receipts are immutable'); END;
-- The application checks exact duplicates BEFORE this boundary. Replaying an
-- existing receipt is allowed after settlement; adding a NEW pickup is not.
CREATE TRIGGER RuntimeMoneyPickup_ClosedRound BEFORE INSERT ON RuntimeMoneyPickup
WHEN EXISTS (SELECT 1 FROM RuntimeGameResult WHERE RoundID = NEW.RoundID)
BEGIN SELECT RAISE(ABORT, 'Money pickup round is already settled'); END;
