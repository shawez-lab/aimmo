-- AT07 · Pages de quartier et articles, rédigés depuis les données de la base, relus et validés [R155, R46, R07].
-- Rien ne s'efface ni ne se réécrit : chaque fait, texte et validation s'ajoute.

-- Une donnée publique du quartier, rangée par la direction avec sa source et sa date. La dernière ligne d'une clé
-- l'emporte ; une ligne `retired = 1` la retire des textes suivants.
CREATE TABLE IF NOT EXISTS neighbourhood_facts (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  zone_id TEXT NOT NULL REFERENCES price_zones (id) ON DELETE RESTRICT,
  fact_key TEXT NOT NULL CHECK (length(fact_key) BETWEEN 1 AND 60),
  kind TEXT NOT NULL CHECK (kind IN ('transport', 'ecole', 'commerce', 'marche', 'parc', 'sport', 'sante', 'culture', 'population', 'autre')),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 2 AND 120),
  value REAL,
  unit TEXT CHECK (unit IS NULL OR unit IN ('nombre', 'm', 'km', 'minutes', 'habitants', 'pourcent')),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 2 AND 160),
  source_date TEXT NOT NULL CHECK (length(source_date) = 10),
  retired INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0, 1)),
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  CHECK ((value IS NULL) = (unit IS NULL))
);
CREATE INDEX IF NOT EXISTS neighbourhood_facts_zone ON neighbourhood_facts (network_id, zone_id, fact_key, recorded_at);

-- Un texte proposé : la page d'un quartier, ou un article sur ce quartier. `data_digest` est l'empreinte des données
-- sur lesquelles il a été contrôlé.
CREATE TABLE IF NOT EXISTS neighbourhood_drafts (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  zone_id TEXT NOT NULL REFERENCES price_zones (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('page', 'article')),
  topic TEXT NOT NULL CHECK (topic IN ('quartier', 'prix', 'equipements')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 2 AND 160),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 6000),
  origin TEXT NOT NULL CHECK (origin IN ('ia', 'secours', 'redaction')),
  data_digest TEXT NOT NULL CHECK (length(data_digest) = 64),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK ((kind = 'page') = (topic = 'quartier'))
);
CREATE INDEX IF NOT EXISTS neighbourhood_drafts_zone ON neighbourhood_drafts (network_id, zone_id, kind, topic, created_at);

-- La validation nommée du texte exact, sur les données du moment [R155].
CREATE TABLE IF NOT EXISTS neighbourhood_validations (
  draft_id TEXT PRIMARY KEY REFERENCES neighbourhood_drafts (id) ON DELETE RESTRICT,
  text_sha256 TEXT NOT NULL CHECK (length(text_sha256) = 64),
  data_digest TEXT NOT NULL CHECK (length(data_digest) = 64),
  validated_by TEXT NOT NULL,
  validated_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS neighbourhood_facts_garde BEFORE DELETE ON neighbourhood_facts BEGIN SELECT RAISE(ABORT, 'neighbourhood_facts : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS neighbourhood_facts_fige BEFORE UPDATE ON neighbourhood_facts BEGIN SELECT RAISE(ABORT, 'neighbourhood_facts : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS neighbourhood_drafts_garde BEFORE DELETE ON neighbourhood_drafts BEGIN SELECT RAISE(ABORT, 'neighbourhood_drafts : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS neighbourhood_drafts_fige BEFORE UPDATE ON neighbourhood_drafts BEGIN SELECT RAISE(ABORT, 'neighbourhood_drafts : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS neighbourhood_validations_garde BEFORE DELETE ON neighbourhood_validations BEGIN SELECT RAISE(ABORT, 'neighbourhood_validations : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS neighbourhood_validations_fige BEFORE UPDATE ON neighbourhood_validations BEGIN SELECT RAISE(ABORT, 'neighbourhood_validations : rien ne se réécrit'); END;
