-- AU091b · La régularisation d'honoraires d'une vente avec une agence partenaire [R678, R235, R69, R17].
-- La part de l'agence (HX59) suit la version approuvée par la direction : même taux du bon, au centime inférieur des
-- nouveaux honoraires, dans la même écriture que la version ; seulement tant que son relevé n'est pas émis et que la
-- commission n'est pas due. Le relevé se calcule ensuite sur les honoraires régularisés. Rien ne s'efface.

-- Une version ne se range jamais sur une vente dont le relevé d'agence est déjà émis : il a pu être facturé.
CREATE TRIGGER IF NOT EXISTS commission_revisions_releve BEFORE INSERT ON commission_revisions
WHEN EXISTS (SELECT 1 FROM agency_fee_statements s WHERE s.file_id = NEW.file_id)
BEGIN SELECT RAISE(ABORT, 'commission_revisions : relevé d''agence déjà émis'); END;

-- La part de l'agence : seul son montant change, au calcul de la dernière version, pas encore appliquée.
DROP TRIGGER IF EXISTS commission_agency_shares_fige;
CREATE TRIGGER IF NOT EXISTS commission_agency_shares_fige BEFORE UPDATE ON commission_agency_shares
WHEN NOT (
  NEW.file_id IS OLD.file_id AND NEW.delegation_id IS OLD.delegation_id AND NEW.partner_share_bp IS OLD.partner_share_bp
  AND NEW.created_at IS OLD.created_at
  AND EXISTS (
    SELECT 1 FROM commission_revisions r JOIN commissions c ON c.file_id = r.file_id
     WHERE r.file_id = OLD.file_id AND r.fee_before_cents = c.fee_cents AND r.charge_before IS c.fee_charge
       AND r.version = (SELECT MAX(x.version) FROM commission_revisions x WHERE x.file_id = OLD.file_id)
       AND NEW.amount_cents = (r.fee_after_cents * OLD.partner_share_bp) / 10000
  )
  AND NOT EXISTS (SELECT 1 FROM agency_fee_statements s WHERE s.delegation_id = OLD.delegation_id OR s.file_id = OLD.file_id)
  AND NOT EXISTS (SELECT 1 FROM commission_steps s WHERE s.file_id = OLD.file_id AND s.status <> 'prevue')
)
BEGIN SELECT RAISE(ABORT, 'commission_agency_shares : rien ne change'); END;

-- Le relevé : sur les honoraires de la commission régularisée quand une version existe, sinon sur ceux dus de N06.
DROP TRIGGER IF EXISTS agency_fee_statements_calcul;
CREATE TRIGGER IF NOT EXISTS agency_fee_statements_calcul BEFORE INSERT ON agency_fee_statements
WHEN NEW.partner_share_bp IS NOT (SELECT d.partner_share_bp FROM agency_delegations d WHERE d.id = NEW.delegation_id)
  OR NEW.file_id IS NOT (SELECT f.file_id FROM agency_delegation_files f WHERE f.delegation_id = NEW.delegation_id)
  OR NOT EXISTS (SELECT 1 FROM sale_file_closings k WHERE k.file_id = NEW.file_id)
  OR NEW.fee_cents IS NOT COALESCE(
    (SELECT c.fee_cents FROM commissions c WHERE c.file_id = NEW.file_id AND EXISTS (SELECT 1 FROM commission_revisions r WHERE r.file_id = NEW.file_id)),
    (SELECT c.fee_eur * 100 FROM sale_commissions c WHERE c.file_id = NEW.file_id))
  OR NEW.partner_cents <> (NEW.fee_cents * NEW.partner_share_bp) / 10000
BEGIN SELECT RAISE(ABORT, 'agency_fee_statements : relevé non calculé'); END;
