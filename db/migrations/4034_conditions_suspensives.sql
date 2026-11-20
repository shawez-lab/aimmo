-- AU082 · Chaque condition suspensive autre que le prêt (vente d'un autre bien, permis de construire, certificat
-- d'urbanisme, autre condition) a son responsable, sa date limite, son état et son justificatif, et ses propres
-- alertes [R10, R17, R61].
--
-- Une ligne par saisie de l'agent du dossier, avec sa preuve ; une correction ou un changement d'état s'ajoute en
-- nouvelle version, l'ancienne reste [R17]. Le prêt garde sa date limite dans l'échéancier et son suivi dans le
-- financement.
CREATE TABLE IF NOT EXISTS sale_file_conditions (
  file_id TEXT NOT NULL REFERENCES sale_files (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('vente_autre_bien', 'permis_construire', 'certificat_urbanisme', 'autre')),
  version INTEGER NOT NULL CHECK (version >= 1),
  responsible TEXT NOT NULL CHECK (responsible IN ('acquereur', 'vendeur', 'notaire', 'agent')),
  due_day TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('en_attente', 'realisee', 'defaillie', 'renoncee')),
  proof_ref TEXT NOT NULL,
  at TEXT NOT NULL,
  by TEXT NOT NULL,
  PRIMARY KEY (file_id, kind, version)
);
-- Les alertes de l'agent, une par condition, par sorte d'alerte et par date (`due_day` vide : à saisir).
CREATE TABLE IF NOT EXISTS sale_file_condition_tasks (
  file_id TEXT NOT NULL REFERENCES sale_files (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('vente_autre_bien', 'permis_construire', 'certificat_urbanisme', 'autre')),
  alert TEXT NOT NULL CHECK (alert IN ('a_saisir', 'avant_echeance', 'echue')),
  due_day TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (file_id, kind, alert, due_day, agent_id)
);
CREATE INDEX IF NOT EXISTS sale_file_condition_tasks_agent ON sale_file_condition_tasks (network_id, agent_id, created_at);
CREATE TRIGGER IF NOT EXISTS sale_file_conditions_fige BEFORE UPDATE ON sale_file_conditions BEGIN SELECT RAISE(ABORT, 'sale_file_conditions : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS sale_file_conditions_sans_effacement BEFORE DELETE ON sale_file_conditions BEGIN SELECT RAISE(ABORT, 'sale_file_conditions : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS sale_file_condition_tasks_fige BEFORE UPDATE ON sale_file_condition_tasks BEGIN SELECT RAISE(ABORT, 'sale_file_condition_tasks : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS sale_file_condition_tasks_sans_effacement BEFORE DELETE ON sale_file_condition_tasks BEGIN SELECT RAISE(ABORT, 'sale_file_condition_tasks : rien ne s''efface'); END;
