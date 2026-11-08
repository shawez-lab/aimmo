-- HX62 · Rapports sur mesure et export complet de l'agent (M13) [R560, R561].

-- Rapports enregistrés : une définition dans un catalogue fermé de mesures et de regroupements, jamais « par agent »
-- [R14, R560]. Une définition ne change plus et ne s'efface pas : pour la changer, on en enregistre une autre.
CREATE TABLE IF NOT EXISTS custom_reports (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  owner_id TEXT NOT NULL,
  owner_role TEXT NOT NULL CHECK (owner_role IN ('agent', 'direction')),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  definition TEXT NOT NULL CHECK (json_valid(definition) AND instr(lower(definition), 'agent') = 0),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS custom_reports_owner ON custom_reports (network_id, owner_id);
CREATE TRIGGER IF NOT EXISTS custom_reports_garde BEFORE DELETE ON custom_reports BEGIN SELECT RAISE(ABORT, 'custom_reports : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS custom_reports_fige BEFORE UPDATE ON custom_reports BEGIN SELECT RAISE(ABORT, 'custom_reports : une définition ne change plus [R560]'); END;

-- Exports complets remis à un agent : l'empreinte seule, jamais le contenu, pour qu'il prouve plus tard que le fichier
-- vient d'AIMMO et n'a pas changé [R561].
CREATE TABLE IF NOT EXISTS agent_exports (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  row_count INTEGER NOT NULL CHECK (row_count >= 1),
  made_at TEXT NOT NULL,
  UNIQUE (agent_id, fingerprint),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS agent_exports_garde BEFORE DELETE ON agent_exports BEGIN SELECT RAISE(ABORT, 'agent_exports : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS agent_exports_fige BEFORE UPDATE ON agent_exports BEGIN SELECT RAISE(ABORT, 'agent_exports : un export rangé ne change plus [R561]'); END;
