-- AT01 · Prix par commune et par quartier, regroupés, sans vente retrouvable [R150, R151, R29].
-- Les zones sont tracées par la direction, avec la source de leur contour ; rien ne s'efface ni ne se réécrit [R17].
CREATE TABLE IF NOT EXISTS price_zones (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  level TEXT NOT NULL CHECK (level IN ('commune', 'quartier')),
  parent_id TEXT REFERENCES price_zones (id) ON DELETE RESTRICT,
  slug TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 80),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  -- Le code INSEE de la commune, pour une commune ; NULL pour un quartier.
  insee_code TEXT CHECK (insee_code IS NULL OR length(insee_code) = 5),
  -- Contour : liste JSON de points [latitude, longitude].
  ring_json TEXT NOT NULL,
  ring_source TEXT NOT NULL CHECK (length(ring_source) BETWEEN 1 AND 200),
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  -- Un nom n'est unique que parmi les zones en service : contrôlé par le code, une zone retirée gardant le sien.
  CHECK ((level = 'commune' AND parent_id IS NULL AND insee_code IS NOT NULL) OR (level = 'quartier' AND parent_id IS NOT NULL AND insee_code IS NULL))
);
CREATE INDEX IF NOT EXISTS price_zones_slug ON price_zones (network_id, level, slug);

-- Une zone retirée ne sert plus aux versions suivantes ; elle reste, avec les versions qui l'ont publiée.
CREATE TABLE IF NOT EXISTS price_zone_retirements (
  area_id TEXT PRIMARY KEY REFERENCES price_zones (id) ON DELETE RESTRICT,
  retired_by TEXT NOT NULL,
  retired_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS price_zone_retirements_garde BEFORE DELETE ON price_zone_retirements BEGIN SELECT RAISE(ABORT, 'price_zone_retirements : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS price_zone_retirements_fige BEFORE UPDATE ON price_zone_retirements BEGIN SELECT RAISE(ABORT, 'price_zone_retirements : rien ne se réécrit'); END;

-- Une version par publication DVF (et par jeu de zones) : la précédente reste lisible.
CREATE TABLE IF NOT EXISTS price_versions (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  source TEXT NOT NULL,
  dvf_last_sale TEXT NOT NULL,
  window_from TEXT NOT NULL,
  window_to TEXT NOT NULL,
  areas_digest TEXT NOT NULL CHECK (length(areas_digest) = 64),
  -- Empreinte de toutes les ventes lues : une reprise après coupure ne mélange jamais deux lectures différentes.
  sales_digest TEXT NOT NULL CHECK (length(sales_digest) = 64),
  min_sales INTEGER NOT NULL CHECK (min_sales >= 2),
  -- Une version n'est lue qu'une fois complète ; une version coupée en route est refaite à l'identique.
  status TEXT NOT NULL CHECK (status IN ('en_cours', 'complet')),
  computed_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (network_id, source, dvf_last_sale, areas_digest, sales_digest, min_sales)
);
CREATE INDEX IF NOT EXISTS price_versions_latest ON price_versions (network_id, status, completed_at);

-- Une case par zone et par type. Chiffres NULL quand la case est retenue ; pour une reprise, `from_version_id` dit la
-- version dont viennent les chiffres.
CREATE TABLE IF NOT EXISTS price_cells (
  version_id TEXT NOT NULL REFERENCES price_versions (id) ON DELETE RESTRICT,
  area_id TEXT NOT NULL REFERENCES price_zones (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('apartment', 'house')),
  status TEXT NOT NULL CHECK (status IN ('publiee', 'reprise', 'retenue')),
  hold_code TEXT CHECK (hold_code IS NULL OR hold_code IN ('seuil', 'difference', 'version')),
  sales_count INTEGER,
  median_m2 INTEGER,
  q1_m2 INTEGER,
  q3_m2 INTEGER,
  from_version_id TEXT REFERENCES price_versions (id) ON DELETE RESTRICT,
  CHECK (
    (status = 'retenue' AND hold_code IS NOT NULL AND sales_count IS NULL AND median_m2 IS NULL AND q1_m2 IS NULL AND q3_m2 IS NULL AND from_version_id IS NULL)
    OR (status = 'publiee' AND hold_code IS NULL AND sales_count >= 2 AND median_m2 > 0 AND q1_m2 > 0 AND q3_m2 >= q1_m2 AND from_version_id = version_id)
    OR (status = 'reprise' AND hold_code = 'version' AND sales_count >= 2 AND median_m2 > 0 AND from_version_id IS NOT NULL AND from_version_id <> version_id)
  ),
  PRIMARY KEY (version_id, area_id, kind)
);

-- Les ventes d'une case publiée, par empreinte : jamais montrées, seulement relues pour la version suivante.
CREATE TABLE IF NOT EXISTS price_cell_sales (
  version_id TEXT NOT NULL,
  area_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  n INTEGER NOT NULL CHECK (n >= 1),
  PRIMARY KEY (version_id, area_id, kind, fingerprint),
  FOREIGN KEY (version_id, area_id, kind) REFERENCES price_cells (version_id, area_id, kind) ON DELETE RESTRICT
);

CREATE TRIGGER IF NOT EXISTS price_zones_garde BEFORE DELETE ON price_zones BEGIN SELECT RAISE(ABORT, 'price_zones : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS price_zones_fige BEFORE UPDATE ON price_zones BEGIN SELECT RAISE(ABORT, 'price_zones : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS price_versions_garde BEFORE DELETE ON price_versions BEGIN SELECT RAISE(ABORT, 'price_versions : rien ne s''efface'); END;
-- Seul passage permis : une version en cours devient complète, rien d'autre ne change.
CREATE TRIGGER IF NOT EXISTS price_versions_fige BEFORE UPDATE ON price_versions
WHEN NOT (OLD.status = 'en_cours' AND NEW.status = 'complet' AND OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL
  AND NEW.id = OLD.id AND NEW.network_id = OLD.network_id AND NEW.source = OLD.source AND NEW.dvf_last_sale = OLD.dvf_last_sale
  AND NEW.sales_digest = OLD.sales_digest AND NEW.window_from = OLD.window_from AND NEW.window_to = OLD.window_to AND NEW.areas_digest = OLD.areas_digest
  AND NEW.min_sales = OLD.min_sales AND NEW.computed_at = OLD.computed_at)
BEGIN SELECT RAISE(ABORT, 'price_versions : rien ne se réécrit'); END;
-- Une version complète ne reçoit plus de case.
CREATE TRIGGER IF NOT EXISTS price_cells_close BEFORE INSERT ON price_cells
WHEN (SELECT status FROM price_versions WHERE id = NEW.version_id) <> 'en_cours'
BEGIN SELECT RAISE(ABORT, 'price_cells : version complète'); END;
CREATE TRIGGER IF NOT EXISTS price_cell_sales_close BEFORE INSERT ON price_cell_sales
WHEN (SELECT status FROM price_versions WHERE id = NEW.version_id) <> 'en_cours'
BEGIN SELECT RAISE(ABORT, 'price_cell_sales : version complète'); END;
CREATE TRIGGER IF NOT EXISTS price_cells_garde BEFORE DELETE ON price_cells BEGIN SELECT RAISE(ABORT, 'price_cells : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS price_cells_fige BEFORE UPDATE ON price_cells BEGIN SELECT RAISE(ABORT, 'price_cells : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS price_cell_sales_garde BEFORE DELETE ON price_cell_sales BEGIN SELECT RAISE(ABORT, 'price_cell_sales : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS price_cell_sales_fige BEFORE UPDATE ON price_cell_sales BEGIN SELECT RAISE(ABORT, 'price_cell_sales : rien ne se réécrit'); END;
