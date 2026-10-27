-- O05 · Les tâches de l'agent avant l'échéance d'une offre sans réponse : une seule par offre [R59]. En ajout seul [R17].
CREATE TABLE IF NOT EXISTS offer_tasks (
  offer_id TEXT PRIMARY KEY REFERENCES offer_register (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  -- Le dernier jour de validité de l'offre, à Paris.
  last_day TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS offer_tasks_agent ON offer_tasks (network_id, agent_id, last_day);
CREATE TRIGGER IF NOT EXISTS offer_tasks_fige BEFORE UPDATE ON offer_tasks BEGIN SELECT RAISE(ABORT, 'offer_tasks : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS offer_tasks_sans_effacement BEFORE DELETE ON offer_tasks BEGIN SELECT RAISE(ABORT, 'offer_tasks : rien ne s''efface'); END;
