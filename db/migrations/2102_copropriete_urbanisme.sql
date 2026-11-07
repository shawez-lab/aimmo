-- HX35 · Copropriété et urbanisme résumés. Table nouvelle, en ajout seul : rien ne s'efface ni ne se réécrit
-- [R17, R452]. Chaque résumé est une nouvelle version ; chaque phrase garde son document, sa page et son extrait.
CREATE TABLE IF NOT EXISTS coownership_summaries (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  file_id TEXT NOT NULL REFERENCES sale_files (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 2 AND 200000),
  hash TEXT NOT NULL CHECK (length(hash) = 64),
  prepared_by TEXT NOT NULL,
  prepared_at TEXT NOT NULL,
  UNIQUE (file_id, version)
);
CREATE TRIGGER IF NOT EXISTS coownership_summaries_garde BEFORE DELETE ON coownership_summaries BEGIN SELECT RAISE(ABORT, 'coownership_summaries : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS coownership_summaries_fige BEFORE UPDATE ON coownership_summaries BEGIN SELECT RAISE(ABORT, 'coownership_summaries : rien ne se réécrit'); END;
