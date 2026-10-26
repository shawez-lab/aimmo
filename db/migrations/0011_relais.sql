-- C05 · Conversation et relais à l'agent [R21]. Uniquement des tables nouvelles. Rien n'est jamais effacé [R17].

-- Une conversation passée à l'agent : l'assistant s'y tait pour de bon. Une seule ligne par conversation, la
-- première raison l'emporte. Raisons : un humain a répondu, trop d'échanges, rendez-vous pris, reprise à la main.
CREATE TABLE IF NOT EXISTS conversation_handovers (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT,
  person_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('human_reply', 'exchanges', 'appointment', 'agent_takeover')),
  handed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (network_id, conversation_id),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS conversation_handovers_person ON conversation_handovers (person_id);

CREATE TRIGGER IF NOT EXISTS conversation_handovers_sans_effacement
BEFORE DELETE ON conversation_handovers
BEGIN
  SELECT RAISE(ABORT, 'conversation_handovers : rien ne s''efface');
END;

-- Ce que l'agent doit savoir : conversation à reprendre, réponse qui n'a pas pu partir. Un code, jamais un texte
-- du client ni une coordonnée [R13]. Une seule alerte par conversation et par raison.
CREATE TABLE IF NOT EXISTS agent_alerts (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT,
  person_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('exchanges', 'needs_reply')),
  created_at TEXT NOT NULL,
  seen_at TEXT,
  UNIQUE (network_id, conversation_id, reason),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS agent_alerts_agent ON agent_alerts (network_id, agent_id, seen_at);

CREATE TRIGGER IF NOT EXISTS agent_alerts_sans_effacement
BEFORE DELETE ON agent_alerts
BEGIN
  SELECT RAISE(ABORT, 'agent_alerts : rien ne s''efface');
END;

-- Réponses écrites par un humain dans l'application du canal, reçues en écho : rangées une seule fois [R18].
CREATE TABLE IF NOT EXISTS human_replies (
  dedup_key TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  message_id TEXT REFERENCES messages (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (network_id, dedup_key)
);

CREATE TRIGGER IF NOT EXISTS human_replies_sans_effacement
BEFORE DELETE ON human_replies
BEGIN
  SELECT RAISE(ABORT, 'human_replies : rien ne s''efface');
END;

-- Identifiant rendu par le canal pour chaque message parti d'AIMMO : son écho n'est jamais pris pour la réponse
-- d'un humain [R21].
CREATE TABLE IF NOT EXISTS outbound_refs (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  channel TEXT NOT NULL,
  external_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (network_id, channel, external_id)
);

CREATE TRIGGER IF NOT EXISTS outbound_refs_sans_effacement
BEFORE DELETE ON outbound_refs
BEGIN
  SELECT RAISE(ABORT, 'outbound_refs : rien ne s''efface');
END;
