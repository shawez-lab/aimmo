-- RC15 · Une clé remise à un partenaire de l'annuaire, sans agent. Tables nouvelles, en ajout seul : les tables de HX10
-- ne changent pas, seuls des déclencheurs s'y ajoutent ; rien ne change ni ne s'efface [R17].
-- Aucune donnée d'un client : un trousseau, un partenaire de l'annuaire, l'agent qui en répond [R13].

-- Une remise du trousseau à un partenaire de l'annuaire du même réseau (diagnostiqueur, photographe, artisan ou
-- géomètre), pour un diagnostic, des photos ou des travaux, à rendre dans les 12 heures. L'agent qui en répond reçoit
-- les rappels [R665, R272].
CREATE TABLE IF NOT EXISTS property_key_partner_loans (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  partner_id TEXT NOT NULL,
  responsible_agent_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('diagnostic', 'photos', 'travaux')),
  due_at TEXT NOT NULL,
  handed_by TEXT NOT NULL,
  out_at TEXT NOT NULL CHECK (due_at > out_at),
  FOREIGN KEY (key_id, network_id) REFERENCES property_keys (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (partner_id, network_id) REFERENCES partners (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (responsible_agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS property_key_partner_loans_key ON property_key_partner_loans (key_id, out_at);
CREATE INDEX IF NOT EXISTS property_key_partner_loans_agent ON property_key_partner_loans (network_id, responsible_agent_id, due_at);
-- Le retour d'une remise, une fois, noté par l'agent qui en répond ou la direction : rendu à l'armoire, ou perdu.
CREATE TABLE IF NOT EXISTS property_key_partner_returns (
  loan_id TEXT PRIMARY KEY REFERENCES property_key_partner_loans (id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('rendu', 'perdu')),
  recorded_by TEXT NOT NULL,
  returned_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS property_key_partner_returns_fige BEFORE UPDATE ON property_key_partner_returns BEGIN SELECT RAISE(ABORT, 'property_key_partner_returns : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS property_key_partner_returns_garde BEFORE DELETE ON property_key_partner_returns BEGIN SELECT RAISE(ABORT, 'property_key_partner_returns : rien ne s''efface'); END;

-- Seuls ces métiers entrent seuls chez un vendeur [R665].
CREATE TRIGGER IF NOT EXISTS property_key_partner_loans_metier
BEFORE INSERT ON property_key_partner_loans
WHEN NOT EXISTS (SELECT 1 FROM partners p WHERE p.id = NEW.partner_id AND p.network_id = NEW.network_id AND p.trade IN ('diagnostiqueur', 'photographe', 'artisan', 'geometre'))
BEGIN
  SELECT RAISE(ABORT, 'property_key_partner_loans : métier non admis');
END;
-- Un trousseau n'est jamais chez deux personnes à la fois, agent ou partenaire : une remise n'entre que s'il est dans
-- l'armoire [R271].
CREATE TRIGGER IF NOT EXISTS property_key_partner_loans_un_seul
BEFORE INSERT ON property_key_partner_loans
WHEN EXISTS (SELECT 1 FROM property_key_loans l WHERE l.key_id = NEW.key_id AND NOT EXISTS (SELECT 1 FROM property_key_returns r WHERE r.loan_id = l.id))
  OR EXISTS (SELECT 1 FROM property_key_partner_loans l WHERE l.key_id = NEW.key_id AND NOT EXISTS (SELECT 1 FROM property_key_partner_returns r WHERE r.loan_id = l.id))
  OR EXISTS (SELECT 1 FROM property_key_retirements t WHERE t.key_id = NEW.key_id)
BEGIN
  SELECT RAISE(ABORT, 'property_key_partner_loans : trousseau déjà sorti ou retiré');
END;
CREATE TRIGGER IF NOT EXISTS property_key_partner_loans_fige BEFORE UPDATE ON property_key_partner_loans BEGIN SELECT RAISE(ABORT, 'property_key_partner_loans : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS property_key_partner_loans_garde BEFORE DELETE ON property_key_partner_loans BEGIN SELECT RAISE(ABORT, 'property_key_partner_loans : rien ne s''efface'); END;

-- L'autre côté : une sortie à un agent n'entre pas tant qu'un partenaire a le trousseau [R271].
CREATE TRIGGER IF NOT EXISTS property_key_loans_chez_partenaire
BEFORE INSERT ON property_key_loans
WHEN EXISTS (SELECT 1 FROM property_key_partner_loans l WHERE l.key_id = NEW.key_id AND NOT EXISTS (SELECT 1 FROM property_key_partner_returns r WHERE r.loan_id = l.id))
BEGIN
  SELECT RAISE(ABORT, 'property_key_loans : trousseau chez un partenaire');
END;
-- Rendu au propriétaire seulement depuis l'armoire : un trousseau chez un partenaire revient d'abord, ou il est perdu.
CREATE TRIGGER IF NOT EXISTS property_key_retirements_chez_partenaire
BEFORE INSERT ON property_key_retirements
WHEN NEW.reason = 'rendu_au_proprietaire'
  AND EXISTS (SELECT 1 FROM property_key_partner_loans l WHERE l.key_id = NEW.key_id AND NOT EXISTS (SELECT 1 FROM property_key_partner_returns r WHERE r.loan_id = l.id))
BEGIN
  SELECT RAISE(ABORT, 'property_key_retirements : trousseau chez un partenaire');
END;
