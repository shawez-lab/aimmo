CREATE TABLE journal (
  seq INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  subject TEXT,
  data TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE
);

CREATE INDEX journal_subject_idx ON journal (subject);
CREATE INDEX journal_at_idx ON journal (at);

-- Ajout seul : aucune ligne ne peut être modifiée ni effacée.
CREATE TRIGGER journal_sans_modification
BEFORE UPDATE ON journal
BEGIN
  SELECT RAISE(ABORT, 'journal en ajout seul');
END;

CREATE TRIGGER journal_sans_effacement
BEFORE DELETE ON journal
BEGIN
  SELECT RAISE(ABORT, 'journal en ajout seul');
END;
