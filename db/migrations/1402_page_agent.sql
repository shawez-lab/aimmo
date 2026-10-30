-- AT03 · Page de chaque agent, avec ses mentions [R152]. Chaque réglage s'ajoute, rien ne s'efface ni ne se réécrit.
-- Mentions légales de l'agent : statut d'agent commercial, numéro et greffe de son immatriculation.
CREATE TABLE IF NOT EXISTS agent_legal_mentions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  legal_status TEXT NOT NULL CHECK (legal_status IN ('agent_commercial')),
  rsac_number TEXT NOT NULL CHECK (length(rsac_number) BETWEEN 9 AND 40),
  rsac_registry TEXT NOT NULL CHECK (length(rsac_registry) BETWEEN 2 AND 80),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS agent_legal_mentions_agent ON agent_legal_mentions (agent_id, set_at);

-- Le titulaire de la carte professionnelle du réseau (la société), à côté du numéro de `listing_settings` (H09).
CREATE TABLE IF NOT EXISTS card_holders (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  holder_name TEXT NOT NULL CHECK (length(holder_name) BETWEEN 2 AND 120),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS card_holders_network ON card_holders (network_id, set_at);

CREATE TRIGGER IF NOT EXISTS agent_legal_mentions_garde BEFORE DELETE ON agent_legal_mentions BEGIN SELECT RAISE(ABORT, 'agent_legal_mentions : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS agent_legal_mentions_fige BEFORE UPDATE ON agent_legal_mentions BEGIN SELECT RAISE(ABORT, 'agent_legal_mentions : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS card_holders_garde BEFORE DELETE ON card_holders BEGIN SELECT RAISE(ABORT, 'card_holders : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS card_holders_fige BEFORE UPDATE ON card_holders BEGIN SELECT RAISE(ABORT, 'card_holders : rien ne se réécrit'); END;
