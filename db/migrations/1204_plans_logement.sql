-- X04 · Plan simple du logement (M19) [R135, R10]. Les pièces rectangulaires saisies sur place, avec leurs cotes en
-- centimètres et leur position, versionnées : une nouvelle saisie s'ajoute, rien ne s'efface ni ne se réécrit [R17].
-- Le plan et les surfaces sont recalculés par le code depuis ces cotes, jamais saisis.
CREATE TABLE IF NOT EXISTS floor_plans (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  network_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  rooms TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (property_id, version),
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS floor_plans_garde BEFORE DELETE ON floor_plans BEGIN SELECT RAISE(ABORT, 'floor_plans : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS floor_plans_fige BEFORE UPDATE ON floor_plans BEGIN SELECT RAISE(ABORT, 'floor_plans : une version ne change plus'); END;
