-- AU012 · Le titre écrit à côté du nom d'un agent, réglé par la direction dans une liste fermée [R07, R152].
-- Chaque réglage s'ajoute, rien ne s'efface ni ne se réécrit. Sans réglage : « agent immobilier » (R07, en attendant H24).
CREATE TABLE IF NOT EXISTS agent_title_settings (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (title IN ('agent immobilier', 'agent commercial en immobilier', 'conseiller immobilier')),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_title_settings_network ON agent_title_settings (network_id, set_at);

CREATE TRIGGER IF NOT EXISTS agent_title_settings_garde BEFORE DELETE ON agent_title_settings BEGIN SELECT RAISE(ABORT, 'agent_title_settings : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS agent_title_settings_fige BEFORE UPDATE ON agent_title_settings BEGIN SELECT RAISE(ABORT, 'agent_title_settings : rien ne se réécrit'); END;
