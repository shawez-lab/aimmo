-- W10 : ce que M15 a préparé pour un client (échéance du propriétaire, reçus d'équité), passé par le contrôle central
-- des envois au planificateur. Une ligne par texte préparé : « envoyé » et « refusé » (exclusion, arrêt, texte devenu
-- faux) sont définitifs ; « en attente » (hors des heures d'envoi, accord pas encore donné) et « en échec » (canal en
-- panne) sont repris au passage suivant [R01, R03, R18].
CREATE TABLE IF NOT EXISTS rental_sends (
  kind TEXT NOT NULL CHECK (kind IN ('echeance', 'recu')),
  -- L'identifiant de `rental_owner_notices` ou de `rental_fairness_receipts`.
  ref_id TEXT NOT NULL,
  network_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'refused', 'waiting', 'failed')),
  rule TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, ref_id)
);
CREATE TRIGGER IF NOT EXISTS rental_sends_garde BEFORE DELETE ON rental_sends BEGIN SELECT RAISE(ABORT, 'rental_sends : rien ne s''efface'); END;
-- Une issue définitive ne change plus.
CREATE TRIGGER IF NOT EXISTS rental_sends_fige BEFORE UPDATE ON rental_sends WHEN OLD.status IN ('sent', 'refused') BEGIN SELECT RAISE(ABORT, 'rental_sends : une issue définitive ne change plus'); END;
