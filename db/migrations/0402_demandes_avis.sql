-- F02 · Demande d'avis le lendemain de l'acte, à tous, en mode essai (M11) [R64].
-- Le lien de la fiche Google de chaque agent : un réglage de l'agent, chaque changement s'ajoute, le dernier fait foi.
-- Rien ne s'efface [R17].
CREATE TABLE IF NOT EXISTS agent_review_links (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  url TEXT NOT NULL CHECK (length(url) BETWEEN 12 AND 300 AND url LIKE 'https://%'),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS agent_review_links_agent ON agent_review_links (agent_id, set_at);
CREATE TRIGGER IF NOT EXISTS agent_review_links_garde BEFORE DELETE ON agent_review_links BEGIN SELECT RAISE(ABORT, 'agent_review_links : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS agent_review_links_fige BEFORE UPDATE ON agent_review_links BEGIN SELECT RAISE(ABORT, 'agent_review_links : un lien réglé ne change plus, un nouveau s''ajoute'); END;

-- Une demande d'avis par client et par dossier clos, jamais deux [R05]. Le dossier vient de M10 (N06) : pas de clé
-- étrangère vers lui tant qu'il est lu par une interface. Aucune colonne de note : la demande ne dépend d'aucune [R64].
CREATE TABLE IF NOT EXISTS review_requests (
  file_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('vendeur', 'acquereur')),
  -- Le lendemain de l'acte, à Paris.
  due_day TEXT NOT NULL,
  -- `closed` : une demande restée en attente au-delà du délai, close avec sa raison dans `rule`.
  status TEXT NOT NULL CHECK (status IN ('sent', 'waiting', 'refused', 'failed', 'closed')),
  rule TEXT,
  -- Une demande refusée pour le plafond du jour attend le lendemain [R11].
  next_try_day TEXT,
  message_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (file_id, person_id)
);
CREATE INDEX IF NOT EXISTS review_requests_agent ON review_requests (agent_id, due_day);
CREATE TRIGGER IF NOT EXISTS review_requests_garde BEFORE DELETE ON review_requests BEGIN SELECT RAISE(ABORT, 'review_requests : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS review_requests_fige BEFORE UPDATE ON review_requests WHEN OLD.status IN ('sent', 'refused', 'closed') BEGIN SELECT RAISE(ABORT, 'review_requests : une demande partie, refusée ou close ne change plus'); END;

-- Les tâches de l'agent après la vente. F02 : « régler le lien de ma fiche Google » et « demande d'avis non partie
-- dans le délai », une de chaque par dossier.
CREATE TABLE IF NOT EXISTS after_sale_tasks (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('lien_avis', 'avis_non_parti')),
  created_at TEXT NOT NULL,
  done_at TEXT,
  UNIQUE (file_id, kind)
);
CREATE INDEX IF NOT EXISTS after_sale_tasks_agent ON after_sale_tasks (agent_id, done_at);
CREATE TRIGGER IF NOT EXISTS after_sale_tasks_garde BEFORE DELETE ON after_sale_tasks BEGIN SELECT RAISE(ABORT, 'after_sale_tasks : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS after_sale_tasks_fige
BEFORE UPDATE ON after_sale_tasks
WHEN NEW.id IS NOT OLD.id OR NEW.network_id IS NOT OLD.network_id OR NEW.agent_id IS NOT OLD.agent_id OR NEW.file_id IS NOT OLD.file_id
  OR NEW.kind IS NOT OLD.kind OR NEW.created_at IS NOT OLD.created_at OR OLD.done_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'after_sale_tasks : une tâche faite ne change plus');
END;
