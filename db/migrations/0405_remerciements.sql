-- F03 · Remerciement : l'agent appelle, le message est préparé (M11).
-- Une tâche « appeler pour remercier » par client et par dossier clos [R18], avec le message préparé par le code, que
-- l'agent valide ou non ; rien ne part sans sa validation. Rien ne s'efface [R17] ; le message préparé ne change pas.
CREATE TABLE IF NOT EXISTS thank_you_tasks (
  file_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('vendeur', 'acquereur')),
  due_day TEXT NOT NULL,
  draft TEXT NOT NULL CHECK (length(draft) BETWEEN 10 AND 1000),
  called_at TEXT,
  -- `send` : l'agent valide le message ; `decline` : il ne l'envoie pas. Absent : rien ne part.
  decision TEXT CHECK (decision IS NULL OR decision IN ('send', 'decline')),
  decided_at TEXT,
  -- `sending` : un passage a pris le message et l'envoie ; un seul à la fois.
  send_status TEXT CHECK (send_status IS NULL OR send_status IN ('sent', 'waiting', 'sending', 'refused', 'failed', 'closed')),
  rule TEXT,
  message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (file_id, person_id),
  CHECK ((decision IS NULL) = (decided_at IS NULL)),
  CHECK (send_status IS NULL OR decision = 'send')
);
CREATE INDEX IF NOT EXISTS thank_you_tasks_agent ON thank_you_tasks (agent_id, due_day);
CREATE TRIGGER IF NOT EXISTS thank_you_tasks_garde BEFORE DELETE ON thank_you_tasks BEGIN SELECT RAISE(ABORT, 'thank_you_tasks : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS thank_you_tasks_fige
BEFORE UPDATE ON thank_you_tasks
WHEN NEW.file_id IS NOT OLD.file_id OR NEW.person_id IS NOT OLD.person_id OR NEW.network_id IS NOT OLD.network_id OR NEW.agent_id IS NOT OLD.agent_id
  OR NEW.side IS NOT OLD.side OR NEW.due_day IS NOT OLD.due_day OR NEW.draft IS NOT OLD.draft OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.called_at IS NOT NULL AND NEW.called_at IS NOT OLD.called_at)
  OR (OLD.decision IS NOT NULL AND (NEW.decision IS NOT OLD.decision OR NEW.decided_at IS NOT OLD.decided_at))
  OR OLD.send_status IN ('sent', 'refused', 'closed') AND (NEW.send_status IS NOT OLD.send_status OR NEW.rule IS NOT OLD.rule OR NEW.message_id IS NOT OLD.message_id)
BEGIN
  SELECT RAISE(ABORT, 'thank_you_tasks : figé');
END;
