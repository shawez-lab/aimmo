-- J03 · Entretien préparé à partir du déclaré, mené et décidé par un humain (M14) [R81, R14, R17].
-- Un entretien est fixé par la direction, avec la personne qui le mène.
CREATE TABLE IF NOT EXISTS candidate_interviews (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  candidate_id TEXT NOT NULL REFERENCES candidates (id) ON DELETE RESTRICT,
  scheduled_at TEXT NOT NULL,
  interviewer TEXT NOT NULL CHECK (length(interviewer) BETWEEN 1 AND 80),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS candidate_interviews_candidate ON candidate_interviews (candidate_id, scheduled_at);
CREATE TRIGGER IF NOT EXISTS candidate_interviews_garde BEFORE DELETE ON candidate_interviews BEGIN SELECT RAISE(ABORT, 'candidate_interviews : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS candidate_interviews_fige BEFORE UPDATE ON candidate_interviews BEGIN SELECT RAISE(ABORT, 'candidate_interviews : un entretien rangé ne change plus'); END;

-- Un entretien tenu : marqué par la direction, une fois sa date passée, avec la personne qui l'a mené.
CREATE TABLE IF NOT EXISTS candidate_interview_outcomes (
  interview_id TEXT PRIMARY KEY REFERENCES candidate_interviews (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  held_by_name TEXT NOT NULL CHECK (length(held_by_name) BETWEEN 2 AND 80),
  marked_by TEXT NOT NULL,
  marked_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS candidate_interview_outcomes_garde BEFORE DELETE ON candidate_interview_outcomes BEGIN SELECT RAISE(ABORT, 'candidate_interview_outcomes : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS candidate_interview_outcomes_fige BEFORE UPDATE ON candidate_interview_outcomes BEGIN SELECT RAISE(ABORT, 'candidate_interview_outcomes : un entretien tenu ne change plus'); END;

-- La décision d'entrée : prise par un humain nommé, avec son motif écrit. Aucune note, aucun score.
-- Une décision rangée ne change plus ; une nouvelle s'ajoute, la dernière compte [R17].
CREATE TABLE IF NOT EXISTS candidate_decisions (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  candidate_id TEXT NOT NULL REFERENCES candidates (id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('oui', 'non', 'a_revoir')),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 5 AND 1000),
  decided_by TEXT NOT NULL,
  decider_name TEXT NOT NULL CHECK (length(decider_name) BETWEEN 2 AND 80),
  -- Pour un « oui » : l'entretien tenu sur lequel il repose.
  interview_id TEXT REFERENCES candidate_interview_outcomes (interview_id) ON DELETE RESTRICT,
  decided_at TEXT NOT NULL,
  CHECK (decision <> 'oui' OR interview_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS candidate_decisions_candidate ON candidate_decisions (candidate_id, decided_at);
CREATE TRIGGER IF NOT EXISTS candidate_decisions_garde BEFORE DELETE ON candidate_decisions BEGIN SELECT RAISE(ABORT, 'candidate_decisions : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS candidate_decisions_fige BEFORE UPDATE ON candidate_decisions BEGIN SELECT RAISE(ABORT, 'candidate_decisions : une décision rangée ne change plus'); END;
