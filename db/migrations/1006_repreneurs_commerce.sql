-- CE06 · Profil d'un repreneur de commerce (M16) [R115, R14, R17].
-- La recherche d'un projet `buy_business`, versionnée : activités et sortes cherchées, secteurs, budget, expérience
-- déclarée, apport et financement déclarés tels que dits, chaque champ avec sa source. Aucune colonne de revenus, de
-- patrimoine, de crédit ni de solvabilité : rien ne note la personne.
CREATE TABLE IF NOT EXISTS business_buyer_profiles (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  activities TEXT NOT NULL CHECK (json_valid(activities)),
  kinds TEXT NOT NULL CHECK (json_valid(kinds)),
  postal_codes TEXT NOT NULL CHECK (json_valid(postal_codes)),
  budget_max_eur INTEGER CHECK (budget_max_eur IS NULL OR budget_max_eur >= 0),
  experience TEXT CHECK (experience IS NULL OR experience IN ('aucune', 'salarie_du_metier', 'gerant_du_metier', 'gerant_autre_metier', 'reconversion')),
  declared_contribution_eur INTEGER CHECK (declared_contribution_eur IS NULL OR declared_contribution_eur >= 0),
  declared_financing TEXT CHECK (declared_financing IS NULL OR declared_financing IN ('apport_seul', 'pret_bancaire', 'pret_et_apport', 'a_definir')),
  sources TEXT NOT NULL CHECK (json_valid(sources)),
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, version),
  FOREIGN KEY (project_id, network_id) REFERENCES projects (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS business_buyer_profiles_fige BEFORE UPDATE ON business_buyer_profiles
BEGIN SELECT RAISE(ABORT, 'business_buyer_profiles : une version ne se réécrit pas'); END;
CREATE TRIGGER IF NOT EXISTS business_buyer_profiles_garde BEFORE DELETE ON business_buyer_profiles
BEGIN SELECT RAISE(ABORT, 'business_buyer_profiles : rien ne s''efface'); END;
