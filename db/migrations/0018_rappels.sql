-- Q04 · Tâche « rappeler » pour chaque contact chaud, chez son agent. Une seule par contact et par projet [R18].
-- Rien n'est jamais effacé [R17] : une tâche faite garde sa ligne avec `done_at`.
CREATE TABLE IF NOT EXISTS callback_tasks (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  project_id TEXT,
  qualification_id TEXT NOT NULL REFERENCES qualifications (id) ON DELETE RESTRICT,
  -- `callback:<fiche>:<projet ou none>` : la clé qui interdit le doublon.
  dedup_key TEXT NOT NULL UNIQUE,
  -- La raison de la note, en une ligne, sans donnée personnelle.
  reason TEXT NOT NULL,
  due_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  done_at TEXT,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS callback_tasks_open ON callback_tasks (network_id, done_at, due_at);

CREATE TRIGGER IF NOT EXISTS callback_tasks_sans_effacement
BEFORE DELETE ON callback_tasks
BEGIN
  SELECT RAISE(ABORT, 'callback_tasks : rien ne s''efface');
END;
