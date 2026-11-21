-- AU091 · Régularisation d'une commission prévue après une baisse (ou une hausse) d'honoraires signée après le compromis
-- [R678, R63, R67, R69, R17]. La direction approuve, avec son motif, un recalcul fait par le code depuis l'avenant signé
-- en vigueur : jamais un montant saisi. Chaque version garde les honoraires et les parts d'avant et d'après ; la
-- commission et ses parts ne changent que par une version rangée dans la même écriture, et seulement tant que la
-- commission n'est pas due (rien n'est facturé ni versé).
CREATE TABLE IF NOT EXISTS commission_revisions (
  file_id TEXT NOT NULL REFERENCES commissions (file_id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  fee_before_cents INTEGER NOT NULL CHECK (fee_before_cents >= 0),
  fee_after_cents INTEGER NOT NULL CHECK (fee_after_cents >= 0),
  charge_before TEXT CHECK (charge_before IS NULL OR charge_before IN ('vendeur', 'acquereur')),
  charge_after TEXT CHECK (charge_after IS NULL OR charge_after IN ('vendeur', 'acquereur')),
  -- L'avenant signé qui porte les nouveaux honoraires.
  amendment_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  -- Les parts d'avant et d'après, `[{kind, beneficiaryId, reason, amountCents}]`, part d'agence comprise.
  shares_before TEXT NOT NULL CHECK (json_valid(shares_before)),
  shares_after TEXT NOT NULL CHECK (json_valid(shares_after)),
  approved_by TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (file_id, version),
  CHECK (fee_before_cents <> fee_after_cents OR charge_before IS NOT charge_after)
);
CREATE TRIGGER IF NOT EXISTS commission_revisions_fige BEFORE UPDATE ON commission_revisions BEGIN SELECT RAISE(ABORT, 'commission_revisions : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS commission_revisions_garde BEFORE DELETE ON commission_revisions BEGIN SELECT RAISE(ABORT, 'commission_revisions : rien ne s''efface'); END;
-- Une version suit la précédente, part des honoraires en cours, et jamais d'une commission déjà due.
CREATE TRIGGER IF NOT EXISTS commission_revisions_ordre BEFORE INSERT ON commission_revisions
WHEN NEW.version IS NOT (SELECT COALESCE(MAX(r.version), 0) + 1 FROM commission_revisions r WHERE r.file_id = NEW.file_id)
  OR NEW.fee_before_cents IS NOT (SELECT c.fee_cents FROM commissions c WHERE c.file_id = NEW.file_id)
  OR NEW.charge_before IS NOT (SELECT c.fee_charge FROM commissions c WHERE c.file_id = NEW.file_id)
  OR NEW.network_id IS NOT (SELECT c.network_id FROM commissions c WHERE c.file_id = NEW.file_id)
  OR EXISTS (SELECT 1 FROM commission_steps s WHERE s.file_id = NEW.file_id AND s.status <> 'prevue')
BEGIN SELECT RAISE(ABORT, 'commission_revisions : version hors d''ordre'); END;

-- La commission : seuls ses honoraires et qui les paie changent, à la valeur de la dernière version, pas encore appliquée.
DROP TRIGGER IF EXISTS commissions_fige;
CREATE TRIGGER IF NOT EXISTS commissions_fige BEFORE UPDATE ON commissions
WHEN NOT (
  NEW.file_id IS OLD.file_id AND NEW.network_id IS OLD.network_id AND NEW.agent_id IS OLD.agent_id
  AND NEW.mandate_id IS OLD.mandate_id AND NEW.compromis_on IS OLD.compromis_on
  AND NEW.grid_id IS OLD.grid_id AND NEW.created_at IS OLD.created_at
  AND EXISTS (
    SELECT 1 FROM commission_revisions r WHERE r.file_id = OLD.file_id AND r.fee_before_cents = OLD.fee_cents AND r.fee_after_cents = NEW.fee_cents
      AND r.charge_before IS OLD.fee_charge AND r.charge_after IS NEW.fee_charge
      AND NOT (OLD.fee_cents = NEW.fee_cents AND OLD.fee_charge IS NEW.fee_charge)
      AND r.version = (SELECT MAX(x.version) FROM commission_revisions x WHERE x.file_id = OLD.file_id)
  )
  AND NOT EXISTS (SELECT 1 FROM commission_steps s WHERE s.file_id = OLD.file_id AND s.status <> 'prevue')
)
BEGIN SELECT RAISE(ABORT, 'commissions : rien ne change'); END;

-- Les parts d'avant ne s'effacent que dans l'écriture d'une version qui les garde, pas encore appliquée.
DROP TRIGGER IF EXISTS commission_shares_garde;
CREATE TRIGGER IF NOT EXISTS commission_shares_garde BEFORE DELETE ON commission_shares
WHEN NOT (
  EXISTS (
    SELECT 1 FROM commission_revisions r JOIN commissions c ON c.file_id = r.file_id
     WHERE r.file_id = OLD.file_id AND r.fee_before_cents = c.fee_cents AND r.charge_before IS c.fee_charge
       AND r.version = (SELECT MAX(x.version) FROM commission_revisions x WHERE x.file_id = OLD.file_id)
  )
  AND NOT EXISTS (SELECT 1 FROM commission_steps s WHERE s.file_id = OLD.file_id AND s.status <> 'prevue')
)
BEGIN SELECT RAISE(ABORT, 'commission_shares : rien ne s''efface'); END;

DROP TRIGGER IF EXISTS commission_agency_shares_garde;
CREATE TRIGGER IF NOT EXISTS commission_agency_shares_garde BEFORE DELETE ON commission_agency_shares
WHEN NOT (
  EXISTS (
    SELECT 1 FROM commission_revisions r JOIN commissions c ON c.file_id = r.file_id
     WHERE r.file_id = OLD.file_id AND r.fee_before_cents = c.fee_cents AND r.charge_before IS c.fee_charge
       AND r.version = (SELECT MAX(x.version) FROM commission_revisions x WHERE x.file_id = OLD.file_id)
  )
  AND NOT EXISTS (SELECT 1 FROM commission_steps s WHERE s.file_id = OLD.file_id AND s.status <> 'prevue')
)
BEGIN SELECT RAISE(ABORT, 'commission_agency_shares : rien ne s''efface'); END;
