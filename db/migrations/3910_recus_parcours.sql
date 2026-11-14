-- BR72 · Le reçu du parcours complet fictif de chaque mois (SV04). Aucune donnée d'une personne : un instant, un mois,
-- réussi ou raté, et l'identifiant de l'étape cassée, pris dans une liste fermée.
CREATE TABLE IF NOT EXISTS journey_receipts (
  id TEXT PRIMARY KEY,
  ran_at TEXT NOT NULL,
  month TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('reussi', 'rate')),
  step TEXT CHECK (step IS NULL OR step IN ('premier_message', 'qualification', 'rendez_vous', 'estimation', 'mandat', 'annonce', 'acquereur', 'visite', 'offre', 'compromis_acte', 'apres_vente')),
  CHECK (outcome = 'rate' OR step IS NULL)
);
CREATE INDEX IF NOT EXISTS journey_receipts_ran ON journey_receipts (ran_at);

CREATE TRIGGER IF NOT EXISTS journey_receipts_fige BEFORE UPDATE ON journey_receipts
BEGIN
  SELECT RAISE(ABORT, 'journey_receipts : un reçu ne se réécrit pas');
END;
CREATE TRIGGER IF NOT EXISTS journey_receipts_garde BEFORE DELETE ON journey_receipts
BEGIN
  SELECT RAISE(ABORT, 'journey_receipts : rien ne s''efface');
END;
