-- T04 · Visite et bon de visite. Une visite est un rendez-vous de V02 relié à un bien et à un projet d'achat. Le bon
-- de visite est rempli depuis la base selon un modèle daté et versionné [R40]. La bibliothèque de D02 n'admet que les
-- types de mandat (contrainte de sa table) : le bon de visite a ses modèles ici, aux mêmes règles. Rien ne s'efface
-- [R17] ; aucune adresse exacte n'existe dans ces tables [R19].

CREATE TABLE IF NOT EXISTS visits (
  appointment_id TEXT PRIMARY KEY REFERENCES appointments (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL REFERENCES properties (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS visits_property ON visits (network_id, property_id, created_at);
CREATE INDEX IF NOT EXISTS visits_project ON visits (project_id, created_at);
CREATE TRIGGER IF NOT EXISTS visits_fige BEFORE UPDATE ON visits BEGIN SELECT RAISE(ABORT, 'visite figée'); END;
CREATE TRIGGER IF NOT EXISTS visits_garde BEFORE DELETE ON visits BEGIN SELECT RAISE(ABORT, 'visite gardée'); END;

CREATE TABLE IF NOT EXISTS visit_slip_templates (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL CHECK (status IN ('essai', 'valide')),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  fields TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  validated_by TEXT,
  validated_at TEXT,
  UNIQUE (network_id, version),
  CHECK ((status = 'essai' AND validated_by IS NULL AND validated_at IS NULL) OR (status = 'valide' AND validated_by IS NOT NULL AND validated_at IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS visit_slip_templates_garde BEFORE DELETE ON visit_slip_templates BEGIN SELECT RAISE(ABORT, 'modèle gardé'); END;
CREATE TRIGGER IF NOT EXISTS visit_slip_templates_fige
BEFORE UPDATE ON visit_slip_templates
WHEN NEW.id IS NOT OLD.id OR NEW.network_id IS NOT OLD.network_id OR NEW.version IS NOT OLD.version OR NEW.body IS NOT OLD.body
  OR NEW.fields IS NOT OLD.fields OR NEW.hash IS NOT OLD.hash OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
  OR OLD.status <> 'essai' OR NEW.status <> 'valide'
BEGIN
  SELECT RAISE(ABORT, 'modèle figé : créer une nouvelle version');
END;

-- Le bon de visite d'une visite : un seul, gardé même si la visite est annulée. Seule la signature sur papier se
-- range ensuite, une fois.
CREATE TABLE IF NOT EXISTS visit_slips (
  id TEXT PRIMARY KEY,
  appointment_id TEXT NOT NULL UNIQUE REFERENCES visits (appointment_id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  template_id TEXT NOT NULL REFERENCES visit_slip_templates (id) ON DELETE RESTRICT,
  template_version INTEGER NOT NULL,
  template_hash TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('essai', 'reel')),
  status TEXT NOT NULL CHECK (status IN ('complet', 'incomplet')),
  missing TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  signed_at TEXT,
  scan_ref TEXT CHECK (scan_ref IS NULL OR length(scan_ref) BETWEEN 1 AND 200),
  signed_by TEXT
);
CREATE TRIGGER IF NOT EXISTS visit_slips_garde BEFORE DELETE ON visit_slips BEGIN SELECT RAISE(ABORT, 'bon de visite gardé'); END;
CREATE TRIGGER IF NOT EXISTS visit_slips_fige
BEFORE UPDATE ON visit_slips
WHEN NEW.id IS NOT OLD.id OR NEW.appointment_id IS NOT OLD.appointment_id OR NEW.network_id IS NOT OLD.network_id
  OR NEW.template_id IS NOT OLD.template_id OR NEW.template_version IS NOT OLD.template_version OR NEW.template_hash IS NOT OLD.template_hash
  OR NEW.mode IS NOT OLD.mode OR NEW.status IS NOT OLD.status OR NEW.missing IS NOT OLD.missing OR NEW.content IS NOT OLD.content
  OR NEW.content_hash IS NOT OLD.content_hash OR NEW.created_at IS NOT OLD.created_at OR OLD.signed_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'bon de visite figé');
END;
