-- HX34 · État des risques préparé depuis la collecte de E03. Table nouvelle, en ajout seul : rien ne s'efface ni ne se
-- réécrit [R17, R447]. Chaque préparation est une nouvelle version ; les rubriques gardent leur source et leur jour.
CREATE TABLE IF NOT EXISTS risk_statements (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  file_id TEXT NOT NULL REFERENCES sale_files (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 2 AND 40000),
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  statement_date TEXT CHECK (statement_date IS NULL OR length(statement_date) = 10),
  valid_until TEXT CHECK (valid_until IS NULL OR length(valid_until) = 10),
  hash TEXT NOT NULL CHECK (length(hash) = 64),
  prepared_by TEXT NOT NULL,
  prepared_at TEXT NOT NULL,
  UNIQUE (file_id, version),
  CHECK (complete = 0 OR statement_date IS NOT NULL)
);
CREATE TRIGGER IF NOT EXISTS risk_statements_garde BEFORE DELETE ON risk_statements BEGIN SELECT RAISE(ABORT, 'risk_statements : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS risk_statements_fige BEFORE UPDATE ON risk_statements BEGIN SELECT RAISE(ABORT, 'risk_statements : rien ne se réécrit'); END;
