-- T01 · Fiche acquéreur : la recherche d'un projet d'achat, versionnée. Une modification ajoute une version, rien ne
-- s'efface ni ne se réécrit [R17]. Seulement des champs sur le bien et le projet, pris dans des listes fermées
-- [R50] ; aucun texte libre. Chaque champ rempli porte sa source (message reçu ou agent).
-- Les migrations de M08 commencent à 0101 pour ne pas croiser celles de la voie 2.
CREATE TABLE IF NOT EXISTS buyer_searches (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  -- Listes JSON prises dans des listes fermées.
  property_kinds TEXT NOT NULL DEFAULT '[]',
  communes TEXT NOT NULL DEFAULT '[]',
  features TEXT NOT NULL DEFAULT '[]',
  surface_min_m2 INTEGER CHECK (surface_min_m2 IS NULL OR surface_min_m2 BETWEEN 1 AND 100000),
  rooms_min INTEGER CHECK (rooms_min IS NULL OR rooms_min BETWEEN 1 AND 50),
  bedrooms_min INTEGER CHECK (bedrooms_min IS NULL OR bedrooms_min BETWEEN 1 AND 50),
  budget_max_eur INTEGER CHECK (budget_max_eur IS NULL OR budget_max_eur BETWEEN 1 AND 1000000000),
  -- Le financement tel que la personne l'a déclaré, jamais évalué [R24].
  financing TEXT CHECK (financing IS NULL OR financing IN ('cash', 'loan_approved', 'loan_in_progress', 'loan_needed')),
  urgency TEXT CHECK (urgency IS NULL OR urgency IN ('now', 'within_3_months', 'within_6_months', 'within_1_year', 'later')),
  -- Objet JSON : champ → `message:<id>` ou `agent:<id>`.
  sources TEXT NOT NULL DEFAULT '{}',
  -- Ce qui a créé la version : `qualification:<id>` ou `agent:<id>`. Une qualification ne sert qu'une fois.
  origin TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, version),
  FOREIGN KEY (project_id, network_id) REFERENCES projects (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, person_id) REFERENCES projects (id, person_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS buyer_searches_network ON buyer_searches (network_id, project_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS buyer_searches_origin ON buyer_searches (project_id, origin) WHERE origin LIKE 'qualification:%';

CREATE TRIGGER IF NOT EXISTS buyer_searches_fige BEFORE UPDATE ON buyer_searches
BEGIN
  SELECT RAISE(ABORT, 'buyer_searches : une version ne se réécrit pas');
END;

CREATE TRIGGER IF NOT EXISTS buyer_searches_garde BEFORE DELETE ON buyer_searches
BEGIN
  SELECT RAISE(ABORT, 'buyer_searches : rien ne s''efface');
END;
