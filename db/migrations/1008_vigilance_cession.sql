-- CE08 · Vigilance renforcée de la cession d'un fonds (M16) [R118, R14, R15, R17].
-- L'acquéreur du dossier de cession (personne physique ou morale), versionné ; une alerte au responsable de la
-- conformité, une seule par dossier, quand manquent au coffre les bénéficiaires effectifs (personne morale) ou
-- l'origine des fonds ; la décision du responsable, une seule. Aucune pièce ni donnée de fonds ici : le coffre les garde.
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

CREATE TABLE IF NOT EXISTS business_transfer_vigilance (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  file_id TEXT NOT NULL UNIQUE REFERENCES business_transfer_files (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  -- Ce qui manquait au coffre quand l'alerte a été levée : `beneficiaires_effectifs`, `origine_des_fonds`.
  missing TEXT NOT NULL CHECK (json_valid(missing)),
  raised_by TEXT NOT NULL,
  raised_at TEXT NOT NULL,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS business_transfer_vigilance_decisions (
  alert_id TEXT PRIMARY KEY REFERENCES business_transfer_vigilance (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('classee', 'origine_des_fonds_demandee', 'vigilance_maintenue')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  validator_name TEXT NOT NULL CHECK (length(trim(validator_name)) > 0),
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS business_transfer_buyers_fige BEFORE UPDATE ON business_transfer_buyers BEGIN SELECT RAISE(ABORT, 'business_transfer_buyers : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS business_transfer_buyers_garde BEFORE DELETE ON business_transfer_buyers BEGIN SELECT RAISE(ABORT, 'business_transfer_buyers : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS business_transfer_vigilance_fige BEFORE UPDATE ON business_transfer_vigilance BEGIN SELECT RAISE(ABORT, 'business_transfer_vigilance : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS business_transfer_vigilance_garde BEFORE DELETE ON business_transfer_vigilance BEGIN SELECT RAISE(ABORT, 'business_transfer_vigilance : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS business_transfer_vigilance_decisions_fige BEFORE UPDATE ON business_transfer_vigilance_decisions BEGIN SELECT RAISE(ABORT, 'business_transfer_vigilance_decisions : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS business_transfer_vigilance_decisions_garde BEFORE DELETE ON business_transfer_vigilance_decisions BEGIN SELECT RAISE(ABORT, 'business_transfer_vigilance_decisions : rien ne s''efface'); END;
