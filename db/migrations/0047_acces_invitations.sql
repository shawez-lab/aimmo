-- Z02 · Accès en un clic par un lien d'invitation à usage unique [R13].
--
-- Une invitation ne garde que l'empreinte SHA-256 de son jeton : le jeton n'existe que dans le lien remis par mail.
-- Elle sert une seule fois, avant son échéance ; elle n'est jamais effacée, pour garder la preuve de son usage.
CREATE TABLE IF NOT EXISTS access_invitations (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  token_sha256 TEXT NOT NULL UNIQUE CHECK (length(token_sha256) = 64),
  -- Les identités que l'invitation ouvre : [{"role":"agent","userId":"…"},{"role":"direction","userId":"…"}].
  grants TEXT NOT NULL CHECK (json_valid(grants) AND json_array_length(grants) BETWEEN 1 AND 4),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT
);

-- Les clés remises par une invitation : seulement leur empreinte, jamais la clé. Elles s'ajoutent à celles du secret
-- `API_KEYS`, qui ne change pas. Une clé se retire en datant `revoked_at`, jamais en l'effaçant.
CREATE TABLE IF NOT EXISTS access_keys (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('agent', 'direction', 'compliance', 'partner')),
  user_id TEXT NOT NULL CHECK (length(user_id) > 0),
  invitation_id TEXT NOT NULL REFERENCES access_invitations (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS access_keys_actives ON access_keys (revoked_at);

-- Une invitation ne change qu'une fois : le jour où elle sert.
CREATE TRIGGER IF NOT EXISTS access_invitations_une_fois BEFORE UPDATE ON access_invitations
WHEN OLD.used_at IS NOT NULL OR NEW.used_at IS NULL OR NEW.id IS NOT OLD.id OR NEW.network_id IS NOT OLD.network_id
  OR NEW.token_sha256 IS NOT OLD.token_sha256 OR NEW.grants IS NOT OLD.grants OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'invitation déjà utilisée ou figée'); END;
CREATE TRIGGER IF NOT EXISTS access_invitations_sans_effacement BEFORE DELETE ON access_invitations BEGIN SELECT RAISE(ABORT, 'invitation gardée'); END;

-- Une clé ne change que pour être retirée, une seule fois.
CREATE TRIGGER IF NOT EXISTS access_keys_retrait_seul BEFORE UPDATE ON access_keys
WHEN OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.sha256 IS NOT OLD.sha256 OR NEW.network_id IS NOT OLD.network_id
  OR NEW.role IS NOT OLD.role OR NEW.user_id IS NOT OLD.user_id OR NEW.invitation_id IS NOT OLD.invitation_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'clé figée'); END;
CREATE TRIGGER IF NOT EXISTS access_keys_sans_effacement BEFORE DELETE ON access_keys BEGIN SELECT RAISE(ABORT, 'clé gardée'); END;
