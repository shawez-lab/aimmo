-- N11 : le vendeur d'un dossier de vente, rangé une fois à l'ouverture : le mandant du dernier mandat vivant du bien.
CREATE TABLE IF NOT EXISTS sale_file_sellers (
  file_id TEXT PRIMARY KEY REFERENCES sale_files (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  mandate_id TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sale_file_sellers_personne ON sale_file_sellers (person_id);
CREATE TRIGGER IF NOT EXISTS sale_file_sellers_fige BEFORE UPDATE ON sale_file_sellers BEGIN SELECT RAISE(ABORT, 'sale_file_sellers : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS sale_file_sellers_sans_effacement BEFORE DELETE ON sale_file_sellers BEGIN SELECT RAISE(ABORT, 'sale_file_sellers : rien ne s''efface'); END;
-- Les dossiers déjà ouverts : le dernier mandat inscrit, ni annulé ni rétracté, signé au plus tard à l'ouverture.
INSERT OR IGNORE INTO sale_file_sellers (file_id, network_id, person_id, mandate_id, at)
SELECT f.id, f.network_id, m.person_id, m.id, f.opened_at
FROM sale_files f JOIN mandates m ON m.id = (
  SELECT c.id FROM mandates c
  WHERE c.network_id = f.network_id AND c.property_id = f.property_id AND c.signed_at <= f.opened_at
    AND EXISTS (SELECT 1 FROM mandate_register r WHERE r.network_id = c.network_id AND r.mandate_id = c.id AND r.kind = 'inscription'
                AND NOT EXISTS (SELECT 1 FROM mandate_register x WHERE x.network_id = r.network_id AND x.kind = 'annulation' AND x.cancels_seq = r.seq))
    AND NOT EXISTS (SELECT 1 FROM mandate_withdrawals w WHERE w.mandate_id = c.id)
  ORDER BY c.signed_at DESC, c.id DESC LIMIT 1
);
