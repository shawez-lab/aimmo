-- V06 · Statut et compte rendu des rendez-vous. Rien ne s'efface : un statut final ne change plus, un compte rendu
-- rangé ne change plus (un nouveau s'ajoute), une tâche faite garde sa ligne.

-- Un rendez-vous honoré ou absent ne change plus de statut. (Un rendez-vous annulé peut être repris par la base
-- quand un décalage échoue, V02 : cette reprise reste au code, jamais à l'agent.)
CREATE TRIGGER IF NOT EXISTS appointments_statut_final
BEFORE UPDATE OF status ON appointments
WHEN OLD.status IN ('honored', 'absent') AND NEW.status <> OLD.status
BEGIN
  SELECT RAISE(ABORT, 'appointments : un statut final ne change plus');
END;

-- Les comptes rendus de l'agent, texte dicté ou écrit. Le journal n'en porte jamais le texte [R13].
CREATE TABLE IF NOT EXISTS appointment_reports (
  id TEXT PRIMARY KEY,
  appointment_id TEXT NOT NULL REFERENCES appointments (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  -- `dictated` : texte dicté (la transcription viendra avec l'application de l'agent) ; `typed` : écrit.
  origin TEXT NOT NULL CHECK (origin IN ('dictated', 'typed')),
  text TEXT NOT NULL CHECK (length(text) > 0),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS appointment_reports_rdv ON appointment_reports (appointment_id, created_at);

-- La tâche qui suit un absent : une seule par rendez-vous.
CREATE TABLE IF NOT EXISTS appointment_tasks (
  id TEXT PRIMARY KEY,
  appointment_id TEXT NOT NULL UNIQUE REFERENCES appointments (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('follow_absent')),
  due_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  done_at TEXT
);
CREATE INDEX IF NOT EXISTS appointment_tasks_agent ON appointment_tasks (agent_id, done_at, due_at);

CREATE TRIGGER IF NOT EXISTS appointment_reports_sans_effacement
BEFORE DELETE ON appointment_reports
BEGIN
  SELECT RAISE(ABORT, 'appointment_reports : rien ne s''efface');
END;

CREATE TRIGGER IF NOT EXISTS appointment_reports_fige
BEFORE UPDATE ON appointment_reports
BEGIN
  SELECT RAISE(ABORT, 'appointment_reports : un compte rendu ne change plus');
END;

CREATE TRIGGER IF NOT EXISTS appointment_tasks_sans_effacement
BEFORE DELETE ON appointment_tasks
BEGIN
  SELECT RAISE(ABORT, 'appointment_tasks : rien ne s''efface');
END;
