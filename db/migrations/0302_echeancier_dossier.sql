-- N02 · Échéancier du dossier de vente (M10). Les dates saisies avec leur preuve, une correction en nouvelle version ;
-- les tâches de l'agent, une par échéance, par date et par agent responsable du bien (`due_day` vide : date à saisir). En ajout seul [R17, R61].
CREATE TABLE IF NOT EXISTS sale_file_dates (
  file_id TEXT NOT NULL REFERENCES sale_files (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('compromis_signe', 'notification_acquereur', 'date_limite_pret', 'dia_recue', 'dia_suspension', 'dia_reprise', 'etat_date_attendu', 'acte_prevu')),
  version INTEGER NOT NULL CHECK (version >= 1),
  day TEXT NOT NULL,
  proof_ref TEXT NOT NULL,
  at TEXT NOT NULL,
  by TEXT NOT NULL,
  PRIMARY KEY (file_id, kind, version)
);
CREATE TABLE IF NOT EXISTS sale_file_tasks (
  file_id TEXT NOT NULL REFERENCES sale_files (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  deadline TEXT NOT NULL CHECK (deadline IN ('fin_retractation', 'reponse_preemption', 'date_limite_pret', 'etat_date', 'acte')),
  due_day TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (file_id, deadline, due_day, agent_id)
);
CREATE INDEX IF NOT EXISTS sale_file_tasks_agent ON sale_file_tasks (network_id, agent_id, created_at);
CREATE TRIGGER IF NOT EXISTS sale_file_dates_fige BEFORE UPDATE ON sale_file_dates BEGIN SELECT RAISE(ABORT, 'sale_file_dates : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS sale_file_dates_sans_effacement BEFORE DELETE ON sale_file_dates BEGIN SELECT RAISE(ABORT, 'sale_file_dates : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS sale_file_tasks_fige BEFORE UPDATE ON sale_file_tasks BEGIN SELECT RAISE(ABORT, 'sale_file_tasks : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS sale_file_tasks_sans_effacement BEFORE DELETE ON sale_file_tasks BEGIN SELECT RAISE(ABORT, 'sale_file_tasks : rien ne s''efface'); END;
