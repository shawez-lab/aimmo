-- AU101b · Les jours limites de congé du bail commercial, en tâches de l'agent du bien : une par bien, sorte et jour
-- limite. Rien ne change ni ne s'efface [R17].
CREATE TABLE IF NOT EXISTS business_lease_tasks (
  property_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('conge_triennal', 'conge_fin')),
  deadline TEXT NOT NULL CHECK (length(deadline) = 10),
  expiry TEXT NOT NULL CHECK (length(expiry) = 10),
  created_at TEXT NOT NULL,
  PRIMARY KEY (property_id, kind, deadline),
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS business_lease_tasks_agent ON business_lease_tasks (network_id, agent_id, deadline);
CREATE TRIGGER IF NOT EXISTS business_lease_tasks_fige BEFORE UPDATE ON business_lease_tasks BEGIN SELECT RAISE(ABORT, 'business_lease_tasks : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS business_lease_tasks_garde BEFORE DELETE ON business_lease_tasks BEGIN SELECT RAISE(ABORT, 'business_lease_tasks : rien ne s''efface'); END;
