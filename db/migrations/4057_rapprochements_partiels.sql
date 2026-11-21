-- AU094 · Rapprochements par montants : plusieurs lignes de banque soldent une facture d'honoraires (règlement en
-- plusieurs fois), une ligne en solde plusieurs (virement groupé). Chaque part est un montant au centime, choisi par la
-- direction ; jamais plus que ce que la ligne apporte, ni que ce que la facture demande. Rien ne change ni ne s'efface.
CREATE TABLE IF NOT EXISTS bank_allocations (
  line_id TEXT NOT NULL REFERENCES bank_lines (id) ON DELETE RESTRICT,
  invoice_id TEXT NOT NULL REFERENCES invoices (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (line_id, invoice_id)
);
CREATE INDEX IF NOT EXISTS bank_allocations_facture ON bank_allocations (invoice_id);
CREATE TRIGGER IF NOT EXISTS bank_allocations_bornes
BEFORE INSERT ON bank_allocations
WHEN (SELECT amount_cents FROM bank_lines WHERE id = NEW.line_id) <= 0
  OR (SELECT kind FROM invoices WHERE id = NEW.invoice_id) <> 'honoraires'
  OR (SELECT network_id FROM bank_lines WHERE id = NEW.line_id) <> NEW.network_id
  OR (SELECT network_id FROM invoices WHERE id = NEW.invoice_id) <> NEW.network_id
  OR (SELECT COALESCE(SUM(amount_cents), 0) FROM bank_allocations WHERE line_id = NEW.line_id) + NEW.amount_cents > (SELECT amount_cents FROM bank_lines WHERE id = NEW.line_id)
  OR (SELECT COALESCE(SUM(amount_cents), 0) FROM bank_allocations WHERE invoice_id = NEW.invoice_id) + NEW.amount_cents > (SELECT amount_cents FROM invoices WHERE id = NEW.invoice_id)
  OR EXISTS (SELECT 1 FROM bank_reconciliations WHERE line_id = NEW.line_id OR invoice_id = NEW.invoice_id)
  OR EXISTS (SELECT 1 FROM invoices WHERE corrects_invoice_id = NEW.invoice_id)
BEGIN
  SELECT RAISE(ABORT, 'bank_allocations : part hors bornes');
END;
CREATE TRIGGER IF NOT EXISTS bank_allocations_fige BEFORE UPDATE ON bank_allocations BEGIN SELECT RAISE(ABORT, 'bank_allocations : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS bank_allocations_garde BEFORE DELETE ON bank_allocations BEGIN SELECT RAISE(ABORT, 'bank_allocations : rien ne s''efface'); END;
-- Une ligne ou une facture déjà partagée par montants ne se rapproche plus un à un.
CREATE TRIGGER IF NOT EXISTS bank_reconciliations_sans_parts
BEFORE INSERT ON bank_reconciliations
WHEN EXISTS (SELECT 1 FROM bank_allocations WHERE line_id = NEW.line_id OR invoice_id = NEW.invoice_id)
BEGIN
  SELECT RAISE(ABORT, 'bank_reconciliations : ligne ou facture déjà partagée par montants');
END;
