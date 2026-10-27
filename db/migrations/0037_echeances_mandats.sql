-- D06 · Échéances des mandats : une tâche pour l'agent avant chaque échéance, une seule par échéance.
CREATE TABLE IF NOT EXISTS mandate_tasks (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  mandate_id TEXT NOT NULL REFERENCES mandates (id) ON DELETE RESTRICT,
  -- `fin_mandat` : la fin du mandat, renouvellement à proposer ; `fin_periode_exclusive` : la fin des 3 premiers mois
  -- d'un mandat exclusif.
  kind TEXT NOT NULL CHECK (kind IN ('fin_mandat', 'fin_periode_exclusive')),
  -- Le jour de l'échéance, à Paris.
  due_day TEXT NOT NULL,
  dedup_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  done_at TEXT,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS mandate_tasks_agent ON mandate_tasks (network_id, agent_id, done_at, due_day);
CREATE TRIGGER IF NOT EXISTS mandate_tasks_garde BEFORE DELETE ON mandate_tasks BEGIN SELECT RAISE(ABORT, 'tâche gardée'); END;
