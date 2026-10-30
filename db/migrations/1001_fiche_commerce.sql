-- CE01 · Fiche du commerce (M16) : la fiche d'un bien de sorte `business` (fonds de commerce ou droit au bail),
-- `business_walls` (murs) ou `commercial` (local professionnel), versionnée. Une modification ajoute une version, rien
-- ne s'efface ni ne se réécrit [R17]. Chaque colonne est classée « public » ou « confidentiel » par une seule table du
-- code (`packages/core/src/commerces/fiche.ts`) ; une colonne qui n'y figure pas est confidentielle [R110].
-- Les migrations de M16 commencent à 1001.
CREATE TABLE IF NOT EXISTS business_sheets (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  -- Public : l'activité, en liste fermée (contrôlée par le code).
  activity TEXT,
  -- Confidentiel : le nom de l'enseigne.
  sign_name TEXT CHECK (sign_name IS NULL OR length(sign_name) BETWEEN 1 AND 120),
  -- Confidentiel : liste JSON des 3 derniers exercices au plus, `{year, revenueCents, resultCents, ebitdaCents?}`.
  fiscal_years TEXT NOT NULL DEFAULT '[]',
  -- Confidentiel : le bail commercial.
  lease_start TEXT CHECK (lease_start IS NULL OR lease_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  lease_years INTEGER CHECK (lease_years IS NULL OR lease_years BETWEEN 1 AND 99),
  lease_annual_rent_cents INTEGER CHECK (lease_annual_rent_cents IS NULL OR lease_annual_rent_cents BETWEEN 0 AND 100000000000),
  lease_use TEXT CHECK (lease_use IS NULL OR lease_use IN ('all_trades', 'named_activity', 'named_and_related')),
  lease_assignment TEXT CHECK (lease_assignment IS NULL OR lease_assignment IN ('free', 'landlord_approval', 'with_business_only')),
  -- Confidentiel : salariés, matériel (liste JSON de libellés courts), autorisations (liste JSON fermée).
  employees INTEGER CHECK (employees IS NULL OR employees BETWEEN 0 AND 100000),
  equipment TEXT NOT NULL DEFAULT '[]',
  licenses TEXT NOT NULL DEFAULT '[]',
  -- Objet JSON : champ → `agent:<id>` ou `direction:<id>`.
  sources TEXT NOT NULL DEFAULT '{}',
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (property_id, version),
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS business_sheets_property ON business_sheets (network_id, property_id, version);

CREATE TRIGGER IF NOT EXISTS business_sheets_fige BEFORE UPDATE ON business_sheets
BEGIN
  SELECT RAISE(ABORT, 'business_sheets : une version ne se réécrit pas');
END;

CREATE TRIGGER IF NOT EXISTS business_sheets_garde BEFORE DELETE ON business_sheets
BEGIN
  SELECT RAISE(ABORT, 'business_sheets : rien ne s''efface');
END;
