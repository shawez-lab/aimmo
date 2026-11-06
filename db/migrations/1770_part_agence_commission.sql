-- HX59 · La part de l'agence partenaire sortie des honoraires au compromis, avant la grille [R235, R69, R17].
-- La part de l'agence d'un dossier rattaché à une délégation signée : une seule, calculée, jamais saisie ; avec les parts
-- de `commission_shares`, la somme fait toujours les honoraires de la commission.
CREATE TABLE IF NOT EXISTS commission_agency_shares (
  file_id TEXT PRIMARY KEY REFERENCES commissions (file_id) ON DELETE RESTRICT,
  delegation_id TEXT NOT NULL UNIQUE REFERENCES agency_delegations (id) ON DELETE RESTRICT,
  partner_share_bp INTEGER NOT NULL CHECK (partner_share_bp BETWEEN 1 AND 9999),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS commission_agency_shares_fige BEFORE UPDATE ON commission_agency_shares BEGIN SELECT RAISE(ABORT, 'commission_agency_shares : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS commission_agency_shares_garde BEFORE DELETE ON commission_agency_shares BEGIN SELECT RAISE(ABORT, 'commission_agency_shares : rien ne s''efface'); END;
-- Seulement la délégation rattachée à ce dossier, à son taux, au centime inférieur des honoraires de la commission.
CREATE TRIGGER IF NOT EXISTS commission_agency_shares_calcul BEFORE INSERT ON commission_agency_shares
WHEN NEW.delegation_id IS NOT (SELECT f.delegation_id FROM agency_delegation_files f WHERE f.file_id = NEW.file_id)
  OR NEW.partner_share_bp IS NOT (SELECT d.partner_share_bp FROM agency_delegations d WHERE d.id = NEW.delegation_id)
  OR NEW.amount_cents IS NOT (SELECT (c.fee_cents * NEW.partner_share_bp) / 10000 FROM commissions c WHERE c.file_id = NEW.file_id)
BEGIN SELECT RAISE(ABORT, 'commission_agency_shares : part non calculée'); END;
-- Une commission rangée ne change plus : un dossier ne se rattache plus à une délégation après elle.
CREATE TRIGGER IF NOT EXISTS agency_delegation_files_avant_commission BEFORE INSERT ON agency_delegation_files
WHEN EXISTS (SELECT 1 FROM commissions c WHERE c.file_id = NEW.file_id)
BEGIN SELECT RAISE(ABORT, 'agency_delegation_files : commission déjà prévue'); END;
