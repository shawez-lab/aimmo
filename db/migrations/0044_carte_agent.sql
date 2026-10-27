-- P05 · Les coordonnées professionnelles qu'un agent montre sur ses annonces : téléphone et adresse mail de travail.
-- Réglées par l'agent lui-même ou la direction ; chaque réglage s'ajoute, le dernier compte [R17].
CREATE TABLE IF NOT EXISTS agent_public_cards (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  phone TEXT NOT NULL CHECK (length(phone) BETWEEN 6 AND 20),
  email TEXT NOT NULL CHECK (length(email) BETWEEN 6 AND 120),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS agent_public_cards_agent ON agent_public_cards (agent_id, set_at);

CREATE TRIGGER IF NOT EXISTS agent_public_cards_sans_effacement
BEFORE DELETE ON agent_public_cards
BEGIN
  SELECT RAISE(ABORT, 'agent_public_cards : rien ne s''efface');
END;

CREATE TRIGGER IF NOT EXISTS agent_public_cards_fige
BEFORE UPDATE ON agent_public_cards
BEGIN
  SELECT RAISE(ABORT, 'agent_public_cards : un réglage rangé ne change plus');
END;
