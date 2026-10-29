-- CE02 · Estimation d'un commerce (M16) : des barèmes par activité, rangés par la direction avec leur source, et des
-- estimations en fourchette calculées par le code depuis la fiche du commerce (CE01) [R111]. Rien ne se réécrit ni ne
-- s'efface [R17] : un barème corrigé est une nouvelle version, une validation est une ligne à part.
CREATE TABLE IF NOT EXISTS business_valuation_scales (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  activity TEXT NOT NULL,
  -- `revenue_pct` : bornes en points de base du chiffre d'affaires moyen ; `ebitda_multiple` : bornes en centièmes
  -- de l'excédent brut d'exploitation moyen ; `rent_yield` : bornes en points de base du taux de rendement du loyer annuel (murs, local).
  method TEXT NOT NULL CHECK (method IN ('revenue_pct', 'ebitda_multiple', 'rent_yield')),
  low INTEGER NOT NULL CHECK (low >= 1),
  high INTEGER NOT NULL CHECK (high >= low),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 3 AND 300),
  source_date TEXT NOT NULL CHECK (source_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  version INTEGER NOT NULL CHECK (version >= 1),
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (network_id, activity, method, version)
);

CREATE TABLE IF NOT EXISTS business_valuations (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  sheet_version INTEGER NOT NULL,
  scale_id TEXT NOT NULL REFERENCES business_valuation_scales (id) ON DELETE RESTRICT,
  method TEXT NOT NULL CHECK (method IN ('revenue_pct', 'ebitda_multiple', 'rent_yield')),
  low_cents INTEGER NOT NULL CHECK (low_cents >= 0),
  high_cents INTEGER NOT NULL CHECK (high_cents >= low_cents),
  -- Liste JSON des lignes du calcul : `{label, value, source, hypothesis}`.
  lines TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS business_valuations_property ON business_valuations (network_id, property_id, created_at);

CREATE TABLE IF NOT EXISTS business_valuation_validations (
  valuation_id TEXT PRIMARY KEY REFERENCES business_valuations (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  validated_by TEXT NOT NULL,
  validated_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS business_valuation_scales_fige BEFORE UPDATE ON business_valuation_scales
BEGIN
  SELECT RAISE(ABORT, 'business_valuation_scales : un barème ne se réécrit pas');
END;
CREATE TRIGGER IF NOT EXISTS business_valuation_scales_garde BEFORE DELETE ON business_valuation_scales
BEGIN
  SELECT RAISE(ABORT, 'business_valuation_scales : rien ne s''efface');
END;
CREATE TRIGGER IF NOT EXISTS business_valuations_fige BEFORE UPDATE ON business_valuations
BEGIN
  SELECT RAISE(ABORT, 'business_valuations : une estimation ne se réécrit pas');
END;
CREATE TRIGGER IF NOT EXISTS business_valuations_garde BEFORE DELETE ON business_valuations
BEGIN
  SELECT RAISE(ABORT, 'business_valuations : rien ne s''efface');
END;
CREATE TRIGGER IF NOT EXISTS business_valuation_validations_fige BEFORE UPDATE ON business_valuation_validations
BEGIN
  SELECT RAISE(ABORT, 'business_valuation_validations : une validation ne se réécrit pas');
END;
CREATE TRIGGER IF NOT EXISTS business_valuation_validations_garde BEFORE DELETE ON business_valuation_validations
BEGIN
  SELECT RAISE(ABORT, 'business_valuation_validations : rien ne s''efface');
END;
