-- AU020 · Les fichiers à retirer d'un effacement réel, notés AVANT d'effacer les lignes qui les citent : si le retrait
-- échoue ou s'arrête, l'effacement refait les retrouve ici, alors que plus aucune ligne ne les cite [R17, R231].
-- Une ligne ne s'efface pas : son retrait fait se date [R17].
CREATE TABLE IF NOT EXISTS erasure_object_targets (
  request_id TEXT NOT NULL,
  network_id TEXT NOT NULL,
  storage TEXT NOT NULL,
  object_key TEXT NOT NULL,
  noted_at TEXT NOT NULL,
  removed_at TEXT,
  PRIMARY KEY (request_id, storage, object_key)
);
CREATE INDEX IF NOT EXISTS erasure_object_targets_pending ON erasure_object_targets (request_id) WHERE removed_at IS NULL;
CREATE TRIGGER IF NOT EXISTS erasure_object_targets_garde BEFORE DELETE ON erasure_object_targets BEGIN SELECT RAISE(ABORT, 'erasure_object_targets : rien ne s''efface'); END;
