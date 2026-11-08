-- HX48 · Programmes neufs et viager (M16, M17, M18) [R540, R541, R542, R543, R544].

-- Tables d'espérance de vie importées par la direction, avec leur source et leur millésime, pour l'ensemble des deux
-- sexes : aucune ligne par sexe [R541]. Une table ne change plus et ne s'efface pas : un calcul rangé la cite.
CREATE TABLE IF NOT EXISTS life_tables (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  vintage TEXT NOT NULL CHECK (length(vintage) BETWEEN 4 AND 20),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 5 AND 300),
  -- Nombre de lignes de la table, rangé à l'import : aucune ligne ne s'ajoute ensuite [R541].
  row_count INTEGER NOT NULL CHECK (row_count BETWEEN 1 AND 121),
  imported_by TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  UNIQUE (network_id, vintage)
);
CREATE TRIGGER IF NOT EXISTS life_tables_garde BEFORE DELETE ON life_tables BEGIN SELECT RAISE(ABORT, 'life_tables : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS life_tables_fige BEFORE UPDATE ON life_tables BEGIN SELECT RAISE(ABORT, 'life_tables : une table ne change plus [R541]'); END;

CREATE TABLE IF NOT EXISTS life_table_rows (
  table_id TEXT NOT NULL REFERENCES life_tables (id) ON DELETE RESTRICT,
  age INTEGER NOT NULL CHECK (age BETWEEN 0 AND 120),
  -- Espérance de vie à cet âge, en dixièmes d'année.
  expectancy_tenths INTEGER NOT NULL CHECK (expectancy_tenths BETWEEN 1 AND 1200),
  PRIMARY KEY (table_id, age)
);
CREATE TRIGGER IF NOT EXISTS life_table_rows_garde BEFORE DELETE ON life_table_rows BEGIN SELECT RAISE(ABORT, 'life_table_rows : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS life_table_rows_complete BEFORE INSERT ON life_table_rows
  WHEN (SELECT count(*) FROM life_table_rows r WHERE r.table_id = NEW.table_id) >= (SELECT t.row_count FROM life_tables t WHERE t.id = NEW.table_id)
BEGIN SELECT RAISE(ABORT, 'life_table_rows : une table ne change plus [R541]'); END;
CREATE TRIGGER IF NOT EXISTS life_table_rows_fige BEFORE UPDATE ON life_table_rows BEGIN SELECT RAISE(ABORT, 'life_table_rows : une table ne change plus [R541]'); END;

-- Calculs de viager rangés avec leurs entrées, pour être rejoués à l'identique [R540].
CREATE TABLE IF NOT EXISTS viager_calculations (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT,
  project_id TEXT,
  inputs TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('complet', 'incomplet')),
  result TEXT NOT NULL,
  formula_version INTEGER NOT NULL CHECK (formula_version >= 1),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS viager_calculations_project ON viager_calculations (network_id, project_id);
CREATE TRIGGER IF NOT EXISTS viager_calculations_garde BEFORE DELETE ON viager_calculations BEGIN SELECT RAISE(ABORT, 'viager_calculations : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS viager_calculations_fige BEFORE UPDATE ON viager_calculations BEGIN SELECT RAISE(ABORT, 'viager_calculations : un calcul ne change plus [R540]'); END;

-- Barème des frais d'acquisition (neuf et ancien), rangé par la direction avec sa source, en points de base du prix
-- [R544]. Une ligne ne change plus : un barème nouveau s'ajoute avec son premier jour.
CREATE TABLE IF NOT EXISTS acquisition_fee_scales (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('neuf', 'ancien')),
  rate_bp INTEGER NOT NULL CHECK (rate_bp BETWEEN 1 AND 2000),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 5 AND 300),
  valid_from TEXT NOT NULL CHECK (valid_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS acquisition_fee_scales_kind ON acquisition_fee_scales (network_id, kind, valid_from);
CREATE TRIGGER IF NOT EXISTS acquisition_fee_scales_garde BEFORE DELETE ON acquisition_fee_scales BEGIN SELECT RAISE(ABORT, 'acquisition_fee_scales : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS acquisition_fee_scales_fige BEFORE UPDATE ON acquisition_fee_scales BEGIN SELECT RAISE(ABORT, 'acquisition_fee_scales : un barème ne change plus'); END;

-- Programmes neufs d'un promoteur partenaire (M18), suivis par un agent du réseau.
CREATE TABLE IF NOT EXISTS new_programs (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  promoter_partner_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  city TEXT NOT NULL CHECK (length(city) BETWEEN 2 AND 80),
  postal_code TEXT NOT NULL CHECK (postal_code GLOB '[0-9][0-9][0-9][0-9][0-9]'),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (promoter_partner_id, network_id) REFERENCES partners (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS new_programs_garde BEFORE DELETE ON new_programs BEGIN SELECT RAISE(ABORT, 'new_programs : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS new_programs_promoteur BEFORE INSERT ON new_programs
  WHEN NOT EXISTS (SELECT 1 FROM partners p WHERE p.id = NEW.promoter_partner_id AND p.network_id = NEW.network_id AND p.trade = 'promoteur')
BEGIN SELECT RAISE(ABORT, 'new_programs : le programme vient d''un promoteur partenaire'); END;

-- Chaque lot de la grille, par versions qui s'ajoutent : rien ne change ni ne s'efface [R17]. Un lot vendu ne revient
-- jamais : aucune version ne s'ajoute après une version « vendu » [R543].
CREATE TABLE IF NOT EXISTS new_program_lot_versions (
  program_id TEXT NOT NULL REFERENCES new_programs (id) ON DELETE RESTRICT,
  lot_ref TEXT NOT NULL CHECK (length(lot_ref) BETWEEN 1 AND 20),
  version INTEGER NOT NULL CHECK (version >= 1),
  typology TEXT NOT NULL CHECK (typology IN ('studio', 't1', 't2', 't3', 't4', 't5', 't6', 'maison', 'local')),
  living_area_hundredths INTEGER NOT NULL CHECK (living_area_hundredths BETWEEN 1000 AND 100000),
  floor INTEGER NOT NULL CHECK (floor BETWEEN -2 AND 60),
  price_cents INTEGER NOT NULL CHECK (price_cents BETWEEN 1000000 AND 10000000000),
  status TEXT NOT NULL CHECK (status IN ('disponible', 'option', 'reserve', 'vendu')),
  confirmed_on TEXT NOT NULL CHECK (confirmed_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (program_id, lot_ref, version)
);
CREATE TRIGGER IF NOT EXISTS new_program_lot_versions_garde BEFORE DELETE ON new_program_lot_versions BEGIN SELECT RAISE(ABORT, 'new_program_lot_versions : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS new_program_lot_versions_fige BEFORE UPDATE ON new_program_lot_versions BEGIN SELECT RAISE(ABORT, 'new_program_lot_versions : une version ne change plus'); END;
CREATE TRIGGER IF NOT EXISTS new_program_lot_versions_suite BEFORE INSERT ON new_program_lot_versions
  WHEN NEW.version <> 1 + coalesce((SELECT max(version) FROM new_program_lot_versions v WHERE v.program_id = NEW.program_id AND v.lot_ref = NEW.lot_ref), 0)
BEGIN SELECT RAISE(ABORT, 'new_program_lot_versions : les versions se suivent sans trou'); END;
CREATE TRIGGER IF NOT EXISTS new_program_lot_versions_vendu BEFORE INSERT ON new_program_lot_versions
  WHEN EXISTS (SELECT 1 FROM new_program_lot_versions v WHERE v.program_id = NEW.program_id AND v.lot_ref = NEW.lot_ref AND v.status = 'vendu')
BEGIN SELECT RAISE(ABORT, 'new_program_lot_versions : un lot vendu ne revient pas [R543]'); END;
