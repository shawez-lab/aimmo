-- HX08 · Remises négociées pour les agents du réseau. Tables nouvelles, en ajout seul : rien ne change ni ne s'efface
-- [R17]. Aucune donnée d'un client : le fournisseur est un professionnel, la remise un texte de la direction [R13].

-- Une remise négociée par la direction, avec sa source (devis, contrat, courrier du fournisseur) et sa date de fin
-- [R266]. Le moment du dossier où elle est proposée vient d'une liste fermée [R267]. Une remise d'un diagnostiqueur,
-- d'un déménageur ou d'un artisan ne profite jamais qu'au client, jamais à l'agent ni au réseau [R76, R267] ; courtiers,
-- banques et notaires n'y entrent pas.
CREATE TABLE IF NOT EXISTS network_discounts (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  category TEXT NOT NULL CHECK (category IN ('photographe', 'diagnostiqueur', 'home_staging', 'demenageur', 'artisan', 'assurance', 'outil', 'formation', 'materiel')),
  supplier TEXT NOT NULL CHECK (length(trim(supplier)) BETWEEN 2 AND 80),
  partner_id TEXT,
  beneficiary TEXT NOT NULL CHECK (beneficiary IN ('agent', 'client')),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 2 AND 120),
  terms TEXT NOT NULL CHECK (length(trim(terms)) BETWEEN 2 AND 600),
  source TEXT NOT NULL CHECK (length(trim(source)) BETWEEN 2 AND 200),
  moment TEXT NOT NULL CHECK (moment IN ('estimation', 'mandat', 'en_vente', 'compromis', 'acte', 'toujours')),
  valid_from TEXT NOT NULL CHECK (valid_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  valid_until TEXT NOT NULL CHECK (valid_until GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  CHECK (valid_until >= valid_from),
  CHECK (category NOT IN ('diagnostiqueur', 'demenageur', 'artisan') OR beneficiary = 'client'),
  CHECK (category <> 'diagnostiqueur' OR partner_id IS NOT NULL),
  CHECK (beneficiary = 'agent' OR moment <> 'toujours'),
  FOREIGN KEY (partner_id, network_id) REFERENCES partners (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS network_discounts_moment ON network_discounts (network_id, moment, valid_until);
CREATE TRIGGER IF NOT EXISTS network_discounts_fige BEFORE UPDATE ON network_discounts BEGIN SELECT RAISE(ABORT, 'network_discounts : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS network_discounts_garde BEFORE DELETE ON network_discounts BEGIN SELECT RAISE(ABORT, 'network_discounts : rien ne s''efface'); END;

-- Le retrait d'une remise par la direction, avant sa date de fin : une fois, avec sa raison. Une remise échue n'a pas
-- besoin de retrait : elle n'est plus montrée dès le lendemain de sa date de fin [R266].
CREATE TABLE IF NOT EXISTS network_discount_withdrawals (
  discount_id TEXT PRIMARY KEY REFERENCES network_discounts (id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 2 AND 200),
  withdrawn_by TEXT NOT NULL,
  withdrawn_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS network_discount_withdrawals_fige BEFORE UPDATE ON network_discount_withdrawals BEGIN SELECT RAISE(ABORT, 'network_discount_withdrawals : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS network_discount_withdrawals_garde BEFORE DELETE ON network_discount_withdrawals BEGIN SELECT RAISE(ABORT, 'network_discount_withdrawals : rien ne s''efface'); END;

-- L'agent écarte une remise pour un bien : elle n'y revient plus [R267].
CREATE TABLE IF NOT EXISTS network_discount_dismissals (
  discount_id TEXT NOT NULL REFERENCES network_discounts (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL REFERENCES properties (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  dismissed_at TEXT NOT NULL,
  PRIMARY KEY (discount_id, property_id, agent_id),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS network_discount_dismissals_fige BEFORE UPDATE ON network_discount_dismissals BEGIN SELECT RAISE(ABORT, 'network_discount_dismissals : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS network_discount_dismissals_garde BEFORE DELETE ON network_discount_dismissals BEGIN SELECT RAISE(ABORT, 'network_discount_dismissals : rien ne s''efface'); END;
