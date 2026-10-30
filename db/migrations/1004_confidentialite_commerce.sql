-- CE04 · Engagement de confidentialité d'un commerce (M16) [R113, R17].
-- Le modèle d'engagement, rangé par la direction, versionné ; chaque demande d'accès d'un repreneur ; l'engagement fait
-- pour un bien et une personne ; ses signatures en ligne (code de D08, en mode essai), dont seule l'empreinte du code
-- est gardée ; ses révocations. Aucune pièce d'identité ni numéro de pièce ici : seul l'état du coffre est lu [R15].
CREATE TABLE IF NOT EXISTS business_nda_templates (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 50 AND 20000),
  body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (network_id, version)
);

CREATE TABLE IF NOT EXISTS business_access_requests (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  nda_id TEXT REFERENCES business_ndas (id) ON DELETE RESTRICT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS business_access_requests_property ON business_access_requests (network_id, property_id, created_at);

CREATE TABLE IF NOT EXISTS business_ndas (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  template_id TEXT NOT NULL REFERENCES business_nda_templates (id) ON DELETE RESTRICT,
  -- Le texte que la personne signe, et son empreinte au jour où il est fait.
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS business_ndas_property_person ON business_ndas (network_id, property_id, person_id);

CREATE TABLE IF NOT EXISTS business_nda_signatures (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  nda_id TEXT NOT NULL REFERENCES business_ndas (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES persons (id) ON DELETE RESTRICT,
  -- L'empreinte de l'engagement à l'ouverture : c'est elle que la personne signe.
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  code_hash TEXT NOT NULL CHECK (length(code_hash) = 64),
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  status TEXT NOT NULL CHECK (status IN ('ouverte', 'signee', 'bloquee')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  signed_at TEXT,
  drawing_hash TEXT CHECK (drawing_hash IS NULL OR length(drawing_hash) = 64),
  -- Le dossier de preuve, en JSON, sans donnée personnelle ; toujours une signature d'essai tant que H24 n'est pas fait.
  proof TEXT CHECK (proof IS NULL OR json_valid(proof)),
  CHECK ((status = 'signee') = (signed_at IS NOT NULL AND proof IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS business_nda_signatures_une ON business_nda_signatures (nda_id) WHERE status = 'signee';

CREATE TABLE IF NOT EXISTS business_nda_revocations (
  nda_id TEXT PRIMARY KEY REFERENCES business_ndas (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (reason IN ('demande_repreneur', 'manquement', 'fin_de_vente', 'autre')),
  revoked_by TEXT NOT NULL,
  revoked_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS business_nda_templates_fige BEFORE UPDATE ON business_nda_templates
BEGIN SELECT RAISE(ABORT, 'business_nda_templates : un modèle ne se réécrit pas'); END;
CREATE TRIGGER IF NOT EXISTS business_nda_templates_garde BEFORE DELETE ON business_nda_templates
BEGIN SELECT RAISE(ABORT, 'business_nda_templates : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS business_access_requests_fige BEFORE UPDATE ON business_access_requests
BEGIN SELECT RAISE(ABORT, 'business_access_requests : une demande ne se réécrit pas'); END;
CREATE TRIGGER IF NOT EXISTS business_access_requests_garde BEFORE DELETE ON business_access_requests
BEGIN SELECT RAISE(ABORT, 'business_access_requests : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS business_ndas_fige BEFORE UPDATE ON business_ndas
BEGIN SELECT RAISE(ABORT, 'business_ndas : un engagement ne se réécrit pas'); END;
CREATE TRIGGER IF NOT EXISTS business_ndas_garde BEFORE DELETE ON business_ndas
BEGIN SELECT RAISE(ABORT, 'business_ndas : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS business_nda_signatures_garde BEFORE DELETE ON business_nda_signatures
BEGIN SELECT RAISE(ABORT, 'business_nda_signatures : rien ne s''efface'); END;
-- Une session signée ou bloquée ne change plus ; ce qu'elle a ouvert (engagement, personne, empreinte, code) jamais.
CREATE TRIGGER IF NOT EXISTS business_nda_signatures_fige BEFORE UPDATE ON business_nda_signatures
WHEN OLD.status <> 'ouverte'
  OR NEW.id IS NOT OLD.id OR NEW.network_id IS NOT OLD.network_id OR NEW.nda_id IS NOT OLD.nda_id OR NEW.person_id IS NOT OLD.person_id
  OR NEW.content_sha256 IS NOT OLD.content_sha256 OR NEW.code_hash IS NOT OLD.code_hash OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'business_nda_signatures : une signature rangée ne change plus'); END;
CREATE TRIGGER IF NOT EXISTS business_nda_revocations_fige BEFORE UPDATE ON business_nda_revocations
BEGIN SELECT RAISE(ABORT, 'business_nda_revocations : une révocation ne se réécrit pas'); END;
CREATE TRIGGER IF NOT EXISTS business_nda_revocations_garde BEFORE DELETE ON business_nda_revocations
BEGIN SELECT RAISE(ABORT, 'business_nda_revocations : rien ne s''efface'); END;
