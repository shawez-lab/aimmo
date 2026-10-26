-- C08 · Assistant du site : sessions et limites d'appels. Aucune adresse IP, aucun navigateur, aucun identifiant
-- en clair : le visiteur n'est connu que par l'empreinte SHA-256 d'un identifiant opaque donné par le site [R15].
-- Ce que le visiteur écrit vit dans la fiche (inbound_messages, messages), comme sur les autres canaux.
-- Uniquement des tables nouvelles. Rien n'est jamais effacé [R17].
CREATE TABLE IF NOT EXISTS assistant_sessions (
  -- Jeton aléatoire (32 octets en hexadécimal), rendu au site à l'ouverture : il désigne la conversation.
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  visitor_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_sessions_visitor ON assistant_sessions (network_id, visitor_sha256);

-- Un appel compté par portée (visiteur, session, ouverture) et par heure : la limite se prend en une seule
-- instruction, deux appels simultanés ne la dépassent pas.
CREATE TABLE IF NOT EXISTS assistant_calls (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  scope TEXT NOT NULL,
  bucket TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_calls_scope ON assistant_calls (network_id, scope, bucket);

CREATE TRIGGER IF NOT EXISTS assistant_sessions_sans_effacement
BEFORE DELETE ON assistant_sessions
BEGIN
  SELECT RAISE(ABORT, 'assistant_sessions : rien ne s''efface');
END;

CREATE TRIGGER IF NOT EXISTS assistant_calls_sans_effacement
BEFORE DELETE ON assistant_calls
BEGIN
  SELECT RAISE(ABORT, 'assistant_calls : rien ne s''efface');
END;
