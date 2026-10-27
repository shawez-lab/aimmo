-- V03 · Agenda de l'agent : chaque rendez-vous écrit une fois dans l'agenda, et ce qui change dans l'agenda revient
-- sur le rendez-vous. Rien ne s'efface.
CREATE TABLE IF NOT EXISTS appointment_calendar (
  appointment_id TEXT PRIMARY KEY REFERENCES appointments (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  -- L'événement de l'agenda ; NULL tant qu'il n'est pas écrit.
  event_id TEXT,
  -- Ce que l'agenda montre du rendez-vous : `booked` ou `cancelled` ; `replaced` quand un décalage a repris l'événement.
  synced_status TEXT CHECK (synced_status IS NULL OR synced_status IN ('booked', 'cancelled', 'replaced')),
  synced_start TEXT,
  -- `conflict` : l'agent a déplacé l'événement sur un créneau que les règles refusent ; le rendez-vous reste où il était.
  state TEXT NOT NULL CHECK (state IN ('pending', 'synced', 'error', 'conflict')),
  -- Le nom de la dernière erreur, jamais son message [R13].
  last_error TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS appointment_calendar_event ON appointment_calendar (agent_id, event_id);

-- Où en est la lecture des changements de l'agenda de chaque agent.
CREATE TABLE IF NOT EXISTS agenda_cursors (
  agent_id TEXT PRIMARY KEY,
  cursor TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS appointment_calendar_sans_effacement
BEFORE DELETE ON appointment_calendar
BEGIN
  SELECT RAISE(ABORT, 'appointment_calendar : rien ne s''efface');
END;

CREATE TRIGGER IF NOT EXISTS agenda_cursors_sans_effacement
BEFORE DELETE ON agenda_cursors
BEGIN
  SELECT RAISE(ABORT, 'agenda_cursors : rien ne s''efface');
END;
