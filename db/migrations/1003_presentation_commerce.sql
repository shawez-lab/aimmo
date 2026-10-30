-- CE03 · Présentation anonyme d'un commerce (M16) : des brouillons rédigés par l'IA depuis la seule vue publique, ou
-- par le code en secours, ou corrigés par l'agent, chacun contrôlé avant d'être rangé [R110, R112]. Rien ne se réécrit
-- ni ne s'efface [R17] : un nouveau texte est un nouveau brouillon, une validation est une ligne à part.
CREATE TABLE IF NOT EXISTS business_presentations (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 3000),
  origin TEXT NOT NULL CHECK (origin IN ('ia', 'secours', 'agent')),
  -- La version de la fiche et l'estimation validée sur lesquelles le texte a été contrôlé.
  sheet_version INTEGER NOT NULL,
  valuation_id TEXT NOT NULL REFERENCES business_valuations (id) ON DELETE RESTRICT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (property_id, seq),
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS business_presentation_validations (
  presentation_id TEXT PRIMARY KEY REFERENCES business_presentations (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  validated_by TEXT NOT NULL,
  validated_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS business_presentations_fige BEFORE UPDATE ON business_presentations
BEGIN
  SELECT RAISE(ABORT, 'business_presentations : une présentation ne se réécrit pas');
END;
CREATE TRIGGER IF NOT EXISTS business_presentations_garde BEFORE DELETE ON business_presentations
BEGIN
  SELECT RAISE(ABORT, 'business_presentations : rien ne s''efface');
END;
CREATE TRIGGER IF NOT EXISTS business_presentation_validations_fige BEFORE UPDATE ON business_presentation_validations
BEGIN
  SELECT RAISE(ABORT, 'business_presentation_validations : une validation ne se réécrit pas');
END;
CREATE TRIGGER IF NOT EXISTS business_presentation_validations_garde BEFORE DELETE ON business_presentation_validations
BEGIN
  SELECT RAISE(ABORT, 'business_presentation_validations : rien ne s''efface');
END;
