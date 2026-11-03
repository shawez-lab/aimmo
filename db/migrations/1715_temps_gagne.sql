-- IN08 · Le temps gagné, déclaré par l'agent pour une semaine finie [R217, R17]. En ajout seul : une nouvelle version garde
-- l'ancienne. Aucune donnée de client. Seul le dernier chiffre de chaque agent compte, et jamais contre un autre [R14].
CREATE TABLE IF NOT EXISTS agent_time_saved (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  -- Le lundi de la semaine, à Paris.
  week TEXT NOT NULL CHECK (week GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  version INTEGER NOT NULL CHECK (version >= 1),
  minutes INTEGER NOT NULL CHECK (minutes BETWEEN 0 AND 4800),
  declared_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, week, version),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS agent_time_saved_week ON agent_time_saved (network_id, week);
CREATE TRIGGER IF NOT EXISTS agent_time_saved_fige BEFORE UPDATE ON agent_time_saved BEGIN SELECT RAISE(ABORT, 'agent_time_saved : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS agent_time_saved_garde BEFORE DELETE ON agent_time_saved BEGIN SELECT RAISE(ABORT, 'agent_time_saved : rien ne s''efface'); END;
