-- SV02 · Ce que le travail de nuit dit de chaque copie, et les nuits où la copie a manqué [R230]. Aucune donnée d'une
-- personne : des instants, des comptes et un code de raison. Le travail écrit ici ; le Worker ne fait que lire et alerter.
CREATE TABLE IF NOT EXISTS base_copy_runs (
  id TEXT PRIMARY KEY,
  -- L'instant d'avant la photo de la base : la copie ne contient rien de plus récent.
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('copiee', 'non_sauvegardee')),
  reason TEXT CHECK (reason IS NULL OR reason IN ('cle_absente', 'cle_invalide', 'stockage_absent', 'photo_absente', 'photo_vide', 'stockage_en_panne', 'copie_echouee')),
  copy_id TEXT,
  tables_count INTEGER,
  rows_count INTEGER,
  parts_count INTEGER,
  CHECK ((outcome = 'copiee' AND reason IS NULL AND copy_id IS NOT NULL) OR (outcome = 'non_sauvegardee' AND reason IS NOT NULL AND copy_id IS NULL))
);
CREATE INDEX IF NOT EXISTS base_copy_runs_recent ON base_copy_runs (outcome, started_at);

CREATE TABLE IF NOT EXISTS base_copy_alerts (
  night TEXT PRIMARY KEY,
  last_success_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS base_copy_runs_fige BEFORE UPDATE ON base_copy_runs
BEGIN
  SELECT RAISE(ABORT, 'base_copy_runs : un compte rendu ne se réécrit pas');
END;
CREATE TRIGGER IF NOT EXISTS base_copy_runs_garde BEFORE DELETE ON base_copy_runs
BEGIN
  SELECT RAISE(ABORT, 'base_copy_runs : rien ne s''efface');
END;
CREATE TRIGGER IF NOT EXISTS base_copy_alerts_fige BEFORE UPDATE ON base_copy_alerts
BEGIN
  SELECT RAISE(ABORT, 'base_copy_alerts : une alerte ne se réécrit pas');
END;
CREATE TRIGGER IF NOT EXISTS base_copy_alerts_garde BEFORE DELETE ON base_copy_alerts
BEGIN
  SELECT RAISE(ABORT, 'base_copy_alerts : rien ne s''efface');
END;
