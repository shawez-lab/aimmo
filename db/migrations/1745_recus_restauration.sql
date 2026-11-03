-- SV03 · Le reçu du test de restauration de chaque mois [R232]. Aucune donnée d'une personne : des instants, une durée,
-- des comptes de la base entière, une empreinte de toute la base et un code de raison. Jamais réussi sans preuve ni au-delà d'une heure.
CREATE TABLE IF NOT EXISTS base_restore_receipts (
  id TEXT PRIMARY KEY,
  tested_at TEXT NOT NULL,
  month TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('reussie', 'echouee')),
  reason TEXT CHECK (reason IS NULL OR reason IN ('aucune_copie', 'cle_absente', 'cle_invalide', 'stockage_absent', 'stockage_en_panne', 'copie_abimee', 'copie_trop_ancienne', 'non_identique', 'trop_longue', 'test_echoue')),
  copy_taken_at TEXT,
  duration_ms INTEGER,
  tables_count INTEGER,
  rows_count INTEGER,
  digest TEXT,
  CHECK (
    (outcome = 'reussie' AND reason IS NULL AND copy_taken_at IS NOT NULL AND duration_ms IS NOT NULL AND duration_ms <= 3600000 AND tables_count > 0 AND rows_count > 0 AND digest IS NOT NULL)
    OR (outcome = 'echouee' AND reason IS NOT NULL AND digest IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS base_restore_receipts_month ON base_restore_receipts (month, tested_at);

CREATE TRIGGER IF NOT EXISTS base_restore_receipts_fige BEFORE UPDATE ON base_restore_receipts
BEGIN
  SELECT RAISE(ABORT, 'base_restore_receipts : un reçu ne se réécrit pas');
END;
CREATE TRIGGER IF NOT EXISTS base_restore_receipts_garde BEFORE DELETE ON base_restore_receipts
BEGIN
  SELECT RAISE(ABORT, 'base_restore_receipts : rien ne s''efface');
END;
