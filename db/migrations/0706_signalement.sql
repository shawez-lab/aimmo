-- L05 · Signaler au responsable : dossier figé, rien au client [R16, R17, R94].

-- Un signalement d'un dossier au responsable de la conformité, avec la copie figée du dossier ce jour-là : chaque ligne
-- du dossier par son empreinte, et l'empreinte de l'ensemble. Seul le code du signalement lit ces tables.
CREATE TABLE IF NOT EXISTS suspicion_reports (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  case_ref TEXT NOT NULL,
  person_id TEXT NOT NULL,
  -- Ce que l'agent a vu, en ses mots : lu par le responsable seul.
  note TEXT NOT NULL CHECK (length(trim(note)) > 0),
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  snapshot_sha256 TEXT NOT NULL CHECK (length(snapshot_sha256) = 64),
  reported_by TEXT NOT NULL,
  reported_at TEXT NOT NULL,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS suspicion_reports_network ON suspicion_reports (network_id, reported_at);

-- La décision du responsable, seul et une seule fois : déclaration à Tracfin faite, ou pas de déclaration, avec sa
-- raison, son nom et sa date.
CREATE TABLE IF NOT EXISTS suspicion_decisions (
  report_id TEXT PRIMARY KEY REFERENCES suspicion_reports (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('declaration_faite', 'pas_de_declaration')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  validator_name TEXT NOT NULL CHECK (length(trim(validator_name)) > 0),
  decided_by TEXT NOT NULL,
  decided_on TEXT NOT NULL CHECK (length(decided_on) = 10),
  at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS suspicion_reports_sans_changement BEFORE UPDATE ON suspicion_reports BEGIN SELECT RAISE(ABORT, 'signalement gardé'); END;
CREATE TRIGGER IF NOT EXISTS suspicion_reports_sans_effacement BEFORE DELETE ON suspicion_reports BEGIN SELECT RAISE(ABORT, 'signalement gardé'); END;
CREATE TRIGGER IF NOT EXISTS suspicion_decisions_sans_changement BEFORE UPDATE ON suspicion_decisions BEGIN SELECT RAISE(ABORT, 'décision gardée'); END;
CREATE TRIGGER IF NOT EXISTS suspicion_decisions_sans_effacement BEFORE DELETE ON suspicion_decisions BEGIN SELECT RAISE(ABORT, 'décision gardée'); END;
