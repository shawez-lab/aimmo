-- S06 · Contrôle central des envois : ce qu'il faut en plus pour l'anti-doublon et le journal des envois.
-- Uniquement des tables nouvelles, pour que le script se rejoue sans erreur. Rien n'est jamais effacé [R17].
-- Le numéro 0002 reste à la tâche S07, journal à empreintes.

-- Sujets d'un message parti : un bien proposé, une relance ou une alerte sur un sujet donné [R05].
-- Un même sujet ne part qu'une fois par personne, toutes fiches fusionnées comprises, sur tous les canaux.
CREATE TABLE IF NOT EXISTS message_subjects (
  message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, subject),
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS message_subjects_person ON message_subjects (person_id, subject);

-- Journal des envois et des refus [R13], en ajout seul. Aucune donnée personnelle en clair :
-- des identifiants internes, le canal, le type, la règle appliquée et une raison écrite sans donnée de la fiche.
-- Le journal à empreintes de S07 reprendra ces lignes.
CREATE TABLE IF NOT EXISTS send_log (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT,
  person_id TEXT NOT NULL,
  message_id TEXT REFERENCES messages (id) ON DELETE RESTRICT,
  channel TEXT NOT NULL,
  kind TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('sent', 'refused', 'failed')),
  rule TEXT,
  reason TEXT NOT NULL,
  ai_text INTEGER NOT NULL DEFAULT 0 CHECK (ai_text IN (0, 1)),
  fallback_text INTEGER NOT NULL DEFAULT 0 CHECK (fallback_text IN (0, 1)),
  with_mention INTEGER NOT NULL DEFAULT 0 CHECK (with_mention IN (0, 1)),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS send_log_person ON send_log (person_id, occurred_at);
CREATE INDEX IF NOT EXISTS send_log_message ON send_log (message_id);
