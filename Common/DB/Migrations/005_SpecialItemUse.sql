-- Modern durable positive-quantity146/case0 receipt. NOT a recovered native
-- table, shop/billing transaction, 144 money/161 house receipt, or full journal.
-- Full inventory metadata CAS + decrement/delete and immutable exact159 commit
-- in ONE root IMMEDIATE transaction. Zero-quantity relays never enter this table.
CREATE TABLE RuntimeSpecialItemUse (
  RoundID TEXT NOT NULL CHECK (length(RoundID) = 36),
  UseSequence INTEGER NOT NULL CHECK (UseSequence BETWEEN 1 AND 4294967295),
  Digest TEXT NOT NULL CHECK (length(Digest) = 64),
  ChannelIndex INTEGER NOT NULL CHECK (ChannelIndex BETWEEN 0 AND 4294967295),
  SessionIndex INTEGER NOT NULL CHECK (SessionIndex BETWEEN 0 AND 254),
  SessionSerialNo INTEGER NOT NULL CHECK (SessionSerialNo BETWEEN 0 AND 4294967295),
  StartTick INTEGER NOT NULL CHECK (StartTick BETWEEN 0 AND 4294967295),
  Payload TEXT NOT NULL,
  --159 opcode + common header(1+2+2) +opaque/itemIndex/quantity; SN is NOT echoed.
  Packet BLOB NOT NULL CHECK (length(Packet) = 9),
  CommittedAt INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (RoundID, UseSequence)
) STRICT;
CREATE INDEX IX_RuntimeSpecialItemUse_Room
 ON RuntimeSpecialItemUse(ChannelIndex,SessionIndex,SessionSerialNo,CommittedAt);
CREATE TRIGGER RuntimeSpecialItemUse_NoUpdate BEFORE UPDATE ON RuntimeSpecialItemUse
BEGIN SELECT RAISE(ABORT, 'Special-item receipts are immutable'); END;
CREATE TRIGGER RuntimeSpecialItemUse_NoDelete BEFORE DELETE ON RuntimeSpecialItemUse
BEGIN SELECT RAISE(ABORT, 'Special-item receipts are immutable'); END;
CREATE TRIGGER RuntimeSpecialItemUse_ClosedRound BEFORE INSERT ON RuntimeSpecialItemUse
WHEN EXISTS (SELECT 1 FROM RuntimeGameResult WHERE RoundID = NEW.RoundID)
BEGIN SELECT RAISE(ABORT, 'Special-item round is already settled'); END;
