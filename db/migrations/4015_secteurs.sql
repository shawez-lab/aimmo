-- AU073 · Le secteur privé d'une recherche : un rayon autour d'un lieu précis, ou un secteur dessiné ; en versions, la
-- plus haute vaut, « aucun » le retire. Et la position d'un bien, géocodée depuis son adresse désignée.
CREATE TABLE IF NOT EXISTS buyer_search_areas (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  shape TEXT NOT NULL CHECK (shape IN ('cercle', 'polygone', 'aucun')),
  center_lat REAL,
  center_lon REAL,
  radius_m INTEGER CHECK (radius_m IS NULL OR radius_m BETWEEN 100 AND 50000),
  -- Les points d'un secteur dessiné, en JSON : [{"lat": .., "lon": ..}], de 3 à 40.
  points TEXT CHECK (points IS NULL OR length(points) BETWEEN 2 AND 4000),
  label TEXT CHECK (label IS NULL OR length(label) BETWEEN 2 AND 60),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  UNIQUE (project_id, version),
  CHECK ((shape = 'cercle') = (center_lat IS NOT NULL AND center_lon IS NOT NULL AND radius_m IS NOT NULL)),
  CHECK ((shape = 'polygone') = (points IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS buyer_search_areas_garde BEFORE DELETE ON buyer_search_areas BEGIN SELECT RAISE(ABORT, 'buyer_search_areas : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS buyer_search_areas_fige BEFORE UPDATE ON buyer_search_areas BEGIN SELECT RAISE(ABORT, 'buyer_search_areas : rien ne se réécrit'); END;

CREATE TABLE IF NOT EXISTS property_positions (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL REFERENCES properties (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  lat REAL NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon REAL NOT NULL CHECK (lon BETWEEN -180 AND 180),
  source TEXT NOT NULL CHECK (source IN ('ban')),
  -- La version de l'adresse désignée géocodée : une adresse corrigée rend la position inconnue jusqu'au prochain géocodage.
  designation_version INTEGER NOT NULL CHECK (designation_version >= 1),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  UNIQUE (property_id, version)
);
CREATE TRIGGER IF NOT EXISTS property_positions_garde BEFORE DELETE ON property_positions BEGIN SELECT RAISE(ABORT, 'property_positions : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS property_positions_fige BEFORE UPDATE ON property_positions BEGIN SELECT RAISE(ABORT, 'property_positions : rien ne se réécrit'); END;
