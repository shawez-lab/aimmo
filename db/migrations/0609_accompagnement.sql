-- J09 · Référent des 90 jours, binôme d'absence et assistance suivie (M14) [R16, R17, R15].
-- Rien ne s'efface ; un référent, un binôme, une absence rangés ne changent plus : un nouveau s'ajoute.

CREATE TABLE IF NOT EXISTS agent_referents (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  referent_id TEXT NOT NULL,
  from_day TEXT NOT NULL CHECK (length(from_day) = 10),
  until_day TEXT NOT NULL CHECK (length(until_day) = 10),
  assigned_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (agent_id <> referent_id),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (referent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS agent_referents_agent ON agent_referents (agent_id, created_at);
CREATE TRIGGER IF NOT EXISTS agent_referents_garde BEFORE DELETE ON agent_referents BEGIN SELECT RAISE(ABORT, 'agent_referents : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS agent_referents_fige BEFORE UPDATE ON agent_referents BEGIN SELECT RAISE(ABORT, 'agent_referents : un référent rangé ne change plus'); END;

-- Un binôme : deux agents, et le partage des honoraires écrit d'avance pour l'agent qui reprend pendant une absence.
CREATE TABLE IF NOT EXISTS agent_pairs (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_a TEXT NOT NULL,
  agent_b TEXT NOT NULL,
  cover_share_pct INTEGER NOT NULL CHECK (cover_share_pct BETWEEN 0 AND 100),
  written_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (agent_a < agent_b),
  FOREIGN KEY (agent_a, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_b, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS agent_pairs_agents ON agent_pairs (network_id, agent_a, agent_b, created_at);
CREATE TRIGGER IF NOT EXISTS agent_pairs_garde BEFORE DELETE ON agent_pairs BEGIN SELECT RAISE(ABORT, 'agent_pairs : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS agent_pairs_fige BEFORE UPDATE ON agent_pairs BEGIN SELECT RAISE(ABORT, 'agent_pairs : un partage écrit ne change plus'); END;

-- Une absence déclarée, avec le binôme qui reprend et le partage en vigueur à la déclaration.
CREATE TABLE IF NOT EXISTS agent_absences (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  pair_id TEXT NOT NULL REFERENCES agent_pairs (id) ON DELETE RESTRICT,
  cover_agent_id TEXT NOT NULL,
  from_day TEXT NOT NULL CHECK (length(from_day) = 10),
  until_day TEXT NOT NULL CHECK (length(until_day) = 10),
  declared_by TEXT NOT NULL,
  declared_at TEXT NOT NULL,
  CHECK (from_day <= until_day),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS agent_absences_cover ON agent_absences (cover_agent_id, from_day, until_day);
CREATE TRIGGER IF NOT EXISTS agent_absences_garde BEFORE DELETE ON agent_absences BEGIN SELECT RAISE(ABORT, 'agent_absences : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS agent_absences_fige BEFORE UPDATE ON agent_absences BEGIN SELECT RAISE(ABORT, 'agent_absences : une absence déclarée ne change plus'); END;

-- Une demande d'assistance, avec son échéance calculée en heures ouvrées.
CREATE TABLE IF NOT EXISTS assistance_requests (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('humain', 'avocat')),
  topic TEXT NOT NULL CHECK (topic IN ('mandat', 'offre', 'compromis', 'conformite', 'outil', 'autre')),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 5 AND 1000),
  created_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  answered_at TEXT,
  answered_by TEXT,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS assistance_requests_open ON assistance_requests (network_id, answered_at, due_at);
CREATE TRIGGER IF NOT EXISTS assistance_requests_garde BEFORE DELETE ON assistance_requests BEGIN SELECT RAISE(ABORT, 'assistance_requests : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS assistance_requests_fige BEFORE UPDATE ON assistance_requests
WHEN OLD.answered_at IS NOT NULL OR NEW.id IS NOT OLD.id OR NEW.body IS NOT OLD.body OR NEW.due_at IS NOT OLD.due_at OR NEW.created_at IS NOT OLD.created_at OR NEW.level IS NOT OLD.level
BEGIN SELECT RAISE(ABORT, 'assistance_requests : seule la réponse s''écrit, une fois'); END;

CREATE TABLE IF NOT EXISTS assistance_alerts (
  request_id TEXT NOT NULL REFERENCES assistance_requests (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('avant_echeance', 'echeance_depassee')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (request_id, kind)
);
CREATE TRIGGER IF NOT EXISTS assistance_alerts_garde BEFORE DELETE ON assistance_alerts BEGIN SELECT RAISE(ABORT, 'assistance_alerts : rien ne s''efface'); END;
