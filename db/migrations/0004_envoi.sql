-- S05 · Décision d'envoi : ce qu'il faut en plus de la fiche pour appliquer R01 à R04 et R11.
-- Uniquement des tables nouvelles, pour que le script se rejoue sans erreur. Rien n'est jamais effacé [R17].

-- Lien de la personne avec le réseau qui interdit certaines demandes : collègue, associé, proche [R11].
-- Un lien qui ne vaut plus garde sa ligne, avec ended_at.
CREATE TABLE IF NOT EXISTS person_relations (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT,
  person_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('colleague', 'associate', 'relative')),
  noted_at TEXT NOT NULL,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS person_relations_person ON person_relations (person_id);

-- Type d'un message parti : réponse, relance, alerte, rappel, demande d'avis, partenaire, prospection.
-- Sert aux plafonds par jour [R11]. Une ligne par message, à côté du message, sans le modifier.
CREATE TABLE IF NOT EXISTS message_kinds (
  message_id TEXT PRIMARY KEY REFERENCES messages (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('reply', 'follow_up', 'alert', 'reminder', 'review_request', 'partner', 'prospecting')),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS message_kinds_count ON message_kinds (network_id, kind, occurred_at);
