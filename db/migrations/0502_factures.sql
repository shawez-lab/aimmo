-- K02 · Factures d'honoraires et de reversement (M13), en mode essai [R71, R17]. Une facture a un numéro continu par
-- émetteur et par année, sans trou ni doublon ; elle ne change ni ne s'efface ; un avoir la corrige. Aucune donnée
-- bancaire [R15]. Les montants sont ceux des parts de la commission (K01), jamais saisis.
CREATE TABLE IF NOT EXISTS invoice_drafts (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  file_id TEXT NOT NULL REFERENCES commissions (file_id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('honoraires', 'reversement')),
  -- `reseau` pour les honoraires ; `agent:<id>` pour un reversement, émis au nom de l'agent.
  issuer TEXT NOT NULL,
  -- Le client qui paie les honoraires, ou le réseau pour un reversement.
  recipient_person_id TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  vat_bp INTEGER NOT NULL CHECK (vat_bp BETWEEN 0 AND 10000),
  -- Le rang du brouillon pour ce dossier, cette sorte et cet émetteur : un nouveau brouillon après un avoir.
  round INTEGER NOT NULL CHECK (round >= 1),
  created_at TEXT NOT NULL,
  UNIQUE (file_id, kind, issuer, round)
);
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  issuer TEXT NOT NULL,
  year INTEGER NOT NULL,
  number INTEGER NOT NULL CHECK (number >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('honoraires', 'reversement', 'avoir')),
  file_id TEXT NOT NULL REFERENCES commissions (file_id) ON DELETE RESTRICT,
  draft_id TEXT UNIQUE REFERENCES invoice_drafts (id) ON DELETE RESTRICT,
  corrects_invoice_id TEXT UNIQUE REFERENCES invoices (id) ON DELETE RESTRICT,
  -- Le contenu figé : mentions, désignation, montants hors taxe, TVA, toutes taxes.
  content TEXT NOT NULL CHECK (json_valid(content)),
  amount_cents INTEGER NOT NULL,
  issued_on TEXT NOT NULL,
  validated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (network_id, issuer, year, number),
  CHECK ((kind = 'avoir') = (corrects_invoice_id IS NOT NULL)),
  CHECK ((kind = 'avoir') = (draft_id IS NULL))
);
CREATE INDEX IF NOT EXISTS invoices_file ON invoices (file_id);
-- L'envoi à la plateforme agréée : la seule écriture qui s'ajoute après la facture, une fois.
CREATE TABLE IF NOT EXISTS invoice_transmissions (
  invoice_id TEXT PRIMARY KEY REFERENCES invoices (id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK (mode IN ('essai')),
  platform_ref TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS invoice_drafts_fige BEFORE UPDATE ON invoice_drafts BEGIN SELECT RAISE(ABORT, 'invoice_drafts : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS invoice_drafts_garde BEFORE DELETE ON invoice_drafts BEGIN SELECT RAISE(ABORT, 'invoice_drafts : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS invoices_fige BEFORE UPDATE ON invoices BEGIN SELECT RAISE(ABORT, 'invoices : une facture ne change jamais'); END;
CREATE TRIGGER IF NOT EXISTS invoices_garde BEFORE DELETE ON invoices BEGIN SELECT RAISE(ABORT, 'invoices : une facture ne s''efface jamais'); END;
CREATE TRIGGER IF NOT EXISTS invoice_transmissions_fige BEFORE UPDATE ON invoice_transmissions BEGIN SELECT RAISE(ABORT, 'invoice_transmissions : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS invoice_transmissions_garde BEFORE DELETE ON invoice_transmissions BEGIN SELECT RAISE(ABORT, 'invoice_transmissions : rien ne s''efface'); END;
-- Sans trou et dans l'ordre des jours : un numéro est toujours le suivant de son émetteur pour l'année [R71].
CREATE TRIGGER IF NOT EXISTS invoices_sans_trou
BEFORE INSERT ON invoices
WHEN NEW.number <> 1 + COALESCE((SELECT MAX(number) FROM invoices WHERE network_id = NEW.network_id AND issuer = NEW.issuer AND year = NEW.year), 0)
  OR NEW.issued_on < COALESCE((SELECT MAX(issued_on) FROM invoices WHERE network_id = NEW.network_id AND issuer = NEW.issuer AND year = NEW.year), '')
BEGIN SELECT RAISE(ABORT, 'invoices : numéro hors suite'); END;
