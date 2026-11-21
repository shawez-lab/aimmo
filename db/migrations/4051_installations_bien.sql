-- AU084 · L'âge et la présence de chaque installation intérieure (électricité, gaz) d'un logement, déclarés avec leur
-- preuve, décident de la demande des diagnostics électricité et gaz [R10, R17, R60].
--
-- Une ligne par saisie de l'agent du bien ou de la direction : présence, année de pose ou de dernière rénovation
-- complète (vide si inconnue), genre et référence de la preuve. Une correction s'ajoute en nouvelle version, la plus
-- récente vaut ; rien ne change ni ne s'efface [R17].
CREATE TABLE IF NOT EXISTS property_installations (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL REFERENCES properties (id) ON DELETE RESTRICT,
  installation TEXT NOT NULL CHECK (installation IN ('electricite', 'gaz')),
  version INTEGER NOT NULL CHECK (version >= 1),
  present INTEGER NOT NULL CHECK (present IN (0, 1)),
  since_year INTEGER CHECK (since_year IS NULL OR (since_year >= 1880 AND present = 1)),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('certificat_conformite', 'facture_travaux', 'declaration_vendeur')),
  proof_ref TEXT NOT NULL,
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  UNIQUE (property_id, installation, version)
);
CREATE TRIGGER IF NOT EXISTS property_installations_fige BEFORE UPDATE ON property_installations
BEGIN
  SELECT RAISE(ABORT, 'property_installations : une saisie rangée ne change plus');
END;
CREATE TRIGGER IF NOT EXISTS property_installations_garde BEFORE DELETE ON property_installations
BEGIN
  SELECT RAISE(ABORT, 'property_installations : rien ne s''efface');
END;
