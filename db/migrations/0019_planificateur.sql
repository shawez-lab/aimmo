-- B02 · Planificateur du socle : chaque tâche à heure fixe ne passe qu'une fois par créneau (date et heure de Paris).
-- Rien n'est jamais effacé : la ligne garde la trace du passage et de son issue.
CREATE TABLE IF NOT EXISTS scheduled_runs (
  job TEXT NOT NULL,
  -- `AAAA-MM-JJTHH`, heure de Paris : une heure qui revient au changement d'heure reste un seul créneau.
  slot TEXT NOT NULL,
  started_at TEXT NOT NULL,
  -- `ok`, `error`, ou NULL tant que le passage tourne.
  outcome TEXT,
  finished_at TEXT,
  PRIMARY KEY (job, slot)
);

CREATE TRIGGER IF NOT EXISTS scheduled_runs_sans_effacement
BEFORE DELETE ON scheduled_runs
BEGIN
  SELECT RAISE(ABORT, 'scheduled_runs : rien ne s''efface');
END;
