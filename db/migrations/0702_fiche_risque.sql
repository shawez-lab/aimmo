-- L02 · Fiche de risque de chaque client, validée par le responsable [R14, R17, R23, R91].

-- La fiche préparée par la grille écrite et datée, à l'entrée en relation. Ses critères et leurs sources sont figés en
-- JSON (déclarations fermées, état du coffre, chiffres de la base) pour qu'elle se rejoue à l'identique. Elle ne vaut
-- rien tant que le responsable ne l'a pas validée.
CREATE TABLE IF NOT EXISTS risk_sheets (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('mandat', 'offre')),
  case_ref TEXT,
  grid_version TEXT NOT NULL,
  inputs TEXT NOT NULL CHECK (json_valid(inputs)),
  criteria TEXT NOT NULL CHECK (json_valid(criteria)),
  level TEXT NOT NULL CHECK (level IN ('faible', 'moyen', 'eleve')),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  prepared_by TEXT NOT NULL,
  prepared_at TEXT NOT NULL,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS risk_sheets_person ON risk_sheets (network_id, person_id, prepared_at);

-- La validation du responsable, une seule par fiche : validée telle quelle, ou corrigée avec sa raison.
CREATE TABLE IF NOT EXISTS risk_validations (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  sheet_id TEXT NOT NULL UNIQUE REFERENCES risk_sheets (id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('validee', 'corrigee')),
  level TEXT NOT NULL CHECK (level IN ('faible', 'moyen', 'eleve')),
  reason TEXT CHECK (reason IS NULL OR length(trim(reason)) > 0),
  validator_name TEXT NOT NULL CHECK (length(trim(validator_name)) > 0),
  validated_by TEXT NOT NULL,
  validated_on TEXT NOT NULL CHECK (length(validated_on) = 10),
  at TEXT NOT NULL,
  CHECK (decision = 'validee' OR reason IS NOT NULL)
);

CREATE TRIGGER IF NOT EXISTS risk_sheets_sans_changement BEFORE UPDATE ON risk_sheets BEGIN SELECT RAISE(ABORT, 'fiche de risque gardée'); END;
CREATE TRIGGER IF NOT EXISTS risk_sheets_sans_effacement BEFORE DELETE ON risk_sheets BEGIN SELECT RAISE(ABORT, 'fiche de risque gardée'); END;
CREATE TRIGGER IF NOT EXISTS risk_validations_sans_changement BEFORE UPDATE ON risk_validations BEGIN SELECT RAISE(ABORT, 'validation gardée'); END;
CREATE TRIGGER IF NOT EXISTS risk_validations_sans_effacement BEFORE DELETE ON risk_validations BEGIN SELECT RAISE(ABORT, 'validation gardée'); END;
