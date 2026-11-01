-- EC01 · Entrée du client dans son espace, sans mot de passe [R160]. Seule l'empreinte du jeton d'un lien ou d'une
-- séance est rangée, jamais le jeton. L'ouverture d'un lien et la fermeture d'une séance sont des lignes à part, posées
-- une seule fois : rien ne s'efface ni ne se réécrit [R17, R18].
CREATE TABLE IF NOT EXISTS client_space_links (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  expires_at TEXT NOT NULL,
  -- `invitation` : ouvert par l'agent ou la direction ; `demande` : redemandé par le client avec son adresse mail.
  origin TEXT NOT NULL CHECK (origin IN ('invitation', 'demande')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS client_space_links_person ON client_space_links (network_id, person_id, created_at);

-- Un lien ne s'ouvre qu'une fois : la clé primaire tranche entre deux ouvertures en même temps.
CREATE TABLE IF NOT EXISTS client_space_link_uses (
  link_id TEXT PRIMARY KEY REFERENCES client_space_links (id) ON DELETE RESTRICT,
  used_at TEXT NOT NULL
);

-- Un lien rangé mais pas remis (refusé par le contrôle central) est révoqué aussitôt.
CREATE TABLE IF NOT EXISTS client_space_link_revocations (
  link_id TEXT PRIMARY KEY REFERENCES client_space_links (id) ON DELETE RESTRICT,
  code TEXT NOT NULL CHECK (code IN ('non_remis')),
  revoked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS client_space_sessions (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  link_id TEXT NOT NULL UNIQUE REFERENCES client_space_links (id) ON DELETE RESTRICT,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS client_space_session_closures (
  session_id TEXT PRIMARY KEY REFERENCES client_space_sessions (id) ON DELETE RESTRICT,
  closed_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS client_space_links_garde BEFORE DELETE ON client_space_links
BEGIN
  SELECT RAISE(ABORT, 'client_space_links : rien ne s''efface');
END;
CREATE TRIGGER IF NOT EXISTS client_space_links_fige BEFORE UPDATE ON client_space_links
BEGIN
  SELECT RAISE(ABORT, 'client_space_links : un lien rangé ne change plus');
END;
CREATE TRIGGER IF NOT EXISTS client_space_link_uses_garde BEFORE DELETE ON client_space_link_uses
BEGIN
  SELECT RAISE(ABORT, 'client_space_link_uses : rien ne s''efface');
END;
CREATE TRIGGER IF NOT EXISTS client_space_link_uses_fige BEFORE UPDATE ON client_space_link_uses
BEGIN
  SELECT RAISE(ABORT, 'client_space_link_uses : une ouverture ne change plus');
END;
CREATE TRIGGER IF NOT EXISTS client_space_link_revocations_garde BEFORE DELETE ON client_space_link_revocations
BEGIN
  SELECT RAISE(ABORT, 'client_space_link_revocations : rien ne s''efface');
END;
CREATE TRIGGER IF NOT EXISTS client_space_link_revocations_fige BEFORE UPDATE ON client_space_link_revocations
BEGIN
  SELECT RAISE(ABORT, 'client_space_link_revocations : une révocation ne change plus');
END;
CREATE TRIGGER IF NOT EXISTS client_space_sessions_garde BEFORE DELETE ON client_space_sessions
BEGIN
  SELECT RAISE(ABORT, 'client_space_sessions : rien ne s''efface');
END;
CREATE TRIGGER IF NOT EXISTS client_space_sessions_fige BEFORE UPDATE ON client_space_sessions
BEGIN
  SELECT RAISE(ABORT, 'client_space_sessions : une séance rangée ne change plus');
END;
CREATE TRIGGER IF NOT EXISTS client_space_session_closures_garde BEFORE DELETE ON client_space_session_closures
BEGIN
  SELECT RAISE(ABORT, 'client_space_session_closures : rien ne s''efface');
END;
CREATE TRIGGER IF NOT EXISTS client_space_session_closures_fige BEFORE UPDATE ON client_space_session_closures
BEGIN
  SELECT RAISE(ABORT, 'client_space_session_closures : une fermeture ne change plus');
END;
