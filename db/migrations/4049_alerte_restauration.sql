-- AU109 · Un mois sans reçu réussi du test de restauration : une alerte, une seule, levée par le Worker même si le
-- travail GitHub a cessé. Aucune donnée d'une personne : un mois et des instants [R232].
CREATE TABLE IF NOT EXISTS base_restore_alerts (
  month TEXT PRIMARY KEY,
  last_receipt_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS base_restore_alerts_fige BEFORE UPDATE ON base_restore_alerts
BEGIN
  SELECT RAISE(ABORT, 'base_restore_alerts : une alerte ne se réécrit pas');
END;
CREATE TRIGGER IF NOT EXISTS base_restore_alerts_garde BEFORE DELETE ON base_restore_alerts
BEGIN
  SELECT RAISE(ABORT, 'base_restore_alerts : rien ne s''efface');
END;
