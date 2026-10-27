-- T06 · Compte rendu de visite dicté. La dictée brute de l'agent est gardée telle quelle avec le compte rendu, qui
-- n'en porte que ce qu'elle dit ; le vendeur ne le reçoit qu'après validation de l'agent, sans le nom ni les
-- coordonnées de l'acquéreur [R52]. Rien ne s'efface ; un compte rendu validé ne change plus [R17].

CREATE TABLE IF NOT EXISTS visit_reports (
  appointment_id TEXT PRIMARY KEY REFERENCES visits (appointment_id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  dictation TEXT NOT NULL CHECK (length(dictation) BETWEEN 1 AND 5000),
  -- Le compte rendu, en JSON contrôlé : avis, points forts, réserves, intérêt, prêt à faire une offre.
  report TEXT,
  source TEXT CHECK (source IS NULL OR source IN ('ai', 'agent')),
  status TEXT NOT NULL CHECK (status IN ('brouillon', 'valide')),
  validated_by TEXT,
  validated_at TEXT,
  -- L'envoi au vendeur : `sent` (en essai : rangé), `waiting` pour l'heure [R01], `refused`, `failed`.
  delivery_status TEXT CHECK (delivery_status IS NULL OR delivery_status IN ('sent', 'waiting', 'refused', 'failed')),
  delivery_rule TEXT,
  message_id TEXT REFERENCES messages (id) ON DELETE RESTRICT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS visit_reports_garde BEFORE DELETE ON visit_reports BEGIN SELECT RAISE(ABORT, 'compte rendu gardé'); END;
CREATE TRIGGER IF NOT EXISTS visit_reports_fige
BEFORE UPDATE ON visit_reports
WHEN OLD.status = 'valide' AND (NEW.report IS NOT OLD.report OR NEW.dictation IS NOT OLD.dictation OR NEW.status IS NOT OLD.status OR NEW.validated_at IS NOT OLD.validated_at)
BEGIN
  SELECT RAISE(ABORT, 'compte rendu validé : figé');
END;

-- Les suites d'une visite : une relance de l'acquéreur, et « préparer l'offre » s'il se dit prêt ; une seule de chaque.
CREATE TABLE IF NOT EXISTS visit_tasks (
  appointment_id TEXT NOT NULL REFERENCES visits (appointment_id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('relance_acquereur', 'preparer_offre')),
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  due_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  done_at TEXT,
  PRIMARY KEY (appointment_id, kind)
);
CREATE INDEX IF NOT EXISTS visit_tasks_agent ON visit_tasks (network_id, agent_id, done_at, due_at);
CREATE TRIGGER IF NOT EXISTS visit_tasks_garde BEFORE DELETE ON visit_tasks BEGIN SELECT RAISE(ABORT, 'tâche gardée'); END;
