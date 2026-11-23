-- AU045 · Le vrai raccordement téléphonique de l'assistant vocal (HX22, M03) [R710, R246, R242, R248, R13, R18].
-- Un appel renvoyé par l'agent vers le numéro du service téléphonique est décroché par le Worker : l'état de l'appel,
-- entre deux tours de parole, est gardé ici le temps de l'appel, puis effacé du seul champ `state` à la fin (le numéro de
-- l'appelant n'y reste pas) ; l'appel lui-même est rangé par HX21 (`calls`) et le passage de main par HX22
-- (`voice_assistant_calls`). Ni ce qui est dit, ni le numéro au journal [R13]. Une ligne par appel du service [R18].
CREATE TABLE IF NOT EXISTS voice_assistant_sessions (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('twilio')),
  call_id TEXT NOT NULL CHECK (length(call_id) BETWEEN 1 AND 128),
  state TEXT CHECK (state IS NULL OR length(state) <= 20000),
  turns INTEGER NOT NULL DEFAULT 0 CHECK (turns >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  -- Un seul tour ou une seule fin à la fois : le jeton de celui qui tient l'appel, et son heure (repris s'il est vieux).
  lease_token TEXT,
  lease_at TEXT,
  -- La dernière réponse dite, et le tour qu'elle clôt : une livraison répétée du même tour la redit, sans la rejouer.
  last_reply TEXT CHECK (last_reply IS NULL OR length(last_reply) <= 20000),
  CHECK (ended_at IS NULL OR last_reply IS NULL),
  CHECK ((lease_token IS NULL) = (lease_at IS NULL)),
  CHECK ((ended_at IS NULL) = (state IS NOT NULL)),
  UNIQUE (provider, call_id)
);
CREATE INDEX IF NOT EXISTS voice_assistant_sessions_ouverts ON voice_assistant_sessions (ended_at, updated_at);
CREATE TRIGGER IF NOT EXISTS voice_assistant_sessions_sans_effacement
BEFORE DELETE ON voice_assistant_sessions
BEGIN
  SELECT RAISE(ABORT, 'voice_assistant_sessions : rien ne s''efface');
END;
CREATE TRIGGER IF NOT EXISTS voice_assistant_sessions_fige BEFORE UPDATE ON voice_assistant_sessions
WHEN OLD.ended_at IS NOT NULL
  OR NEW.id IS NOT OLD.id OR NEW.network_id IS NOT OLD.network_id OR NEW.agent_id IS NOT OLD.agent_id
  OR NEW.provider IS NOT OLD.provider OR NEW.call_id IS NOT OLD.call_id OR NEW.created_at IS NOT OLD.created_at
  OR NEW.turns < OLD.turns
BEGIN SELECT RAISE(ABORT, 'voice_assistant_sessions : un appel fini ne change plus'); END;

-- La fin d'un appel dite par le service, gardée à part : elle peut arriver avant que l'appel soit décroché, ou pendant un
-- tour ; celui qui finit l'appel y lit son heure de fin. Ni numéro ni parole : l'identifiant de l'appel et l'heure.
CREATE TABLE IF NOT EXISTS voice_call_endings (
  provider TEXT NOT NULL CHECK (provider IN ('twilio')),
  call_id TEXT NOT NULL CHECK (length(call_id) BETWEEN 1 AND 128),
  ended_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, call_id)
);
CREATE TRIGGER IF NOT EXISTS voice_call_endings_sans_effacement
BEFORE DELETE ON voice_call_endings
BEGIN
  SELECT RAISE(ABORT, 'voice_call_endings : rien ne s''efface');
END;
CREATE TRIGGER IF NOT EXISTS voice_call_endings_fige
BEFORE UPDATE ON voice_call_endings
BEGIN
  SELECT RAISE(ABORT, 'voice_call_endings : une fin ne change plus');
END;
