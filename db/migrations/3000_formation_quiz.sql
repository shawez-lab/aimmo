-- HX63 · Quiz et attestations de formation (M14) [R570, R571, R14, R16, R17].
-- Une question renvoie toujours au module de l'académie à revoir, et souvent à une règle du réseau. Aucune colonne de
-- note, de score ni de rang : une réponse est juste ou à revoir, et seul l'agent lit ses réponses. Une attestation ne
-- change plus et se vérifie par son empreinte. Rien ne s'efface.

-- Une question, rangée par la direction, qui ne change plus ; une question retirée ne sort plus aux nouveaux quiz.
CREATE TABLE IF NOT EXISTS quiz_questions (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  module_id TEXT NOT NULL REFERENCES academy_modules (id) ON DELETE RESTRICT,
  rule_id TEXT CHECK (rule_id IS NULL OR rule_id GLOB 'R[0-9][0-9]*'),
  prompt TEXT NOT NULL CHECK (length(prompt) BETWEEN 10 AND 300),
  choices TEXT NOT NULL CHECK (json_valid(choices) AND json_array_length(choices) BETWEEN 2 AND 5),
  correct_index INTEGER NOT NULL CHECK (correct_index >= 0 AND correct_index < json_array_length(choices)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  retired_at TEXT,
  retired_by TEXT,
  CHECK ((retired_at IS NULL) = (retired_by IS NULL))
);
CREATE INDEX IF NOT EXISTS quiz_questions_module ON quiz_questions (network_id, module_id);
CREATE TRIGGER IF NOT EXISTS quiz_questions_garde BEFORE DELETE ON quiz_questions BEGIN SELECT RAISE(ABORT, 'quiz_questions : rien ne s''efface'); END;
-- Seul le retrait, une fois, est permis ; le texte, les choix, la bonne réponse, le module et la règle ne changent plus.
CREATE TRIGGER IF NOT EXISTS quiz_questions_fige BEFORE UPDATE ON quiz_questions
WHEN OLD.retired_at IS NOT NULL
  OR NEW.id IS NOT OLD.id OR NEW.network_id IS NOT OLD.network_id OR NEW.module_id IS NOT OLD.module_id
  OR NEW.rule_id IS NOT OLD.rule_id OR NEW.prompt IS NOT OLD.prompt OR NEW.choices IS NOT OLD.choices
  OR NEW.correct_index IS NOT OLD.correct_index OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'quiz_questions : une question rangée ne change plus'); END;

-- Un quiz tiré pour un agent : la portée (un parcours ou un module), les questions tirées dans l'ordre.
-- Les réponses, rangées une seule fois, ne se lisent que par l'agent lui-même.
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('track', 'module')),
  scope_ref TEXT NOT NULL CHECK (length(scope_ref) BETWEEN 1 AND 80),
  question_ids TEXT NOT NULL CHECK (json_valid(question_ids) AND json_array_length(question_ids) BETWEEN 1 AND 30),
  started_at TEXT NOT NULL,
  answers TEXT CHECK (answers IS NULL OR (json_valid(answers) AND json_array_length(answers) = json_array_length(question_ids))),
  all_right INTEGER CHECK (all_right IS NULL OR all_right IN (0, 1)),
  submitted_at TEXT,
  CHECK ((answers IS NULL) = (submitted_at IS NULL) AND (answers IS NULL) = (all_right IS NULL)),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS quiz_attempts_agent ON quiz_attempts (network_id, agent_id, started_at);
CREATE TRIGGER IF NOT EXISTS quiz_attempts_garde BEFORE DELETE ON quiz_attempts BEGIN SELECT RAISE(ABORT, 'quiz_attempts : rien ne s''efface'); END;
-- Les réponses se rangent une seule fois ; rien d'autre ne change.
CREATE TRIGGER IF NOT EXISTS quiz_attempts_fige BEFORE UPDATE ON quiz_attempts
WHEN OLD.submitted_at IS NOT NULL
  OR NEW.id IS NOT OLD.id OR NEW.network_id IS NOT OLD.network_id OR NEW.agent_id IS NOT OLD.agent_id
  OR NEW.scope_kind IS NOT OLD.scope_kind OR NEW.scope_ref IS NOT OLD.scope_ref OR NEW.question_ids IS NOT OLD.question_ids
  OR NEW.started_at IS NOT OLD.started_at
BEGIN SELECT RAISE(ABORT, 'quiz_attempts : des réponses rangées ne changent plus'); END;

-- L'attestation d'un quiz réussi sans faute, sur des modules tous faits : son document en écriture canonique et son
-- empreinte SHA-256. Aucune note dedans. Elle ne change plus ; une par quiz.
CREATE TABLE IF NOT EXISTS quiz_attestations (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES quiz_attempts (id) ON DELETE RESTRICT,
  issued_on TEXT NOT NULL CHECK (length(issued_on) = 10),
  document TEXT NOT NULL CHECK (json_valid(document)),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  issued_at TEXT NOT NULL,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS quiz_attestations_agent ON quiz_attestations (network_id, agent_id, issued_on);
CREATE TRIGGER IF NOT EXISTS quiz_attestations_garde BEFORE DELETE ON quiz_attestations BEGIN SELECT RAISE(ABORT, 'quiz_attestations : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS quiz_attestations_fige BEFORE UPDATE ON quiz_attestations BEGIN SELECT RAISE(ABORT, 'quiz_attestations : une attestation ne change plus'); END;
