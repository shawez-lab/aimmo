-- J02 · Réponses de l'assistant aux questions des candidats (M14) [R80, R06, R10, R18, R03].
-- Les réponses écrites et datées par la direction, par sujet : la dernière d'un sujet compte, aucune ne s'efface.
CREATE TABLE IF NOT EXISTS recruiting_answers (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  topic TEXT NOT NULL CHECK (topic IN ('remuneration', 'frais', 'essai', 'statut', 'formation', 'parrainage', 'zone', 'outils')),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1500),
  written_by TEXT NOT NULL,
  written_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS recruiting_answers_topic ON recruiting_answers (network_id, topic, written_at);
CREATE TRIGGER IF NOT EXISTS recruiting_answers_garde BEFORE DELETE ON recruiting_answers BEGIN SELECT RAISE(ABORT, 'recruiting_answers : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS recruiting_answers_fige BEFORE UPDATE ON recruiting_answers BEGIN SELECT RAISE(ABORT, 'recruiting_answers : une réponse écrite ne change plus, une nouvelle s''ajoute'); END;

-- Les réponses préparées pour un candidat : rangées dans la boîte d'essai, jamais envoyées tant que le plan n'a pas mis
-- d'envoi en service. Une seule par question [R18].
CREATE TABLE IF NOT EXISTS candidate_replies (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  candidate_id TEXT NOT NULL REFERENCES candidates (id) ON DELETE RESTRICT,
  question_key TEXT NOT NULL CHECK (length(question_key) BETWEEN 1 AND 128),
  topic TEXT,
  answer_id TEXT REFERENCES recruiting_answers (id) ON DELETE RESTRICT,
  body TEXT NOT NULL,
  with_mention INTEGER NOT NULL CHECK (with_mention IN (0, 1)),
  mode TEXT NOT NULL CHECK (mode = 'essai'),
  prepared_at TEXT NOT NULL,
  UNIQUE (candidate_id, question_key)
);
CREATE INDEX IF NOT EXISTS candidate_replies_candidate ON candidate_replies (candidate_id, prepared_at);
CREATE TRIGGER IF NOT EXISTS candidate_replies_garde BEFORE DELETE ON candidate_replies BEGIN SELECT RAISE(ABORT, 'candidate_replies : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS candidate_replies_fige BEFORE UPDATE ON candidate_replies BEGIN SELECT RAISE(ABORT, 'candidate_replies : une réponse préparée ne change plus'); END;

-- Une question sans réponse écrite : une tâche pour la direction.
CREATE TABLE IF NOT EXISTS recruiting_tasks (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  candidate_id TEXT NOT NULL REFERENCES candidates (id) ON DELETE RESTRICT,
  question_key TEXT NOT NULL,
  topic TEXT,
  created_at TEXT NOT NULL,
  done_at TEXT,
  done_by TEXT,
  UNIQUE (candidate_id, question_key)
);
CREATE INDEX IF NOT EXISTS recruiting_tasks_open ON recruiting_tasks (network_id, done_at, created_at);
CREATE TRIGGER IF NOT EXISTS recruiting_tasks_garde BEFORE DELETE ON recruiting_tasks BEGIN SELECT RAISE(ABORT, 'recruiting_tasks : rien ne s''efface'); END;
