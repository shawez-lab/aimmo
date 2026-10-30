-- X08 · Options payantes du Studio (M19) : chaque demande d'option (photographe, drone, visite virtuelle,
-- aménagement virtuel) est une mise en relation de M18, rien de neuf : accord du client et rémunération y sont tenus
-- [R74]. Ici, seulement le lien entre la mise en relation et l'option demandée. Rien ne s'efface [R17].
CREATE TABLE IF NOT EXISTS studio_option_requests (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  referral_id TEXT NOT NULL UNIQUE REFERENCES partner_referrals (id) ON DELETE RESTRICT,
  option TEXT NOT NULL CHECK (option IN ('photographe', 'drone', 'visite_virtuelle', 'amenagement_virtuel')),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS studio_option_requests_garde BEFORE DELETE ON studio_option_requests BEGIN SELECT RAISE(ABORT, 'studio_option_requests : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS studio_option_requests_fige BEFORE UPDATE ON studio_option_requests BEGIN SELECT RAISE(ABORT, 'studio_option_requests : une demande ne change plus'); END;
