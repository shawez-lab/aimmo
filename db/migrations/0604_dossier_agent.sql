-- J04 · Dossier d'agent et parcours d'intégration (M14) [R82, R15, R17].
-- L'entrée d'un candidat retenu : un agent, une seule fois par candidature.
CREATE TABLE IF NOT EXISTS agent_onboardings (
  agent_id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  candidate_id TEXT NOT NULL UNIQUE REFERENCES candidates (id) ON DELETE RESTRICT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS agent_onboardings_garde BEFORE DELETE ON agent_onboardings BEGIN SELECT RAISE(ABORT, 'agent_onboardings : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS agent_onboardings_fige BEFORE UPDATE ON agent_onboardings BEGIN SELECT RAISE(ABORT, 'agent_onboardings : une entrée ne change plus'); END;

-- Les pièces du dossier d'agent : une référence de stockage, jamais le contenu ; une date de fin de validité.
-- Une pièce rangée ne change plus ; une nouvelle version s'ajoute [R17]. Un projet (modèle non validé) ne compte jamais.
CREATE TABLE IF NOT EXISTS agent_file_pieces (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('contrat_agent_commercial', 'attestation_habilitation', 'immatriculation_rsac', 'assurance_rcp', 'attestation_vigilance')),
  version INTEGER NOT NULL CHECK (version >= 1),
  ref TEXT NOT NULL UNIQUE,
  issued_on TEXT NOT NULL,
  valid_until TEXT,
  is_draft INTEGER NOT NULL CHECK (is_draft IN (0, 1)),
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (agent_id, kind, version),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS agent_file_pieces_agent ON agent_file_pieces (agent_id, kind, version);
CREATE INDEX IF NOT EXISTS agent_file_pieces_until ON agent_file_pieces (network_id, valid_until);
CREATE TRIGGER IF NOT EXISTS agent_file_pieces_garde BEFORE DELETE ON agent_file_pieces BEGIN SELECT RAISE(ABORT, 'agent_file_pieces : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS agent_file_pieces_fige BEFORE UPDATE ON agent_file_pieces BEGIN SELECT RAISE(ABORT, 'agent_file_pieces : une pièce rangée ne change plus'); END;

-- Une alerte d'échéance par pièce : l'agent est prévenu une fois, 30 jours avant.
CREATE TABLE IF NOT EXISTS agent_file_alerts (
  piece_id TEXT NOT NULL REFERENCES agent_file_pieces (id) ON DELETE RESTRICT,
  alert TEXT NOT NULL CHECK (alert IN ('j30')),
  network_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (piece_id, alert)
);
CREATE TRIGGER IF NOT EXISTS agent_file_alerts_garde BEFORE DELETE ON agent_file_alerts BEGIN SELECT RAISE(ABORT, 'agent_file_alerts : rien ne s''efface'); END;
