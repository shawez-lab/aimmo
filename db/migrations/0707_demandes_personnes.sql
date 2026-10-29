-- L07 · Demandes des personnes en moins d'un mois, avec preuve [R04, R17, R96].

-- Chaque demande d'une personne (accès, rectification, effacement, opposition), avec sa date de réception, son canal
-- et son échéance d'un mois calculée par le code. En ajout seul. L'opposition garde l'exclusion « arrêt » qu'elle a
-- posée sur tous les canaux.
CREATE TABLE IF NOT EXISTS person_requests (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES persons (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('acces', 'rectification', 'effacement', 'opposition')),
  channel TEXT NOT NULL CHECK (channel IN ('mail', 'courrier', 'telephone', 'sur_place', 'message', 'formulaire')),
  received_on TEXT NOT NULL CHECK (length(received_on) = 10),
  due_on TEXT NOT NULL CHECK (length(due_on) = 10),
  exclusion_id TEXT REFERENCES exclusions (id) ON DELETE RESTRICT,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS person_requests_network ON person_requests (network_id, due_on);

-- Ce que le code a préparé pour une demande : la réponse d'accès ou le plan d'effacement, par leur seule empreinte.
-- Aucune copie des données de la personne n'est gardée ici.
CREATE TABLE IF NOT EXISTS person_request_outputs (
  request_id TEXT NOT NULL REFERENCES person_requests (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('reponse_acces', 'plan_effacement')),
  mode TEXT NOT NULL CHECK (mode IN ('essai', 'reel')),
  output_sha256 TEXT NOT NULL CHECK (length(output_sha256) = 64),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (request_id, output_sha256)
);

-- La réponse donnée, une seule par demande, avec son empreinte : la preuve.
CREATE TABLE IF NOT EXISTS person_request_answers (
  request_id TEXT PRIMARY KEY REFERENCES person_requests (id) ON DELETE RESTRICT,
  answer_sha256 TEXT NOT NULL CHECK (length(answer_sha256) = 64),
  answered_on TEXT NOT NULL CHECK (length(answered_on) = 10),
  late INTEGER NOT NULL CHECK (late IN (0, 1)),
  answered_by TEXT NOT NULL,
  answered_at TEXT NOT NULL
);

-- Les alertes au responsable : 7 jours avant l'échéance, puis le jour de l'échéance, une seule fois chacune.
CREATE TABLE IF NOT EXISTS person_request_alerts (
  request_id TEXT NOT NULL REFERENCES person_requests (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('rappel', 'echeance')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (request_id, kind)
);

CREATE TRIGGER IF NOT EXISTS person_requests_sans_changement BEFORE UPDATE ON person_requests BEGIN SELECT RAISE(ABORT, 'demande gardée'); END;
CREATE TRIGGER IF NOT EXISTS person_requests_sans_effacement BEFORE DELETE ON person_requests BEGIN SELECT RAISE(ABORT, 'demande gardée'); END;
CREATE TRIGGER IF NOT EXISTS person_request_outputs_sans_changement BEFORE UPDATE ON person_request_outputs BEGIN SELECT RAISE(ABORT, 'empreinte gardée'); END;
CREATE TRIGGER IF NOT EXISTS person_request_outputs_sans_effacement BEFORE DELETE ON person_request_outputs BEGIN SELECT RAISE(ABORT, 'empreinte gardée'); END;
CREATE TRIGGER IF NOT EXISTS person_request_answers_sans_changement BEFORE UPDATE ON person_request_answers BEGIN SELECT RAISE(ABORT, 'réponse gardée'); END;
CREATE TRIGGER IF NOT EXISTS person_request_answers_sans_effacement BEFORE DELETE ON person_request_answers BEGIN SELECT RAISE(ABORT, 'réponse gardée'); END;
CREATE TRIGGER IF NOT EXISTS person_request_alerts_sans_changement BEFORE UPDATE ON person_request_alerts BEGIN SELECT RAISE(ABORT, 'alerte gardée'); END;
CREATE TRIGGER IF NOT EXISTS person_request_alerts_sans_effacement BEFORE DELETE ON person_request_alerts BEGIN SELECT RAISE(ABORT, 'alerte gardée'); END;
