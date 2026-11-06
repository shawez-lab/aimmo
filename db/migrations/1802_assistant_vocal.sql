-- HX22 · Assistant vocal quand l'agent ne peut pas répondre. L'agent garde son seul numéro : l'assistant ne prend que
-- les appels renvoyés depuis ce numéro, sur non-réponse, occupation ou absence de réseau [R246]. Le numéro de l'agent
-- n'est jamais au journal.
CREATE TABLE IF NOT EXISTS voice_assistant_lines (
  agent_id TEXT PRIMARY KEY REFERENCES agents (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  phone TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL,
  -- Un numéro ne désigne qu'un agent, tous réseaux confondus : l'appel renvoyé ne peut aller qu'à lui.
  UNIQUE (phone)
);

-- Le passage de main à l'agent, une seule fois par appel [R18] : le rendez-vous pris sur un créneau libre proposé
-- pendant l'appel [R248], et les sujets restés sans réponse, gardés seulement si l'appelant a accepté l'enregistrement.
-- Le résumé lui-même est celui de l'appel rangé par HX21 (`calls`).
CREATE TABLE IF NOT EXISTS voice_assistant_calls (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  call_id TEXT NOT NULL,
  call_row_id TEXT REFERENCES calls (id) ON DELETE RESTRICT,
  property_id TEXT,
  appointment_kind TEXT CHECK (appointment_kind IN ('estimation', 'visite', 'appel')),
  appointment_start TEXT,
  unanswered TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (network_id, provider, call_id),
  CHECK ((appointment_kind IS NULL) = (appointment_start IS NULL))
);

CREATE TRIGGER IF NOT EXISTS voice_assistant_calls_sans_effacement
BEFORE DELETE ON voice_assistant_calls
BEGIN
  SELECT RAISE(ABORT, 'voice_assistant_calls : rien ne s''efface');
END;

CREATE TRIGGER IF NOT EXISTS voice_assistant_calls_fige
BEFORE UPDATE ON voice_assistant_calls
BEGIN
  SELECT RAISE(ABORT, 'voice_assistant_calls : un passage de main ne change plus');
END;

CREATE TRIGGER IF NOT EXISTS voice_assistant_lines_sans_effacement
BEFORE DELETE ON voice_assistant_lines
BEGIN
  SELECT RAISE(ABORT, 'voice_assistant_lines : rien ne s''efface, la ligne s''éteint');
END;
