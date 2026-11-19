-- AU013 · Factures réelles, à côté des factures d'essai [R71]. Rien n'est refait ni effacé : `invoices` garde son
-- compteur interne (le numéro d'essai), et une facture réelle reçoit en plus, dans la même écriture, son numéro
-- officiel, dans une suite à elle par émetteur et par année, continue, sans trou et dans l'ordre des jours. Une facture
-- d'essai ne prend jamais un numéro réel, et ses numéros ne comptent jamais dans la suite réelle.
CREATE TABLE IF NOT EXISTS invoice_real_numbers (
  invoice_id TEXT PRIMARY KEY REFERENCES invoices (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  issuer TEXT NOT NULL,
  year INTEGER NOT NULL,
  number INTEGER NOT NULL CHECK (number >= 1),
  issued_on TEXT NOT NULL,
  UNIQUE (network_id, issuer, year, number)
);
CREATE TRIGGER IF NOT EXISTS invoice_real_numbers_fige BEFORE UPDATE ON invoice_real_numbers BEGIN SELECT RAISE(ABORT, 'invoice_real_numbers : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS invoice_real_numbers_garde BEFORE DELETE ON invoice_real_numbers BEGIN SELECT RAISE(ABORT, 'invoice_real_numbers : rien ne s''efface'); END;
-- Sans trou, dans l'ordre des jours, et seulement pour une facture du même émetteur, de la même année et du même jour,
-- dont le contenu figé se dit réel.
CREATE TRIGGER IF NOT EXISTS invoice_real_numbers_suite
BEFORE INSERT ON invoice_real_numbers
WHEN NEW.number <> 1 + COALESCE((SELECT MAX(number) FROM invoice_real_numbers WHERE network_id = NEW.network_id AND issuer = NEW.issuer AND year = NEW.year), 0)
  OR NEW.issued_on < COALESCE((SELECT MAX(issued_on) FROM invoice_real_numbers WHERE network_id = NEW.network_id AND issuer = NEW.issuer AND year = NEW.year), '')
  OR NOT EXISTS (
    SELECT 1 FROM invoices i WHERE i.id = NEW.invoice_id AND i.network_id = NEW.network_id AND i.issuer = NEW.issuer AND i.year = NEW.year
      AND i.issued_on = NEW.issued_on AND json_extract(i.content, '$.mode') = 'reel')
BEGIN SELECT RAISE(ABORT, 'invoice_real_numbers : numéro hors suite'); END;

-- Le dépôt d'une facture réelle à la plateforme agréée : une seule fois, jamais pour une facture d'essai.
CREATE TABLE IF NOT EXISTS invoice_real_deposits (
  invoice_id TEXT PRIMARY KEY REFERENCES invoice_real_numbers (invoice_id) ON DELETE RESTRICT,
  platform_ref TEXT NOT NULL CHECK (length(platform_ref) BETWEEN 1 AND 200),
  at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS invoice_real_deposits_fige BEFORE UPDATE ON invoice_real_deposits BEGIN SELECT RAISE(ABORT, 'invoice_real_deposits : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS invoice_real_deposits_garde BEFORE DELETE ON invoice_real_deposits BEGIN SELECT RAISE(ABORT, 'invoice_real_deposits : rien ne s''efface'); END;
-- Une facture d'essai ne va jamais à la table des envois d'essai si elle est réelle.
CREATE TRIGGER IF NOT EXISTS invoice_transmissions_essai_seul
BEFORE INSERT ON invoice_transmissions
WHEN EXISTS (SELECT 1 FROM invoice_real_numbers r WHERE r.invoice_id = NEW.invoice_id)
BEGIN SELECT RAISE(ABORT, 'invoice_transmissions : une facture réelle ne part pas en essai'); END;

-- Le cycle de vie dit par la plateforme, statut après statut, dans la liste fermée de la réforme (codes 200 à 213).
CREATE TABLE IF NOT EXISTS invoice_real_statuses (
  invoice_id TEXT NOT NULL REFERENCES invoice_real_deposits (invoice_id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  code INTEGER NOT NULL CHECK (code BETWEEN 200 AND 213),
  at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (invoice_id, seq),
  UNIQUE (invoice_id, code, at)
);
CREATE TRIGGER IF NOT EXISTS invoice_real_statuses_fige BEFORE UPDATE ON invoice_real_statuses BEGIN SELECT RAISE(ABORT, 'invoice_real_statuses : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS invoice_real_statuses_garde BEFORE DELETE ON invoice_real_statuses BEGIN SELECT RAISE(ABORT, 'invoice_real_statuses : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS invoice_real_statuses_suite
BEFORE INSERT ON invoice_real_statuses
WHEN NEW.seq <> 1 + COALESCE((SELECT MAX(seq) FROM invoice_real_statuses WHERE invoice_id = NEW.invoice_id), 0)
BEGIN SELECT RAISE(ABORT, 'invoice_real_statuses : statut hors suite'); END;
