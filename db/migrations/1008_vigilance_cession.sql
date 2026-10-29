-- CE08 · Vigilance renforcée de la cession d'un fonds (M16) [R118, R14, R15, R17].
-- L'acquéreur du dossier de cession (personne physique ou morale), versionné ; une alerte au responsable de la
-- conformité, une seule par dossier, quand manquent au coffre les bénéficiaires effectifs (personne morale) ou
-- l'origine des fonds, une seule par acquéreur ; la décision du responsable, une seule. Aucune pièce ni donnée de fonds ici : le coffre les garde.
CREATE TABLE IF NOT EXISTS business_transfer_buyers (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES business_transfer_files (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  legal_person INTEGER NOT NULL CHECK (legal_person IN (0, 1)),
  version INTEGER NOT NULL CHECK (version >= 1),
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (file_id, version),
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS business_transfer_watch (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  file_id TEXT NOT NULL REFERENCES business_transfer_files (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  -- Personne morale (rangée telle, ou signe de société au coffre ou à l'identification) au moment de l'alerte.
  legal_person INTEGER NOT NULL CHECK (legal_person IN (0, 1)),
  -- Ce qui manquait au coffre quand l'alerte a été levée : `beneficiaires_effectifs`, `origine_des_fonds`.
  missing TEXT NOT NULL CHECK (json_valid(missing)),
  raised_by TEXT NOT NULL,
  raised_at TEXT NOT NULL,
  -- Une seule alerte par dossier et par acquéreur : un acquéreur substitué est examiné à son tour.
  UNIQUE (file_id, person_id, legal_person),
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS business_transfer_watch_decisions (
  alert_id TEXT PRIMARY KEY REFERENCES business_transfer_watch (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('classee', 'origine_des_fonds_demandee', 'vigilance_maintenue')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  validator_name TEXT NOT NULL CHECK (length(trim(validator_name)) > 0),
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS business_transfer_buyers_fige BEFORE UPDATE ON business_transfer_buyers BEGIN SELECT RAISE(ABORT, 'business_transfer_buyers : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS business_transfer_buyers_garde BEFORE DELETE ON business_transfer_buyers BEGIN SELECT RAISE(ABORT, 'business_transfer_buyers : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS business_transfer_watch_fige BEFORE UPDATE ON business_transfer_watch BEGIN SELECT RAISE(ABORT, 'business_transfer_watch : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS business_transfer_watch_garde BEFORE DELETE ON business_transfer_watch BEGIN SELECT RAISE(ABORT, 'business_transfer_watch : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS business_transfer_watch_decisions_fige BEFORE UPDATE ON business_transfer_watch_decisions BEGIN SELECT RAISE(ABORT, 'business_transfer_watch_decisions : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS business_transfer_watch_decisions_garde BEFORE DELETE ON business_transfer_watch_decisions BEGIN SELECT RAISE(ABORT, 'business_transfer_watch_decisions : rien ne s''efface'); END;
