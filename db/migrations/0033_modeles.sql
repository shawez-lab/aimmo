-- D02 · Bibliothèque de modèles datés et versionnés, et documents générés [R40].
-- Un modèle ne change jamais : une modification crée une version. Seul son état passe d'« essai » à « validé », par une
-- personne désignée (H08), jamais par le code. Un document garde la version et l'empreinte du modèle utilisé.

CREATE TABLE IF NOT EXISTS document_templates (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('mandat_vente_simple', 'mandat_vente_exclusif', 'avenant_mandat')),
  version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL CHECK (status IN ('essai', 'valide')),
  -- Le texte du modèle, avec ses champs `{{nom.du.champ}}` ; une ligne qui commence par `!! ` est mise en évidence.
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 50000),
  -- Les champs du modèle, en JSON : tous doivent être remplis pour que le document soit complet.
  fields TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  validated_by TEXT,
  validated_at TEXT,
  UNIQUE (network_id, kind, version),
  UNIQUE (id, network_id),
  CHECK ((status = 'essai' AND validated_by IS NULL AND validated_at IS NULL) OR (status = 'valide' AND validated_by IS NOT NULL AND validated_at IS NOT NULL))
);

CREATE TRIGGER IF NOT EXISTS document_templates_sans_effacement
BEFORE DELETE ON document_templates
BEGIN
  SELECT RAISE(ABORT, 'modèle gardé');
END;

-- Seul l'état change, une fois, d'essai à validé ; le texte, les champs et la version ne changent jamais.
CREATE TRIGGER IF NOT EXISTS document_templates_fige
BEFORE UPDATE ON document_templates
WHEN NEW.id IS NOT OLD.id OR NEW.network_id IS NOT OLD.network_id OR NEW.kind IS NOT OLD.kind OR NEW.version IS NOT OLD.version
  OR NEW.body IS NOT OLD.body OR NEW.fields IS NOT OLD.fields OR NEW.hash IS NOT OLD.hash
  OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
  OR OLD.status <> 'essai' OR NEW.status <> 'valide'
BEGIN
  SELECT RAISE(ABORT, 'modèle figé : créer une nouvelle version');
END;

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  template_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  -- `essai` : fait sur un modèle non validé ; jamais signé pour de vrai.
  mode TEXT NOT NULL CHECK (mode IN ('essai', 'reel')),
  status TEXT NOT NULL CHECK (status IN ('complet', 'incomplet')),
  missing TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  property_id TEXT,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (template_id, network_id) REFERENCES document_templates (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS documents_person ON documents (network_id, person_id);

CREATE TRIGGER IF NOT EXISTS documents_sans_effacement
BEFORE DELETE ON documents
BEGIN
  SELECT RAISE(ABORT, 'document gardé');
END;

CREATE TRIGGER IF NOT EXISTS documents_fige
BEFORE UPDATE ON documents
BEGIN
  SELECT RAISE(ABORT, 'document figé : en générer un nouveau');
END;
