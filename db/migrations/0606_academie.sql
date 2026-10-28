-- J06 · Académie : modules, parcours, séances, présences et compteur des heures obligatoires (M14) [R85, R14, R16, R17].
-- Aucune colonne de note, de score, de rang ni d'heure imposée : l'académie forme, elle ne note pas et n'impose aucun
-- horaire. Rien ne s'efface ; un module ou une séance rangés ne changent plus, un nouveau s'ajoute.

-- Un module court : une vidéo YouTube en accès restreint, par son identifiant, son script par sa référence de stockage.
CREATE TABLE IF NOT EXISTS academy_modules (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 120),
  track TEXT NOT NULL CHECK (track IN ('entree', 'vente', 'location', 'commerces', 'investissement', 'conformite')),
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 999),
  video_id TEXT NOT NULL CHECK (length(video_id) = 11),
  script_ref TEXT CHECK (script_ref IS NULL OR length(script_ref) BETWEEN 1 AND 200),
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 1 AND 480),
  topic TEXT NOT NULL CHECK (topic IN ('general', 'deontologie', 'non_discrimination')),
  mandatory INTEGER NOT NULL CHECK (mandatory IN (0, 1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (network_id, track, position)
);
CREATE TRIGGER IF NOT EXISTS academy_modules_garde BEFORE DELETE ON academy_modules BEGIN SELECT RAISE(ABORT, 'academy_modules : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS academy_modules_fige BEFORE UPDATE ON academy_modules BEGIN SELECT RAISE(ABORT, 'academy_modules : un module rangé ne change plus'); END;

-- Un module fait par un agent, une seule fois.
CREATE TABLE IF NOT EXISTS academy_completions (
  module_id TEXT NOT NULL REFERENCES academy_modules (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  completed_at TEXT NOT NULL,
  completed_on TEXT NOT NULL CHECK (length(completed_on) = 10),
  PRIMARY KEY (module_id, agent_id),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS academy_completions_agent ON academy_completions (agent_id, completed_on);
CREATE TRIGGER IF NOT EXISTS academy_completions_garde BEFORE DELETE ON academy_completions BEGIN SELECT RAISE(ABORT, 'academy_completions : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS academy_completions_fige BEFORE UPDATE ON academy_completions BEGIN SELECT RAISE(ABORT, 'academy_completions : un module fait ne change plus'); END;

-- Une séance en salle, en direct, mensuelle ou régionale, tenue un jour donné.
CREATE TABLE IF NOT EXISTS academy_sessions (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('salle', 'direct', 'mensuelle', 'regionale')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 120),
  held_on TEXT NOT NULL CHECK (length(held_on) = 10),
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 1 AND 480),
  topic TEXT NOT NULL CHECK (topic IN ('general', 'deontologie', 'non_discrimination')),
  mandatory INTEGER NOT NULL CHECK (mandatory IN (0, 1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS academy_sessions_garde BEFORE DELETE ON academy_sessions BEGIN SELECT RAISE(ABORT, 'academy_sessions : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS academy_sessions_fige BEFORE UPDATE ON academy_sessions BEGIN SELECT RAISE(ABORT, 'academy_sessions : une séance rangée ne change plus'); END;

-- La présence d'un agent à une séance, saisie par un humain nommé de la direction, une seule fois.
CREATE TABLE IF NOT EXISTS academy_attendance (
  session_id TEXT NOT NULL REFERENCES academy_sessions (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  recorded_by TEXT NOT NULL,
  recorder_name TEXT NOT NULL CHECK (length(recorder_name) BETWEEN 2 AND 80),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (session_id, agent_id),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS academy_attendance_agent ON academy_attendance (agent_id);
CREATE TRIGGER IF NOT EXISTS academy_attendance_garde BEFORE DELETE ON academy_attendance BEGIN SELECT RAISE(ABORT, 'academy_attendance : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS academy_attendance_fige BEFORE UPDATE ON academy_attendance BEGIN SELECT RAISE(ABORT, 'academy_attendance : une présence rangée ne change plus'); END;

-- Les alertes rendues au planificateur (J13) : une seule par agent, obligation, période et palier.
CREATE TABLE IF NOT EXISTS academy_alerts (
  agent_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  obligation TEXT NOT NULL CHECK (obligation IN ('annuelle', 'triennale', 'deontologie', 'non_discrimination')),
  period_end TEXT NOT NULL CHECK (length(period_end) = 10),
  days_before INTEGER NOT NULL CHECK (days_before > 0),
  missing_minutes INTEGER NOT NULL CHECK (missing_minutes > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, obligation, period_end, days_before),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS academy_alerts_garde BEFORE DELETE ON academy_alerts BEGIN SELECT RAISE(ABORT, 'academy_alerts : rien ne s''efface'); END;
