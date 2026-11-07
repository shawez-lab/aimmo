-- HX33 · Mandat par questionnaire. Tables nouvelles, en ajout seul : rien ne s'efface ni ne se réécrit [R17, R443].

-- Le texte d'une clause, par son code (liste fermée du code) et sa version. Il naît « essai » ; seule la conformité le
-- passe « validé » (H08) : la validation s'ajoute à côté, la version ne change jamais [R442].
CREATE TABLE IF NOT EXISTS mandate_clause_versions (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 40),
  version INTEGER NOT NULL CHECK (version >= 1),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  hash TEXT NOT NULL CHECK (length(hash) = 64),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (network_id, code, version)
);
CREATE TRIGGER IF NOT EXISTS mandate_clause_versions_garde BEFORE DELETE ON mandate_clause_versions BEGIN SELECT RAISE(ABORT, 'mandate_clause_versions : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS mandate_clause_versions_fige BEFORE UPDATE ON mandate_clause_versions BEGIN SELECT RAISE(ABORT, 'mandate_clause_versions : rien ne se réécrit'); END;

-- La validation d'une version par une personne de la conformité : une seule fois, jamais par celui qui l'a écrite.
CREATE TABLE IF NOT EXISTS mandate_clause_validations (
  clause_id TEXT PRIMARY KEY REFERENCES mandate_clause_versions (id) ON DELETE RESTRICT,
  validated_by TEXT NOT NULL,
  validated_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS mandate_clause_validations_garde BEFORE DELETE ON mandate_clause_validations BEGIN SELECT RAISE(ABORT, 'mandate_clause_validations : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS mandate_clause_validations_fige BEFORE UPDATE ON mandate_clause_validations BEGIN SELECT RAISE(ABORT, 'mandate_clause_validations : rien ne se réécrit'); END;

-- L'écart de prix toléré, en points de base, réglé par la direction : chaque réglage s'ajoute, le dernier compte [R441].
CREATE TABLE IF NOT EXISTS mandate_price_gap_settings (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  max_gap_bps INTEGER NOT NULL CHECK (max_gap_bps BETWEEN 0 AND 5000),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mandate_price_gap_settings_network ON mandate_price_gap_settings (network_id, set_at);
CREATE TRIGGER IF NOT EXISTS mandate_price_gap_settings_garde BEFORE DELETE ON mandate_price_gap_settings BEGIN SELECT RAISE(ABORT, 'mandate_price_gap_settings : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS mandate_price_gap_settings_fige BEFORE UPDATE ON mandate_price_gap_settings BEGIN SELECT RAISE(ABORT, 'mandate_price_gap_settings : rien ne se réécrit'); END;

-- Un mandat préparé par questionnaire : les réponses, les clauses retenues (code, version, empreinte, réponse, texte de
-- référence), la comparaison du prix à l'avis validé, et le contenu figé [R440, R441, R442].
CREATE TABLE IF NOT EXISTS mandate_questionnaires (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  document_id TEXT NOT NULL UNIQUE REFERENCES documents (id) ON DELETE RESTRICT,
  valuation_id TEXT REFERENCES valuation_reports (id) ON DELETE RESTRICT,
  answers TEXT NOT NULL,
  clauses TEXT NOT NULL,
  price_eur INTEGER CHECK (price_eur IS NULL OR price_eur > 0),
  range_low INTEGER CHECK (range_low IS NULL OR range_low > 0),
  range_high INTEGER CHECK (range_high IS NULL OR range_high > range_low),
  gap_bps INTEGER CHECK (gap_bps IS NULL OR gap_bps >= 0),
  max_gap_bps INTEGER NOT NULL CHECK (max_gap_bps BETWEEN 0 AND 5000),
  -- `dans_fourchette`, `ecart` (au-delà du réglage), `sans_avis` (aucun avis validé), `sans_prix` (le bien n'a pas de prix).
  price_check TEXT NOT NULL CHECK (price_check IN ('dans_fourchette', 'ecart', 'sans_avis', 'sans_prix')),
  mode TEXT NOT NULL CHECK (mode IN ('essai', 'reel')),
  missing TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (price_check <> 'sans_avis' OR (valuation_id IS NULL AND price_eur IS NOT NULL)),
  CHECK ((price_check = 'sans_prix') = (price_eur IS NULL)),
  CHECK (price_check NOT IN ('dans_fourchette', 'ecart') OR (range_low IS NOT NULL AND gap_bps IS NOT NULL AND price_eur IS NOT NULL)),
  CHECK (price_check <> 'dans_fourchette' OR gap_bps <= max_gap_bps),
  CHECK (price_check <> 'ecart' OR gap_bps > max_gap_bps)
);
CREATE INDEX IF NOT EXISTS mandate_questionnaires_property ON mandate_questionnaires (network_id, property_id, created_at);
CREATE TRIGGER IF NOT EXISTS mandate_questionnaires_garde BEFORE DELETE ON mandate_questionnaires BEGIN SELECT RAISE(ABORT, 'mandate_questionnaires : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS mandate_questionnaires_fige BEFORE UPDATE ON mandate_questionnaires BEGIN SELECT RAISE(ABORT, 'mandate_questionnaires : rien ne se réécrit'); END;

-- L'agent du bien dit avoir montré l'écart de prix au vendeur, avant la signature : une seule fois par mandat préparé.
CREATE TABLE IF NOT EXISTS mandate_questionnaire_gap_acks (
  questionnaire_id TEXT PRIMARY KEY REFERENCES mandate_questionnaires (id) ON DELETE RESTRICT,
  by_agent TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS mandate_questionnaire_gap_acks_garde BEFORE DELETE ON mandate_questionnaire_gap_acks BEGIN SELECT RAISE(ABORT, 'mandate_questionnaire_gap_acks : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS mandate_questionnaire_gap_acks_fige BEFORE UPDATE ON mandate_questionnaire_gap_acks BEGIN SELECT RAISE(ABORT, 'mandate_questionnaire_gap_acks : rien ne se réécrit'); END;
