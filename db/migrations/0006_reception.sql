-- C01 · Réception unifiée des messages : chaque message reçu, quel que soit son canal, rangé une seule fois [R18].
-- Uniquement des tables nouvelles, pour que le script se rejoue sans erreur. Rien n'est jamais effacé [R17].
-- Le numéro 0002 reste à la tâche S07, journal à empreintes.

-- Messages reçus, au format commun. `dedup_key` = canal, type et identifiant du message chez le canal :
-- la contrainte d'unicité fait qu'un même message reçu deux fois, même en même temps, n'est rangé qu'une fois.
-- Un message illisible est rangé quand même, avec son contenu brut, et signalé à l'agent : jamais jeté.
-- La personne (`person_id`) et le message de la fiche (`message_id`) sont rattachés ensuite, par C02.
CREATE TABLE IF NOT EXISTS inbound_messages (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT,
  dedup_key TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('instagram', 'facebook', 'whatsapp', 'email', 'site')),
  kind TEXT NOT NULL CHECK (kind IN ('direct', 'comment', 'email', 'portal_email', 'form', 'site_chat', 'unreadable')),
  external_id TEXT,
  conversation_ref TEXT,
  sender_channel_id TEXT,
  sender_name TEXT,
  sender_identifiers TEXT NOT NULL DEFAULT '[]',
  subject TEXT,
  body TEXT NOT NULL DEFAULT '',
  post_ref TEXT,
  property_ref TEXT,
  portal TEXT,
  has_attachment INTEGER NOT NULL DEFAULT 0 CHECK (has_attachment IN (0, 1)),
  raw_payload TEXT,
  status TEXT NOT NULL CHECK (status IN ('received', 'processing', 'processed', 'unreadable')),
  person_id TEXT,
  message_id TEXT REFERENCES messages (id) ON DELETE RESTRICT,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (network_id, dedup_key),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS inbound_messages_status ON inbound_messages (network_id, status, received_at);
CREATE INDEX IF NOT EXISTS inbound_messages_conversation ON inbound_messages (network_id, channel, conversation_ref, received_at);
CREATE INDEX IF NOT EXISTS inbound_messages_person ON inbound_messages (person_id, received_at);

-- Journal de la réception [R13], en ajout seul : identifiants internes, canal, type et résultat, aucune donnée
-- personnelle en clair, ni texte, ni expéditeur, ni identifiant du canal.
CREATE TABLE IF NOT EXISTS reception_log (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT,
  inbound_id TEXT NOT NULL REFERENCES inbound_messages (id) ON DELETE RESTRICT,
  channel TEXT NOT NULL,
  kind TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('stored', 'duplicate', 'unreadable')),
  reason TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS reception_log_inbound ON reception_log (inbound_id, occurred_at);
