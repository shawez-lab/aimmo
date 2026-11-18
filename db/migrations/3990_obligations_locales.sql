-- AU011 · Les obligations locales du dossier de vente : termites, mérule, assainissement non collectif [R60, R17].

-- Ce qu'un arrêté local dit d'une commune, lu par la direction : la commune (code postal et nom, en clé simplifiée), le
-- risque (termites, mérule), si la commune est dans la zone, et la source datée (intitulé, lien, date de l'arrêté, jour
-- de la lecture). Chaque lecture ajoute une ligne, la plus récente vaut ; rien ne se réécrit ni ne s'efface [R17].
CREATE TABLE IF NOT EXISTS local_hazard_orders (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  postal_code TEXT NOT NULL CHECK (length(postal_code) = 5),
  city_key TEXT NOT NULL CHECK (length(city_key) BETWEEN 1 AND 100),
  hazard TEXT NOT NULL CHECK (hazard IN ('termites', 'merule')),
  version INTEGER NOT NULL CHECK (version >= 1),
  in_zone INTEGER NOT NULL CHECK (in_zone IN (0, 1)),
  source_title TEXT NOT NULL CHECK (length(source_title) BETWEEN 3 AND 200),
  source_url TEXT NOT NULL CHECK (length(source_url) BETWEEN 12 AND 500 AND source_url LIKE 'https://%'),
  dated_on TEXT NOT NULL CHECK (length(dated_on) = 10),
  read_on TEXT NOT NULL CHECK (length(read_on) = 10 AND read_on >= dated_on),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  UNIQUE (network_id, postal_code, city_key, hazard, version)
);
CREATE TRIGGER IF NOT EXISTS local_hazard_orders_fige BEFORE UPDATE ON local_hazard_orders
BEGIN
  SELECT RAISE(ABORT, 'local_hazard_orders : une lecture rangée ne change plus');
END;
CREATE TRIGGER IF NOT EXISTS local_hazard_orders_garde BEFORE DELETE ON local_hazard_orders
BEGIN
  SELECT RAISE(ABORT, 'local_hazard_orders : rien ne s''efface');
END;

-- Le raccordement d'un bien aux eaux usées, déclaré par l'agent du bien ou la direction : collectif (tout-à-l'égout) ou
-- non collectif (fosse, micro-station). Chaque saisie ajoute une ligne, la plus récente vaut [R17].
CREATE TABLE IF NOT EXISTS property_sanitation (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL REFERENCES properties (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  mode TEXT NOT NULL CHECK (mode IN ('collectif', 'non_collectif')),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  UNIQUE (property_id, version)
);
CREATE TRIGGER IF NOT EXISTS property_sanitation_fige BEFORE UPDATE ON property_sanitation
BEGIN
  SELECT RAISE(ABORT, 'property_sanitation : une saisie rangée ne change plus');
END;
CREATE TRIGGER IF NOT EXISTS property_sanitation_garde BEFORE DELETE ON property_sanitation
BEGIN
  SELECT RAISE(ABORT, 'property_sanitation : rien ne s''efface');
END;
