-- CE07 · Étapes de la cession d'un fonds (M16) [R116, R117, R10, R17].
-- Les communes dotées d'un périmètre de sauvegarde, rangées par la direction avec leur source ; le dossier de cession
-- d'un bien et son séquestre nommé (avocat, notaire ou banque, jamais le réseau ni un agent) ; ses dates, chacune avec sa
-- preuve, versionnées ; les déclarations « cession prête » ; une tâche à l'agent par étape et par échéance.
CREATE TABLE IF NOT EXISTS business_safeguard_communes (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  postal_code TEXT NOT NULL CHECK (length(postal_code) = 5),
  city TEXT NOT NULL CHECK (length(city) BETWEEN 1 AND 120),
  in_perimeter INTEGER NOT NULL CHECK (in_perimeter IN (0, 1)),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 3 AND 300),
  source_date TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (network_id, postal_code, city, version)
);

CREATE TABLE IF NOT EXISTS business_transfer_files (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (property_id),
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);

-- Le séquestre du prix : un tiers nommé, versionné ; AIMMO ne reçoit jamais le prix [R117].
CREATE TABLE IF NOT EXISTS business_transfer_escrows (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES business_transfer_files (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('avocat', 'notaire', 'banque')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 3 AND 160),
  version INTEGER NOT NULL CHECK (version >= 1),
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (file_id, version)
);

CREATE TABLE IF NOT EXISTS business_transfer_dates (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES business_transfer_files (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('cession_prevue', 'information_salaries', 'declaration_preemption', 'reponse_commune', 'autorisations_verifiees', 'cession_signee', 'publication_jal', 'publication_bodacc')),
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  proof_ref TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (file_id, kind, version)
);

CREATE TABLE IF NOT EXISTS business_transfer_ready (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES business_transfer_files (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  declared_by TEXT NOT NULL,
  declared_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS business_transfer_tasks (
  file_id TEXT NOT NULL REFERENCES business_transfer_files (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  step TEXT NOT NULL,
  -- Le jour de l'échéance ; vide pour une date encore à saisir.
  due_day TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (file_id, step, due_day, agent_id)
);
CREATE TRIGGER IF NOT EXISTS business_safeguard_communes_fige BEFORE UPDATE ON business_safeguard_communes BEGIN SELECT RAISE(ABORT, 'business_safeguard_communes : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS business_safeguard_communes_garde BEFORE DELETE ON business_safeguard_communes BEGIN SELECT RAISE(ABORT, 'business_safeguard_communes : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS business_transfer_files_fige BEFORE UPDATE ON business_transfer_files BEGIN SELECT RAISE(ABORT, 'business_transfer_files : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS business_transfer_files_garde BEFORE DELETE ON business_transfer_files BEGIN SELECT RAISE(ABORT, 'business_transfer_files : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS business_transfer_escrows_fige BEFORE UPDATE ON business_transfer_escrows BEGIN SELECT RAISE(ABORT, 'business_transfer_escrows : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS business_transfer_escrows_garde BEFORE DELETE ON business_transfer_escrows BEGIN SELECT RAISE(ABORT, 'business_transfer_escrows : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS business_transfer_dates_fige BEFORE UPDATE ON business_transfer_dates BEGIN SELECT RAISE(ABORT, 'business_transfer_dates : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS business_transfer_dates_garde BEFORE DELETE ON business_transfer_dates BEGIN SELECT RAISE(ABORT, 'business_transfer_dates : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS business_transfer_ready_fige BEFORE UPDATE ON business_transfer_ready BEGIN SELECT RAISE(ABORT, 'business_transfer_ready : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS business_transfer_ready_garde BEFORE DELETE ON business_transfer_ready BEGIN SELECT RAISE(ABORT, 'business_transfer_ready : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS business_transfer_tasks_fige BEFORE UPDATE ON business_transfer_tasks BEGIN SELECT RAISE(ABORT, 'business_transfer_tasks : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS business_transfer_tasks_garde BEFORE DELETE ON business_transfer_tasks BEGIN SELECT RAISE(ABORT, 'business_transfer_tasks : rien ne s''efface'); END;
