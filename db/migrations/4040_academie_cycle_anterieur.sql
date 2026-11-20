-- AU028 · Le cycle de formation antérieur de l'agent, repris à son intégration (M14) [R85, R10, R16, R17].
-- La direction range, avec le nom de l'humain qui le saisit et la référence de la pièce qui le prouve :
-- - `periode` : le premier jour de la période de référence en cours de l'agent (son cycle d'avant l'arrivée) ; la
--   dernière rangée l'emporte ;
-- - `formation` : une formation suivie avant l'arrivée, avec son attestation (jour, durée, thème).
-- Rien ne s'efface ni ne change : une correction est une nouvelle ligne.
CREATE TABLE IF NOT EXISTS academy_prior_entries (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('periode', 'formation')),
  day TEXT NOT NULL CHECK (length(day) = 10),
  duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 1 AND 2520),
  topic TEXT CHECK (topic IS NULL OR topic IN ('general', 'deontologie', 'non_discrimination')),
  proof_ref TEXT NOT NULL CHECK (length(proof_ref) BETWEEN 1 AND 200),
  recorded_by TEXT NOT NULL,
  recorder_name TEXT NOT NULL CHECK (length(recorder_name) BETWEEN 2 AND 80),
  recorded_at TEXT NOT NULL,
  CHECK ((kind = 'periode' AND duration_minutes IS NULL AND topic IS NULL) OR (kind = 'formation' AND duration_minutes IS NOT NULL AND topic IS NOT NULL)),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS academy_prior_entries_agent ON academy_prior_entries (agent_id, kind, recorded_at);
-- Une attestation d'avant ne se range qu'une fois pour un agent : un second envoi ne double jamais ses heures.
CREATE UNIQUE INDEX IF NOT EXISTS academy_prior_entries_preuve ON academy_prior_entries (agent_id, network_id, proof_ref) WHERE kind = 'formation';
CREATE TRIGGER IF NOT EXISTS academy_prior_entries_garde BEFORE DELETE ON academy_prior_entries BEGIN SELECT RAISE(ABORT, 'academy_prior_entries : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS academy_prior_entries_fige BEFORE UPDATE ON academy_prior_entries BEGIN SELECT RAISE(ABORT, 'academy_prior_entries : une ligne rangée ne change plus'); END;
