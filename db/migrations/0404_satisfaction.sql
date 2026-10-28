-- F05 · Satisfaction : note et commentaire rangés pour M13 (M11) [R64].
-- Un lien à usage unique par demande d'avis, rangé par l'empreinte de son jeton seulement ; il expire.
CREATE TABLE IF NOT EXISTS satisfaction_tokens (
  token_hash TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  file_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS satisfaction_tokens_file ON satisfaction_tokens (file_id, person_id);
CREATE TRIGGER IF NOT EXISTS satisfaction_tokens_garde BEFORE DELETE ON satisfaction_tokens BEGIN SELECT RAISE(ABORT, 'satisfaction_tokens : rien ne s''efface'); END;

-- Une réponse par client et par dossier, gardée pour M13 et montrée à l'agent ; jamais publiée ni envoyée comme avis.
-- La note ne sert à aucun tri des demandes d'avis [R64]. Rien ne s'efface ni ne change [R17].
CREATE TABLE IF NOT EXISTS satisfaction_answers (
  file_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  comment TEXT CHECK (comment IS NULL OR length(comment) BETWEEN 1 AND 1000),
  answered_at TEXT NOT NULL,
  PRIMARY KEY (file_id, person_id)
);
CREATE INDEX IF NOT EXISTS satisfaction_answers_agent ON satisfaction_answers (agent_id, answered_at);
CREATE TRIGGER IF NOT EXISTS satisfaction_answers_garde BEFORE DELETE ON satisfaction_answers BEGIN SELECT RAISE(ABORT, 'satisfaction_answers : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS satisfaction_answers_fige BEFORE UPDATE ON satisfaction_answers BEGIN SELECT RAISE(ABORT, 'satisfaction_answers : une réponse ne change plus'); END;
