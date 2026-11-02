-- B04a · Le palier de chaque automatisation du site : en ombre, à 10 % des envois, partout [R26].
-- Une seule ligne par automatisation, son état courant ; chaque changement est écrit au journal chaîné.
-- Ni adresse, ni texte, ni référence d'un envoi : des nombres et des dates [R13].
CREATE TABLE IF NOT EXISTS automation_rollouts (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  automation TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('shadow', 'ten_percent', 'everywhere')),
  stage_since TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  last_incident_at TEXT,
  last_incident_kind TEXT CHECK (last_incident_kind IS NULL OR last_incident_kind IN ('unexplained_gap', 'failure')),
  PRIMARY KEY (network_id, automation)
);
