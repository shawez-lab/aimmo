-- J08 · Entraînement aux objections avec l'IA, sur des cas inventés (M14) [R14, R15, R80, R12, R16].
-- Aucune colonne de note, de score ni de niveau : l'entraînement ne note pas l'agent et rien n'en va à la direction.

-- Les cas écrits par la direction, en plus de ceux du code. Jamais une coordonnée ni une fiche de client.
CREATE TABLE IF NOT EXISTS training_cases (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('vendeur', 'acquereur')),
  objection TEXT NOT NULL CHECK (objection IN ('honoraires', 'exclusivite', 'prix')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 120),
  situation TEXT NOT NULL CHECK (length(situation) BETWEEN 10 AND 800),
  opening TEXT NOT NULL CHECK (length(opening) BETWEEN 5 AND 400),
  replies TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS training_cases_garde BEFORE DELETE ON training_cases BEGIN SELECT RAISE(ABORT, 'training_cases : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS training_cases_fige BEFORE UPDATE ON training_cases BEGIN SELECT RAISE(ABORT, 'training_cases : un cas rangé ne change plus'); END;

-- Une séance d'entraînement : seule sa durée compte, en temps d'académie.
CREATE TABLE IF NOT EXISTS training_sessions (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  case_key TEXT NOT NULL CHECK (length(case_key) BETWEEN 1 AND 80),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  minutes INTEGER CHECK (minutes IS NULL OR minutes BETWEEN 1 AND 120),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS training_sessions_agent ON training_sessions (agent_id, started_at);
CREATE TRIGGER IF NOT EXISTS training_sessions_garde BEFORE DELETE ON training_sessions BEGIN SELECT RAISE(ABORT, 'training_sessions : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS training_sessions_fige BEFORE UPDATE ON training_sessions
WHEN OLD.ended_at IS NOT NULL OR NEW.id IS NOT OLD.id OR NEW.agent_id IS NOT OLD.agent_id OR NEW.case_key IS NOT OLD.case_key OR NEW.started_at IS NOT OLD.started_at
BEGIN SELECT RAISE(ABORT, 'training_sessions : seule la fin de la séance s''écrit, une fois'); END;

-- Les échanges d'une séance, lus par l'agent seul.
CREATE TABLE IF NOT EXISTS training_turns (
  session_id TEXT NOT NULL REFERENCES training_sessions (id) ON DELETE RESTRICT,
  n INTEGER NOT NULL CHECK (n >= 1),
  speaker TEXT NOT NULL CHECK (speaker IN ('agent', 'ia', 'secours')),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1200),
  at TEXT NOT NULL,
  PRIMARY KEY (session_id, n)
);
CREATE TRIGGER IF NOT EXISTS training_turns_garde BEFORE DELETE ON training_turns BEGIN SELECT RAISE(ABORT, 'training_turns : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS training_turns_fige BEFORE UPDATE ON training_turns BEGIN SELECT RAISE(ABORT, 'training_turns : un échange rangé ne change plus'); END;
