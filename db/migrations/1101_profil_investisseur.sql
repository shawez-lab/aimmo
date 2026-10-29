-- Y01 · Profil investisseur : le profil d'un projet `invest`, versionné. Une modification ajoute une version, rien ne
-- s'efface ni ne se réécrit [R17]. Seulement des champs sur le projet, en listes fermées et en nombres : aucun texte
-- libre, et aucun champ de revenus, d'emploi, de patrimoine, de crédit ni de solvabilité [R123]. Chaque champ rempli
-- porte sa source : `agent:<id>`, `client_dit:<id de l'agent qui l'a noté>` ou `qualification:<id>`.
-- Les migrations de M17 commencent à 1101 pour ne pas croiser celles de M16 (1001).
CREATE TABLE IF NOT EXISTS investor_profiles (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  budget_cents INTEGER CHECK (budget_cents IS NULL OR budget_cents BETWEEN 100 AND 100000000000),
  -- L'apport tel que la personne l'a déclaré, jamais vérifié ni évalué [R123].
  declared_down_payment_cents INTEGER CHECK (declared_down_payment_cents IS NULL OR declared_down_payment_cents BETWEEN 0 AND 100000000000),
  rental_target TEXT CHECK (rental_target IS NULL OR rental_target IN ('none', 'unfurnished', 'furnished', 'shared')),
  -- Liste JSON de codes INSEE de communes.
  sectors TEXT NOT NULL DEFAULT '[]',
  target_gross_yield_bp INTEGER CHECK (target_gross_yield_bp IS NULL OR target_gross_yield_bp BETWEEN 1 AND 10000),
  deadline TEXT CHECK (deadline IS NULL OR deadline IN ('now', 'within_3_months', 'within_6_months', 'within_1_year', 'later')),
  -- Objet JSON : champ → source.
  sources TEXT NOT NULL DEFAULT '{}',
  -- Ce qui a créé la version : `agent:<id>`, `direction:<id>` ou `qualification:<id>`. Une qualification ne sert qu'une fois.
  origin TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, version),
  FOREIGN KEY (project_id, network_id) REFERENCES projects (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, person_id) REFERENCES projects (id, person_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS investor_profiles_network ON investor_profiles (network_id, project_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS investor_profiles_origin ON investor_profiles (project_id, origin) WHERE origin LIKE 'qualification:%';

CREATE TRIGGER IF NOT EXISTS investor_profiles_fige BEFORE UPDATE ON investor_profiles
BEGIN
  SELECT RAISE(ABORT, 'investor_profiles : une version ne se réécrit pas');
END;

CREATE TRIGGER IF NOT EXISTS investor_profiles_garde BEFORE DELETE ON investor_profiles
BEGIN
  SELECT RAISE(ABORT, 'investor_profiles : rien ne s''efface');
END;
