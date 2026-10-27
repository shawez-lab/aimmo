-- V05 · Brief du rendez-vous : préparé une heure avant au moins, par le planificateur, pour le seul agent du
-- rendez-vous. Chaque élément porte sa source, ce qui manque est dit [R34]. Rien ne s'efface, un brief ne change plus.
CREATE TABLE IF NOT EXISTS appointment_briefs (
  appointment_id TEXT PRIMARY KEY REFERENCES appointments (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  -- Le brief en JSON : des éléments, chacun avec sa valeur et sa source, ou ce qui manque.
  content TEXT NOT NULL,
  missing_count INTEGER NOT NULL CHECK (missing_count >= 0),
  prepared_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS appointment_briefs_agent ON appointment_briefs (agent_id, prepared_at);

CREATE TRIGGER IF NOT EXISTS appointment_briefs_sans_effacement
BEFORE DELETE ON appointment_briefs
BEGIN
  SELECT RAISE(ABORT, 'appointment_briefs : rien ne s''efface');
END;

CREATE TRIGGER IF NOT EXISTS appointment_briefs_fige
BEFORE UPDATE ON appointment_briefs
BEGIN
  SELECT RAISE(ABORT, 'appointment_briefs : un brief ne change plus');
END;
