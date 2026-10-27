-- D03 · Contrôles avant signature [R41].

-- Les faits d'un document utiles aux contrôles (prix, honoraires, qui les paie, durée), figés à sa génération.
ALTER TABLE documents ADD COLUMN facts TEXT;

-- Le barème des honoraires du réseau, en ajout seul : le dernier réglé est en vigueur. Taux en points de base du prix.
CREATE TABLE IF NOT EXISTS fee_schedules (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  max_rate_bp INTEGER NOT NULL CHECK (max_rate_bp BETWEEN 1 AND 10000),
  min_eur INTEGER NOT NULL CHECK (min_eur >= 0),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fee_schedules_network ON fee_schedules (network_id, set_at);

-- L'identité vérifiée d'une personne : la nature de la pièce vue, quand, par qui. Ni numéro ni copie de la pièce,
-- qui ne vivent que dans le coffre de la conformité [R15]. Hors de la fiche client.
CREATE TABLE IF NOT EXISTS identity_checks (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  piece TEXT NOT NULL CHECK (piece IN ('carte_identite', 'passeport', 'permis_conduire')),
  seen_at TEXT NOT NULL,
  checked_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS identity_checks_person ON identity_checks (network_id, person_id);

-- Le résultat de chaque contrôle d'un document, ligne par ligne, gardé.
CREATE TABLE IF NOT EXISTS document_checks (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE RESTRICT,
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  lines TEXT NOT NULL,
  checked_by TEXT NOT NULL,
  checked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS document_checks_document ON document_checks (document_id, checked_at);

CREATE TRIGGER IF NOT EXISTS fee_schedules_sans_changement BEFORE UPDATE ON fee_schedules BEGIN SELECT RAISE(ABORT, 'barème en ajout seul'); END;
CREATE TRIGGER IF NOT EXISTS fee_schedules_sans_effacement BEFORE DELETE ON fee_schedules BEGIN SELECT RAISE(ABORT, 'barème en ajout seul'); END;
CREATE TRIGGER IF NOT EXISTS identity_checks_sans_changement BEFORE UPDATE ON identity_checks BEGIN SELECT RAISE(ABORT, 'vérification gardée'); END;
CREATE TRIGGER IF NOT EXISTS identity_checks_sans_effacement BEFORE DELETE ON identity_checks BEGIN SELECT RAISE(ABORT, 'vérification gardée'); END;
CREATE TRIGGER IF NOT EXISTS document_checks_sans_changement BEFORE UPDATE ON document_checks BEGIN SELECT RAISE(ABORT, 'contrôle gardé'); END;
CREATE TRIGGER IF NOT EXISTS document_checks_sans_effacement BEFORE DELETE ON document_checks BEGIN SELECT RAISE(ABORT, 'contrôle gardé'); END;
