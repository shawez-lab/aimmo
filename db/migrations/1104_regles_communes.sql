-- Y04 · Règles de la commune pour un investisseur (autorisation préalable de mise en location, déclaration,
-- encadrement des loyers, changement d'usage) : rangées par la direction avec leur source et la date de cette source,
-- jamais écrites dans le code ; une règle sans source est refusée. Une correction s'ajoute, rien ne s'efface [R17].
CREATE TABLE IF NOT EXISTS commune_rental_rules (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  insee_code TEXT NOT NULL CHECK (length(insee_code) = 5),
  rule TEXT NOT NULL CHECK (rule IN ('autorisation_prealable', 'declaration_mise_en_location', 'encadrement_loyers', 'changement_usage')),
  effective_from TEXT NOT NULL,
  effective_until TEXT CHECK (effective_until IS NULL OR effective_until >= effective_from),
  source TEXT NOT NULL CHECK (length(trim(source)) >= 3),
  source_date TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS commune_rental_rules_lookup ON commune_rental_rules (network_id, insee_code, rule, recorded_at);
CREATE TRIGGER IF NOT EXISTS commune_rental_rules_garde BEFORE DELETE ON commune_rental_rules
BEGIN
  SELECT RAISE(ABORT, 'commune_rental_rules : rien ne s''efface');
END;
CREATE TRIGGER IF NOT EXISTS commune_rental_rules_fige BEFORE UPDATE ON commune_rental_rules
BEGIN
  SELECT RAISE(ABORT, 'commune_rental_rules : une règle rangée ne change plus');
END;
