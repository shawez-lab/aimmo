-- K03 · Encaissement des honoraires et reversement sous 24 h ouvrées (M13) [R70, R62]. AIMMO ne reçoit ni ne suit de
-- fonds : seuls le fait rapporté par la direction, sa preuve et l'échéance calculée par le code sont rangés. Rien ne
-- change ni ne s'efface [R17].
CREATE TABLE IF NOT EXISTS commission_receipts (
  file_id TEXT PRIMARY KEY REFERENCES commissions (file_id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  received_at TEXT NOT NULL,
  proof_ref TEXT NOT NULL,
  -- L'échéance du reversement aux agents : 24 h ouvrées après l'encaissement, calculées par le code.
  payout_due_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS commission_payouts (
  file_id TEXT PRIMARY KEY REFERENCES commission_receipts (file_id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  paid_at TEXT NOT NULL,
  proof_ref TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS commission_payout_alerts (
  file_id TEXT NOT NULL REFERENCES commission_receipts (file_id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('avant_echeance', 'echeance_depassee')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (file_id, kind)
);
CREATE TRIGGER IF NOT EXISTS commission_receipts_fige BEFORE UPDATE ON commission_receipts BEGIN SELECT RAISE(ABORT, 'commission_receipts : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS commission_receipts_garde BEFORE DELETE ON commission_receipts BEGIN SELECT RAISE(ABORT, 'commission_receipts : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS commission_payouts_fige BEFORE UPDATE ON commission_payouts BEGIN SELECT RAISE(ABORT, 'commission_payouts : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS commission_payouts_garde BEFORE DELETE ON commission_payouts BEGIN SELECT RAISE(ABORT, 'commission_payouts : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS commission_payout_alerts_fige BEFORE UPDATE ON commission_payout_alerts BEGIN SELECT RAISE(ABORT, 'commission_payout_alerts : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS commission_payout_alerts_garde BEFORE DELETE ON commission_payout_alerts BEGIN SELECT RAISE(ABORT, 'commission_payout_alerts : rien ne s''efface'); END;
