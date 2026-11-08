-- HX49 · Factures fournisseurs, rapprochement bancaire et relances des impayés (M13). Tables nouvelles, en ajout seul :
-- rien ne s'efface [R17]. Aucune coordonnée bancaire ni libellé de banque rangé [R15] : d'une ligne de relevé, seuls
-- le jour, le montant, l'empreinte de la ligne et les numéros de facture qu'elle cite sont gardés.

-- Ce que le lecteur (l'IA) a lu sur une facture fournisseur, et le contrôle du code : rien n'est encore rangé.
CREATE TABLE IF NOT EXISTS supplier_invoice_reads (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  document_ref TEXT NOT NULL,
  -- Les champs lus, chacun avec sa page : fournisseur, numéro, date, lignes de TVA, totaux.
  read TEXT NOT NULL CHECK (json_valid(read)),
  -- Les écarts trouvés par le code, par code (total_ht, total_tva, total_ttc, taux, tva_ligne, champ).
  problems TEXT NOT NULL CHECK (json_valid(problems) AND json_type(problems) = 'array'),
  read_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS supplier_invoice_reads_network ON supplier_invoice_reads (network_id, created_at);

-- La facture fournisseur rangée par la direction : seulement si elle se recompte au centime [R550].
CREATE TABLE IF NOT EXISTS supplier_invoices (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  read_id TEXT NOT NULL UNIQUE REFERENCES supplier_invoice_reads (id) ON DELETE RESTRICT,
  supplier TEXT NOT NULL CHECK (length(supplier) BETWEEN 1 AND 120),
  number TEXT NOT NULL CHECK (length(number) BETWEEN 1 AND 60),
  issued_on TEXT NOT NULL,
  ht_cents INTEGER NOT NULL CHECK (ht_cents >= 0),
  vat_cents INTEGER NOT NULL CHECK (vat_cents >= 0),
  ttc_cents INTEGER NOT NULL CHECK (ttc_cents > 0),
  vat_lines TEXT NOT NULL CHECK (json_valid(vat_lines) AND json_type(vat_lines) = 'array' AND json_array_length(vat_lines) >= 1),
  -- Les champs que la direction a corrigés après la lecture, nommés un à un ; vide si rien n'a changé.
  corrected TEXT NOT NULL CHECK (json_valid(corrected) AND json_type(corrected) = 'array'),
  recorded_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (network_id, supplier, number),
  CHECK (ht_cents + vat_cents = ttc_cents)
);
-- La base recompte aussi : chaque taxe à un centime près de base × taux, les bases des lignes font le hors taxe, les
-- taxes des lignes font la TVA [R550].
CREATE TRIGGER IF NOT EXISTS supplier_invoices_recompte
BEFORE INSERT ON supplier_invoices
WHEN (SELECT COALESCE(SUM(json_extract(value, '$.baseCents')), -1) FROM json_each(NEW.vat_lines)) <> NEW.ht_cents
  OR (SELECT COALESCE(SUM(json_extract(value, '$.vatCents')), -1) FROM json_each(NEW.vat_lines)) <> NEW.vat_cents
  OR EXISTS (SELECT 1 FROM json_each(NEW.vat_lines) WHERE json_extract(value, '$.rateBp') NOT IN (0, 210, 550, 1000, 2000))
  OR EXISTS (SELECT 1 FROM json_each(NEW.vat_lines) WHERE abs(json_extract(value, '$.vatCents') * 10000 - json_extract(value, '$.baseCents') * json_extract(value, '$.rateBp')) > 10000)
BEGIN SELECT RAISE(ABORT, 'supplier_invoices : la facture ne se recompte pas'); END;

-- Une ligne de relevé de la banque du réseau, déposée par la direction. L'identifiant est l'empreinte de la ligne :
-- le même relevé déposé deux fois ne double rien.
CREATE TABLE IF NOT EXISTS bank_lines (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  day TEXT NOT NULL,
  -- Positif : un crédit ; négatif : un débit.
  amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0),
  -- Les numéros de facture du réseau cités par le libellé, lus par le code ; le libellé lui-même n'est pas gardé.
  invoice_refs TEXT NOT NULL CHECK (json_valid(invoice_refs) AND json_type(invoice_refs) = 'array'),
  imported_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bank_lines_network ON bank_lines (network_id, day);

-- Le rapprochement : une ligne de banque à une seule facture, une facture à une seule ligne [R551].
CREATE TABLE IF NOT EXISTS bank_reconciliations (
  line_id TEXT PRIMARY KEY REFERENCES bank_lines (id) ON DELETE RESTRICT,
  invoice_id TEXT NOT NULL UNIQUE REFERENCES invoices (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  -- `auto` : le montant et le numéro cité ne laissaient qu'un choix ; `direction` : choisi par la direction.
  mode TEXT NOT NULL CHECK (mode IN ('auto', 'direction')),
  by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- La base refuse un rapprochement à un autre montant, à une ligne de débit, à une facture qui n'est pas d'honoraires.
CREATE TRIGGER IF NOT EXISTS bank_reconciliations_montant
BEFORE INSERT ON bank_reconciliations
WHEN (SELECT amount_cents FROM bank_lines WHERE id = NEW.line_id) <> (SELECT amount_cents FROM invoices WHERE id = NEW.invoice_id)
  OR (SELECT kind FROM invoices WHERE id = NEW.invoice_id) <> 'honoraires'
  OR (SELECT network_id FROM bank_lines WHERE id = NEW.line_id) <> NEW.network_id
  OR (SELECT network_id FROM invoices WHERE id = NEW.invoice_id) <> NEW.network_id
  OR (SELECT amount_cents FROM bank_lines WHERE id = NEW.line_id) <= 0
  OR (SELECT day FROM bank_lines WHERE id = NEW.line_id) < (SELECT issued_on FROM invoices WHERE id = NEW.invoice_id)
  OR EXISTS (SELECT 1 FROM invoices a WHERE a.corrects_invoice_id = NEW.invoice_id)
BEGIN SELECT RAISE(ABORT, 'bank_reconciliations : montant, sorte, jour, avoir ou réseau différent'); END;

-- La relance d'une facture d'honoraires échue et non rapprochée, préparée par le code, validée par la direction [R553].
CREATE TABLE IF NOT EXISTS invoice_reminders (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  invoice_id TEXT NOT NULL REFERENCES invoices (id) ON DELETE RESTRICT,
  rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 3),
  person_id TEXT NOT NULL,
  -- Le texte figé à la préparation : c'est lui que la direction valide, et lui qui part.
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('a_valider', 'validee', 'envoyee', 'refusee', 'close')),
  rule TEXT,
  message_id TEXT,
  -- L'envoi en cours : posé d'une seule écriture avant le contrôle central, pour qu'un seul passage envoie la relance.
  sending_at TEXT,
  prepared_at TEXT NOT NULL,
  validated_by TEXT,
  validated_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (invoice_id, rank),
  CHECK ((validated_by IS NULL) = (validated_at IS NULL)),
  CHECK (status IN ('a_valider', 'close', 'refusee') OR validated_by IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS invoice_reminders_network ON invoice_reminders (network_id, status);
-- Aucune relance ne part sans validation [R553] : elle naît à valider (ou refusée par R62), jamais validée ni envoyée ;
-- elle n'est validée que depuis « à valider », envoyée que depuis « validée », et une relance close ou envoyée ne se
-- rouvre pas.
CREATE TRIGGER IF NOT EXISTS invoice_reminders_naissance
BEFORE INSERT ON invoice_reminders
WHEN NEW.status NOT IN ('a_valider', 'refusee') OR NEW.validated_by IS NOT NULL OR NEW.validated_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'invoice_reminders : une relance naît à valider'); END;
CREATE TRIGGER IF NOT EXISTS invoice_reminders_validation
BEFORE UPDATE OF status ON invoice_reminders
WHEN (NEW.status = 'validee' AND OLD.status NOT IN ('a_valider', 'validee'))
  OR (NEW.status = 'envoyee' AND (OLD.status <> 'validee' OR NEW.validated_by IS NULL))
  OR (NEW.status = 'refusee' AND OLD.status NOT IN ('validee', 'refusee'))
  OR (NEW.status = 'a_valider' AND OLD.status <> 'a_valider')
  OR (OLD.status IN ('envoyee', 'close', 'refusee') AND NEW.status <> OLD.status)
BEGIN SELECT RAISE(ABORT, 'invoice_reminders : aucune relance sans validation'); END;
CREATE TRIGGER IF NOT EXISTS invoice_reminders_validation_figee
BEFORE UPDATE OF validated_by, validated_at ON invoice_reminders
WHEN OLD.validated_by IS NOT NULL AND (NEW.validated_by IS NOT OLD.validated_by OR NEW.validated_at IS NOT OLD.validated_at)
BEGIN SELECT RAISE(ABORT, 'invoice_reminders : la validation ne change pas'); END;
CREATE TRIGGER IF NOT EXISTS invoice_reminders_texte_fige
BEFORE UPDATE OF text, invoice_id, person_id, rank, network_id, prepared_at ON invoice_reminders
BEGIN SELECT RAISE(ABORT, 'invoice_reminders : le texte validé ne change pas'); END;

CREATE TRIGGER IF NOT EXISTS supplier_invoice_reads_fige BEFORE UPDATE ON supplier_invoice_reads BEGIN SELECT RAISE(ABORT, 'supplier_invoice_reads : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS supplier_invoice_reads_garde BEFORE DELETE ON supplier_invoice_reads BEGIN SELECT RAISE(ABORT, 'supplier_invoice_reads : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS supplier_invoices_fige BEFORE UPDATE ON supplier_invoices BEGIN SELECT RAISE(ABORT, 'supplier_invoices : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS supplier_invoices_garde BEFORE DELETE ON supplier_invoices BEGIN SELECT RAISE(ABORT, 'supplier_invoices : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS bank_lines_fige BEFORE UPDATE ON bank_lines BEGIN SELECT RAISE(ABORT, 'bank_lines : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS bank_lines_garde BEFORE DELETE ON bank_lines BEGIN SELECT RAISE(ABORT, 'bank_lines : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS bank_reconciliations_fige BEFORE UPDATE ON bank_reconciliations BEGIN SELECT RAISE(ABORT, 'bank_reconciliations : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS bank_reconciliations_garde BEFORE DELETE ON bank_reconciliations BEGIN SELECT RAISE(ABORT, 'bank_reconciliations : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS invoice_reminders_garde BEFORE DELETE ON invoice_reminders BEGIN SELECT RAISE(ABORT, 'invoice_reminders : rien ne s''efface'); END;
