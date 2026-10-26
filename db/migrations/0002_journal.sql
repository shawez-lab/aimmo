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
