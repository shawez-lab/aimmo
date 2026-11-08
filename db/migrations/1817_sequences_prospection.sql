-- HX20 · Séquence de prospection sur plusieurs canaux. Tables nouvelles, en ajout seul : rien ne s'efface [R17].
-- Une séquence ne change que d'état, une seule fois : en cours, puis arrêtée ou finie [R301]. Une étape ne reçoit son
-- issue qu'une fois. Une étape « partie » est forcément un mail ou un SMS rangé par le contrôle central : son message
-- existe [R300]. Aucun texte de la personne, aucune coordonnée : seulement des identifiants internes.

CREATE TABLE IF NOT EXISTS prospecting_sequences (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES persons (id) ON DELETE RESTRICT,
  started_at TEXT NOT NULL,
  start_day TEXT NOT NULL CHECK (length(start_day) = 10),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped', 'finished')),
  ended_at TEXT,
  end_reason TEXT CHECK (end_reason IS NULL OR end_reason IN ('reply', 'excluded', 'withdrawn', 'call_refused', 'opposition_list', 'reassigned', 'agent_gone', 'refused_send', 'done')),
  end_rule TEXT,
  CHECK ((status = 'active') = (ended_at IS NULL)),
  CHECK ((status = 'active') = (end_reason IS NULL)),
  CHECK (status <> 'finished' OR end_reason = 'done'),
  UNIQUE (id, network_id),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
-- Une seule séquence en cours par fiche.
CREATE UNIQUE INDEX IF NOT EXISTS prospecting_sequences_une ON prospecting_sequences (person_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS prospecting_sequences_agent ON prospecting_sequences (network_id, agent_id, status);
CREATE TRIGGER IF NOT EXISTS prospecting_sequences_fige BEFORE UPDATE ON prospecting_sequences
WHEN OLD.status <> 'active' OR NEW.status = 'active' OR NEW.id IS NOT OLD.id OR NEW.network_id IS NOT OLD.network_id
  OR NEW.agent_id IS NOT OLD.agent_id OR NEW.person_id IS NOT OLD.person_id OR NEW.started_at IS NOT OLD.started_at
  OR NEW.start_day IS NOT OLD.start_day
BEGIN SELECT RAISE(ABORT, 'prospecting_sequences : seul l''état change, une fois'); END;
CREATE TRIGGER IF NOT EXISTS prospecting_sequences_garde BEFORE DELETE ON prospecting_sequences BEGIN SELECT RAISE(ABORT, 'prospecting_sequences : rien ne s''efface'); END;

CREATE TABLE IF NOT EXISTS prospecting_sequence_steps (
  id TEXT PRIMARY KEY,
  sequence_id TEXT NOT NULL,
  network_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 8),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'phone', 'letter', 'door')),
  after_days INTEGER NOT NULL CHECK (after_days BETWEEN 0 AND 90),
  body TEXT CHECK (body IS NULL OR length(trim(body)) BETWEEN 1 AND 1000),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('sent', 'done', 'skipped')),
  rule TEXT,
  message_id TEXT REFERENCES messages (id) ON DELETE RESTRICT,
  ended_at TEXT,
  CHECK ((channel IN ('email', 'sms')) = (body IS NOT NULL)),
  CHECK ((outcome IS NULL) = (ended_at IS NULL)),
  -- Partie : seulement un mail ou un SMS, avec le message rangé par le contrôle central [R300].
  CHECK ((outcome = 'sent') = (message_id IS NOT NULL)),
  CHECK (outcome IS NOT 'sent' OR channel IN ('email', 'sms')),
  CHECK (outcome IS NOT 'done' OR channel IN ('phone', 'letter', 'door')),
  UNIQUE (sequence_id, position),
  FOREIGN KEY (sequence_id, network_id) REFERENCES prospecting_sequences (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS prospecting_sequence_steps_fige BEFORE UPDATE ON prospecting_sequence_steps
WHEN OLD.outcome IS NOT NULL OR NEW.outcome IS NULL OR NEW.id IS NOT OLD.id OR NEW.sequence_id IS NOT OLD.sequence_id
  OR NEW.network_id IS NOT OLD.network_id OR NEW.position IS NOT OLD.position OR NEW.channel IS NOT OLD.channel
  OR NEW.after_days IS NOT OLD.after_days OR NEW.body IS NOT OLD.body
BEGIN SELECT RAISE(ABORT, 'prospecting_sequence_steps : l''issue se range une fois'); END;
-- Une étape d'une séquence arrêtée ou finie ne reçoit plus d'issue : l'arrêt vaut sur tous les canaux [R301].
CREATE TRIGGER IF NOT EXISTS prospecting_sequence_steps_arret BEFORE UPDATE ON prospecting_sequence_steps
WHEN (SELECT status FROM prospecting_sequences WHERE id = NEW.sequence_id) <> 'active'
BEGIN SELECT RAISE(ABORT, 'prospecting_sequence_steps : la séquence est arrêtée'); END;
CREATE TRIGGER IF NOT EXISTS prospecting_sequence_steps_garde BEFORE DELETE ON prospecting_sequence_steps BEGIN SELECT RAISE(ABORT, 'prospecting_sequence_steps : rien ne s''efface'); END;
