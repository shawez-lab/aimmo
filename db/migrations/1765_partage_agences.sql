-- HX01 · Partage de biens entre agences et partage d'honoraires [R234, R235, R17].
-- Une agence partenaire est un professionnel, dans ses propres tables : jamais une fiche client, jamais une personne.
-- Tout s'ajoute, rien ne change ni ne s'efface [R17].
CREATE TABLE IF NOT EXISTS partner_agencies (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  business_name TEXT NOT NULL CHECK (length(business_name) BETWEEN 2 AND 120),
  -- Le numéro de carte professionnelle de l'agence, information publique d'un professionnel.
  card_number TEXT NOT NULL CHECK (length(card_number) BETWEEN 6 AND 40),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (id, network_id),
  UNIQUE (network_id, card_number)
);
CREATE TRIGGER IF NOT EXISTS partner_agencies_fige BEFORE UPDATE ON partner_agencies BEGIN SELECT RAISE(ABORT, 'partner_agencies : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS partner_agencies_garde BEFORE DELETE ON partner_agencies BEGIN SELECT RAISE(ABORT, 'partner_agencies : rien ne s''efface'); END;

-- Un bien partagé avec une agence, par l'agent du bien.
CREATE TABLE IF NOT EXISTS agency_shares (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  agency_id TEXT NOT NULL,
  shared_by TEXT NOT NULL,
  shared_at TEXT NOT NULL,
  UNIQUE (property_id, agency_id),
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (agency_id, network_id) REFERENCES partner_agencies (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS agency_shares_agency ON agency_shares (network_id, agency_id);
CREATE TRIGGER IF NOT EXISTS agency_shares_fige BEFORE UPDATE ON agency_shares BEGIN SELECT RAISE(ABORT, 'agency_shares : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS agency_shares_garde BEFORE DELETE ON agency_shares BEGIN SELECT RAISE(ABORT, 'agency_shares : rien ne s''efface'); END;

-- Le bon de délégation : une seule par partage, son partage d'honoraires fixé à la proposition et jamais changé.
CREATE TABLE IF NOT EXISTS agency_delegations (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL UNIQUE REFERENCES agency_shares (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  -- La part de l'agence partenaire sur les honoraires, en points de base (5 000 = la moitié).
  partner_share_bp INTEGER NOT NULL CHECK (partner_share_bp BETWEEN 1 AND 9999),
  proposed_by TEXT NOT NULL,
  proposed_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS agency_delegations_fige BEFORE UPDATE ON agency_delegations BEGIN SELECT RAISE(ABORT, 'agency_delegations : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS agency_delegations_garde BEFORE DELETE ON agency_delegations BEGIN SELECT RAISE(ABORT, 'agency_delegations : rien ne s''efface'); END;

-- L'accord de l'agence, puis le bon signé des deux, avec sa preuve. Jamais signé sans accord.
CREATE TABLE IF NOT EXISTS agency_delegation_steps (
  delegation_id TEXT NOT NULL REFERENCES agency_delegations (id) ON DELETE RESTRICT,
  step TEXT NOT NULL CHECK (step IN ('acceptee', 'signee')),
  proof_ref TEXT,
  -- L'attestation de l'agent que le mandat autorise la délégation : exigée pour le bon signé, et seulement pour lui.
  mandate_clause INTEGER CHECK (mandate_clause IS NULL OR mandate_clause = 1),
  at TEXT NOT NULL,
  by TEXT NOT NULL,
  PRIMARY KEY (delegation_id, step),
  CHECK ((step = 'signee') = (proof_ref IS NOT NULL)),
  CHECK ((step = 'signee') = (mandate_clause IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS agency_delegation_steps_fige BEFORE UPDATE ON agency_delegation_steps BEGIN SELECT RAISE(ABORT, 'agency_delegation_steps : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS agency_delegation_steps_garde BEFORE DELETE ON agency_delegation_steps BEGIN SELECT RAISE(ABORT, 'agency_delegation_steps : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS agency_delegation_signee_apres_accord BEFORE INSERT ON agency_delegation_steps
WHEN NEW.step = 'signee' AND NOT EXISTS (SELECT 1 FROM agency_delegation_steps s WHERE s.delegation_id = NEW.delegation_id AND s.step = 'acceptee')
BEGIN SELECT RAISE(ABORT, 'agency_delegation_steps : signée sans accord'); END;

-- Les co-visites : aucune ne se demande avant la délégation signée, même par une écriture directe [R234].
CREATE TABLE IF NOT EXISTS agency_visits (
  id TEXT PRIMARY KEY,
  delegation_id TEXT NOT NULL REFERENCES agency_delegations (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  wished_at TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agency_visits_delegation ON agency_visits (delegation_id);
CREATE TRIGGER IF NOT EXISTS agency_visits_fige BEFORE UPDATE ON agency_visits BEGIN SELECT RAISE(ABORT, 'agency_visits : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS agency_visits_garde BEFORE DELETE ON agency_visits BEGIN SELECT RAISE(ABORT, 'agency_visits : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS agency_visits_apres_signature BEFORE INSERT ON agency_visits
WHEN NOT EXISTS (SELECT 1 FROM agency_delegation_steps s WHERE s.delegation_id = NEW.delegation_id AND s.step = 'signee')
BEGIN SELECT RAISE(ABORT, 'agency_visits : délégation non signée'); END;
CREATE TABLE IF NOT EXISTS agency_visits_done (
  visit_id TEXT PRIMARY KEY REFERENCES agency_visits (id) ON DELETE RESTRICT,
  at TEXT NOT NULL,
  by TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS agency_visits_done_fige BEFORE UPDATE ON agency_visits_done BEGIN SELECT RAISE(ABORT, 'agency_visits_done : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS agency_visits_done_garde BEFORE DELETE ON agency_visits_done BEGIN SELECT RAISE(ABORT, 'agency_visits_done : rien ne s''efface'); END;

-- Le dossier de vente né de la délégation : un seul, et un dossier ne vient que d'une délégation.
CREATE TABLE IF NOT EXISTS agency_delegation_files (
  delegation_id TEXT PRIMARY KEY REFERENCES agency_delegations (id) ON DELETE RESTRICT,
  file_id TEXT NOT NULL UNIQUE REFERENCES sale_files (id) ON DELETE RESTRICT,
  at TEXT NOT NULL,
  by TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS agency_delegation_files_apres_signature BEFORE INSERT ON agency_delegation_files
WHEN NOT EXISTS (SELECT 1 FROM agency_delegation_steps s WHERE s.delegation_id = NEW.delegation_id AND s.step = 'signee')
  OR NOT EXISTS (
    SELECT 1 FROM agency_delegations d JOIN agency_shares a ON a.id = d.share_id JOIN sale_files f ON f.property_id = a.property_id
    WHERE d.id = NEW.delegation_id AND f.id = NEW.file_id)
BEGIN SELECT RAISE(ABORT, 'agency_delegation_files : délégation non signée ou autre bien'); END;
CREATE TRIGGER IF NOT EXISTS agency_delegation_files_fige BEFORE UPDATE ON agency_delegation_files BEGIN SELECT RAISE(ABORT, 'agency_delegation_files : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS agency_delegation_files_garde BEFORE DELETE ON agency_delegation_files BEGIN SELECT RAISE(ABORT, 'agency_delegation_files : rien ne s''efface'); END;

-- Le relevé du partage, calculé une fois à l'acte sur les honoraires dus, jamais saisi [R235].
CREATE TABLE IF NOT EXISTS agency_fee_statements (
  delegation_id TEXT PRIMARY KEY REFERENCES agency_delegations (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  file_id TEXT NOT NULL UNIQUE REFERENCES sale_files (id) ON DELETE RESTRICT,
  fee_cents INTEGER NOT NULL CHECK (fee_cents >= 0),
  partner_share_bp INTEGER NOT NULL CHECK (partner_share_bp BETWEEN 1 AND 9999),
  partner_cents INTEGER NOT NULL CHECK (partner_cents >= 0),
  own_cents INTEGER NOT NULL CHECK (own_cents >= 0),
  computed_at TEXT NOT NULL,
  CHECK (partner_cents + own_cents = fee_cents)
);
CREATE TRIGGER IF NOT EXISTS agency_fee_statements_fige BEFORE UPDATE ON agency_fee_statements BEGIN SELECT RAISE(ABORT, 'agency_fee_statements : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS agency_fee_statements_garde BEFORE DELETE ON agency_fee_statements BEGIN SELECT RAISE(ABORT, 'agency_fee_statements : rien ne s''efface'); END;
-- Le relevé ne s'écrit que calculé : le dossier rattaché, acte signé, honoraires dus de N06, taux du bon, part de
-- l'agence au centime inférieur (division entière). Toute autre écriture est refusée par la base.
CREATE TRIGGER IF NOT EXISTS agency_fee_statements_calcul BEFORE INSERT ON agency_fee_statements
WHEN NEW.partner_share_bp IS NOT (SELECT d.partner_share_bp FROM agency_delegations d WHERE d.id = NEW.delegation_id)
  OR NEW.file_id IS NOT (SELECT f.file_id FROM agency_delegation_files f WHERE f.delegation_id = NEW.delegation_id)
  OR NOT EXISTS (SELECT 1 FROM sale_file_closings k WHERE k.file_id = NEW.file_id)
  OR NEW.fee_cents IS NOT (SELECT c.fee_eur * 100 FROM sale_commissions c WHERE c.file_id = NEW.file_id)
  OR NEW.partner_cents <> (NEW.fee_cents * NEW.partner_share_bp) / 10000
BEGIN SELECT RAISE(ABORT, 'agency_fee_statements : relevé non calculé'); END;

-- La facture de rétrocession que l'agence adresse : rangée une fois, et seulement au montant du relevé [R235].
CREATE TABLE IF NOT EXISTS agency_partner_invoices (
  delegation_id TEXT PRIMARY KEY REFERENCES agency_fee_statements (delegation_id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  proof_ref TEXT NOT NULL,
  ttc_cents INTEGER NOT NULL CHECK (ttc_cents >= 0),
  received_at TEXT NOT NULL,
  by TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS agency_partner_invoices_fige BEFORE UPDATE ON agency_partner_invoices BEGIN SELECT RAISE(ABORT, 'agency_partner_invoices : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS agency_partner_invoices_garde BEFORE DELETE ON agency_partner_invoices BEGIN SELECT RAISE(ABORT, 'agency_partner_invoices : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS agency_partner_invoices_montant BEFORE INSERT ON agency_partner_invoices
WHEN NEW.ttc_cents <> (SELECT s.partner_cents FROM agency_fee_statements s WHERE s.delegation_id = NEW.delegation_id)
BEGIN SELECT RAISE(ABORT, 'agency_partner_invoices : montant différent du relevé'); END;
