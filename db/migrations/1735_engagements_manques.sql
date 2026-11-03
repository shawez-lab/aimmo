-- IN12 · Un engagement manqué : une seule tâche « rappeler » pour le responsable [R228, R17]. La machine n'envoie rien au
-- client. La personne est la fiche gardée à la naissance de la tâche ; un engagement envers l'agent se rappelle à l'agent.
CREATE TABLE IF NOT EXISTS missed_promise_tasks (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  promise_code TEXT NOT NULL,
  -- Ce qui désigne le cas, stable d'un calcul à l'autre : une seule tâche par cas.
  case_key TEXT NOT NULL,
  -- Le jour de Paris du cas.
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  person_id TEXT,
  agent_id TEXT,
  created_at TEXT NOT NULL,
  done_at TEXT,
  done_by TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('rappele', 'injoignable', 'sans_appel')),
  UNIQUE (network_id, promise_code, case_key),
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS missed_promise_tasks_open ON missed_promise_tasks (network_id, done_at, day);
CREATE TRIGGER IF NOT EXISTS missed_promise_tasks_fin BEFORE UPDATE ON missed_promise_tasks
  WHEN OLD.done_at IS NOT NULL
    OR NEW.id IS NOT OLD.id OR NEW.network_id IS NOT OLD.network_id OR NEW.promise_code IS NOT OLD.promise_code
    OR NEW.case_key IS NOT OLD.case_key OR NEW.day IS NOT OLD.day OR NEW.person_id IS NOT OLD.person_id
    OR NEW.agent_id IS NOT OLD.agent_id OR NEW.created_at IS NOT OLD.created_at
  BEGIN SELECT RAISE(ABORT, 'missed_promise_tasks : seule sa fin s''écrit, une fois'); END;
CREATE TRIGGER IF NOT EXISTS missed_promise_tasks_garde BEFORE DELETE ON missed_promise_tasks BEGIN SELECT RAISE(ABORT, 'missed_promise_tasks : rien ne s''efface'); END;
