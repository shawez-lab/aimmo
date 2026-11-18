-- AU002 · La désignation du bien et le domicile du mandant, en champs. Un mandat de vente reprend, depuis la base,
-- l'adresse du bien, sa désignation cadastrale et le domicile de chaque mandant ; il n'est « complet » qu'avec les trois.
-- Chaque saisie est une nouvelle ligne : la plus récente vaut, rien ne s'efface ni ne se réécrit. Ces lignes ne vont
-- jamais au journal ni dans un message à un client [R13, R19].
CREATE TABLE IF NOT EXISTS property_designations (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL REFERENCES properties (id) ON DELETE RESTRICT,
  -- Le rang de la saisie pour ce bien : la plus haute vaut.
  version INTEGER NOT NULL CHECK (version >= 1),
  street TEXT NOT NULL CHECK (length(street) BETWEEN 3 AND 200),
  postal_code TEXT NOT NULL CHECK (length(postal_code) = 5),
  city TEXT NOT NULL CHECK (length(city) BETWEEN 1 AND 100),
  -- Les parcelles, en JSON : [{"prefix": "012" | null, "section": "AB", "number": "123"}], au moins une.
  parcels TEXT NOT NULL CHECK (length(parcels) BETWEEN 2 AND 4000),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  UNIQUE (property_id, version)
);
CREATE INDEX IF NOT EXISTS property_designations_bien ON property_designations (network_id, property_id, version);
CREATE TRIGGER IF NOT EXISTS property_designations_fige BEFORE UPDATE ON property_designations
BEGIN
  SELECT RAISE(ABORT, 'property_designations : une désignation ne se réécrit pas');
END;
CREATE TRIGGER IF NOT EXISTS property_designations_garde BEFORE DELETE ON property_designations
BEGIN
  SELECT RAISE(ABORT, 'property_designations : rien ne s''efface');
END;

CREATE TABLE IF NOT EXISTS person_domiciles (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  -- Le rang de la saisie pour cette fiche : la plus haute vaut.
  version INTEGER NOT NULL CHECK (version >= 1),
  street TEXT NOT NULL CHECK (length(street) BETWEEN 3 AND 200),
  postal_code TEXT NOT NULL CHECK (length(postal_code) BETWEEN 2 AND 12),
  city TEXT NOT NULL CHECK (length(city) BETWEEN 1 AND 100),
  country TEXT CHECK (country IS NULL OR length(country) BETWEEN 2 AND 60),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  UNIQUE (person_id, version)
);
CREATE INDEX IF NOT EXISTS person_domiciles_fiche ON person_domiciles (network_id, person_id, version);
CREATE TRIGGER IF NOT EXISTS person_domiciles_fige BEFORE UPDATE ON person_domiciles
BEGIN
  SELECT RAISE(ABORT, 'person_domiciles : un domicile ne se réécrit pas');
END;
CREATE TRIGGER IF NOT EXISTS person_domiciles_garde BEFORE DELETE ON person_domiciles
BEGIN
  SELECT RAISE(ABORT, 'person_domiciles : rien ne s''efface');
END;
