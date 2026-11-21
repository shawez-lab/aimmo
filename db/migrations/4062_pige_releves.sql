-- AU034 · Les relèves de la pige par le vrai fournisseur (M01, M02) [R671, R17].
-- Chaque passage de la relève quotidienne laisse une ligne : quand, réussi ou en panne, combien d'annonces, et pour une
-- panne une raison d'une liste fermée. Jamais l'adresse du fournisseur, sa clé, un texte d'erreur ni une annonce.
-- Table nouvelle, en ajout seul : rien ne change ni ne s'efface.
CREATE TABLE IF NOT EXISTS pige_runs (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  ran_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'panne')),
  received INTEGER NOT NULL DEFAULT 0 CHECK (received >= 0),
  added INTEGER NOT NULL DEFAULT 0 CHECK (added >= 0),
  no_agency INTEGER NOT NULL DEFAULT 0 CHECK (no_agency >= 0),
  outside INTEGER NOT NULL DEFAULT 0 CHECK (outside >= 0),
  unreadable INTEGER NOT NULL DEFAULT 0 CHECK (unreadable >= 0),
  failure TEXT CHECK (failure IS NULL OR failure IN ('acces_refuse', 'fournisseur_indisponible', 'reponse_illisible', 'releve_incomplete', 'reseau', 'autre')),
  CHECK ((outcome = 'ok' AND failure IS NULL) OR (outcome = 'panne' AND failure IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS pige_runs_network ON pige_runs (network_id, ran_at);
CREATE TRIGGER IF NOT EXISTS pige_runs_fige BEFORE UPDATE ON pige_runs BEGIN SELECT RAISE(ABORT, 'pige_runs : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS pige_runs_garde BEFORE DELETE ON pige_runs BEGIN SELECT RAISE(ABORT, 'pige_runs : rien ne s''efface'); END;
