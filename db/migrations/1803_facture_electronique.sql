-- HX04 · Facture électronique. Le XML Factur-X (profil EN 16931) d'une facture figée, écrit une seule fois, avant son
-- envoi à la plateforme agréée : son empreinte prouve ce qui est parti. Il ne change ni ne s'efface [R71, R17].
CREATE TABLE IF NOT EXISTS invoice_facturx (
  invoice_id TEXT PRIMARY KEY REFERENCES invoices (id) ON DELETE RESTRICT,
  profile TEXT NOT NULL CHECK (profile = 'urn:cen.eu:en16931:2017'),
  xml TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS invoice_facturx_fige BEFORE UPDATE ON invoice_facturx BEGIN SELECT RAISE(ABORT, 'invoice_facturx : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS invoice_facturx_garde BEFORE DELETE ON invoice_facturx BEGIN SELECT RAISE(ABORT, 'invoice_facturx : rien ne s''efface'); END;
-- Un seul envoi à la fois : chaque essai d'envoi à la plateforme est réservé ici avant l'appel, une fois par numéro
-- d'essai ; deux passages simultanés ne transmettent jamais deux fois la même facture [R255].
CREATE TABLE IF NOT EXISTS invoice_transmission_claims (
  invoice_id TEXT NOT NULL REFERENCES invoices (id) ON DELETE RESTRICT,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  at TEXT NOT NULL,
  PRIMARY KEY (invoice_id, attempt)
);
CREATE TRIGGER IF NOT EXISTS invoice_transmission_claims_fige BEFORE UPDATE ON invoice_transmission_claims BEGIN SELECT RAISE(ABORT, 'invoice_transmission_claims : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS invoice_transmission_claims_garde BEFORE DELETE ON invoice_transmission_claims BEGIN SELECT RAISE(ABORT, 'invoice_transmission_claims : rien ne s''efface'); END;
