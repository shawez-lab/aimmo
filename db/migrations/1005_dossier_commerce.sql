-- CE05 · Dossier protégé d'un commerce (M16) [R113, R114, R17].
-- Les documents du dossier, rangés par l'agent par leur référence de stockage et leur empreinte ; les liens personnels
-- qui expirent et ne s'ouvrent qu'un nombre de fois réglé, dont seule l'empreinte du jeton est gardée ; chaque
-- ouverture et chaque refus, avec son lecteur ; la marque propre à chaque ouverture, cachée dans la copie servie.
CREATE TABLE IF NOT EXISTS business_dossier_documents (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bilan', 'compte_resultat', 'bail', 'liste_materiel', 'autorisation', 'autre')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  storage_ref TEXT NOT NULL CHECK (length(storage_ref) BETWEEN 1 AND 300),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS business_dossier_documents_property ON business_dossier_documents (network_id, property_id);

CREATE TABLE IF NOT EXISTS business_dossier_links (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  nda_id TEXT NOT NULL REFERENCES business_ndas (id) ON DELETE RESTRICT,
  -- L'empreinte du jeton du lien, jamais le jeton.
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  expires_at TEXT NOT NULL,
  max_opens INTEGER NOT NULL CHECK (max_opens BETWEEN 1 AND 50),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS business_dossier_link_revocations (
  link_id TEXT PRIMARY KEY REFERENCES business_dossier_links (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  revoked_by TEXT NOT NULL,
  revoked_at TEXT NOT NULL
);

-- Chaque ouverture et chaque refus, avec son lecteur quand il est connu. Une ouverture porte sa marque, unique.
CREATE TABLE IF NOT EXISTS business_dossier_accesses (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  link_id TEXT REFERENCES business_dossier_links (id) ON DELETE RESTRICT,
  -- Le lecteur à qui le lien a été donné.
  person_id TEXT REFERENCES persons (id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('ouvert', 'expire', 'revoque', 'epuise', 'autre_lecteur', 'porte_fermee')),
  mark TEXT UNIQUE CHECK (mark IS NULL OR length(mark) = 12),
  at TEXT NOT NULL,
  CHECK ((outcome = 'ouvert') = (mark IS NOT NULL)),
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS business_dossier_accesses_link ON business_dossier_accesses (link_id, outcome);
CREATE INDEX IF NOT EXISTS business_dossier_accesses_property ON business_dossier_accesses (network_id, property_id, at);

CREATE TRIGGER IF NOT EXISTS business_dossier_documents_fige BEFORE UPDATE ON business_dossier_documents
BEGIN SELECT RAISE(ABORT, 'business_dossier_documents : un document rangé ne se réécrit pas'); END;
CREATE TRIGGER IF NOT EXISTS business_dossier_documents_garde BEFORE DELETE ON business_dossier_documents
BEGIN SELECT RAISE(ABORT, 'business_dossier_documents : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS business_dossier_links_fige BEFORE UPDATE ON business_dossier_links
BEGIN SELECT RAISE(ABORT, 'business_dossier_links : un lien ne se réécrit pas'); END;
CREATE TRIGGER IF NOT EXISTS business_dossier_links_garde BEFORE DELETE ON business_dossier_links
BEGIN SELECT RAISE(ABORT, 'business_dossier_links : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS business_dossier_link_revocations_fige BEFORE UPDATE ON business_dossier_link_revocations
BEGIN SELECT RAISE(ABORT, 'business_dossier_link_revocations : une révocation ne se réécrit pas'); END;
CREATE TRIGGER IF NOT EXISTS business_dossier_link_revocations_garde BEFORE DELETE ON business_dossier_link_revocations
BEGIN SELECT RAISE(ABORT, 'business_dossier_link_revocations : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS business_dossier_accesses_fige BEFORE UPDATE ON business_dossier_accesses
BEGIN SELECT RAISE(ABORT, 'business_dossier_accesses : une ouverture ne se réécrit pas'); END;
CREATE TRIGGER IF NOT EXISTS business_dossier_accesses_garde BEFORE DELETE ON business_dossier_accesses
BEGIN SELECT RAISE(ABORT, 'business_dossier_accesses : rien ne s''efface'); END;

-- Le code à usage unique qui prouve, à chaque ouverture, que le lecteur reçoit le mail de la personne du lien : seule
-- son empreinte est gardée ; il expire, ne sert qu'une fois, et cinq essais faux le bloquent.
CREATE TABLE IF NOT EXISTS business_dossier_open_codes (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  link_id TEXT NOT NULL REFERENCES business_dossier_links (id) ON DELETE RESTRICT,
  code_hash TEXT NOT NULL CHECK (length(code_hash) = 64),
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  status TEXT NOT NULL CHECK (status IN ('ouvert', 'utilise', 'bloque')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS business_dossier_open_codes_link ON business_dossier_open_codes (link_id, created_at);
CREATE TRIGGER IF NOT EXISTS business_dossier_open_codes_garde BEFORE DELETE ON business_dossier_open_codes
BEGIN SELECT RAISE(ABORT, 'business_dossier_open_codes : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS business_dossier_open_codes_fige BEFORE UPDATE ON business_dossier_open_codes
WHEN OLD.status <> 'ouvert' OR NEW.id IS NOT OLD.id OR NEW.network_id IS NOT OLD.network_id OR NEW.link_id IS NOT OLD.link_id
  OR NEW.code_hash IS NOT OLD.code_hash OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'business_dossier_open_codes : un code utilisé ou bloqué ne change plus'); END;
