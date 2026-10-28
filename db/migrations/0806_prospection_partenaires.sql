-- U08 · Prospection de nouveaux partenaires entre professionnels (M18) [R79, R03, R04, R05, R17].
-- Un futur partenaire est une adresse professionnelle trouvée dans une source publique, jamais une fiche client.
CREATE TABLE IF NOT EXISTS partner_prospects (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  -- L'adresse, en minuscules ; une seule fois par réseau [R05].
  email TEXT NOT NULL CHECK (length(email) BETWEEN 6 AND 254 AND email = lower(email)),
  -- Seulement une adresse déclarée professionnelle [R79].
  address_kind TEXT NOT NULL CHECK (address_kind = 'professionnelle'),
  trade TEXT NOT NULL,
  business_name TEXT NOT NULL CHECK (length(business_name) BETWEEN 2 AND 120),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 3 AND 300),
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  UNIQUE (network_id, email)
);
CREATE TRIGGER IF NOT EXISTS partner_prospects_garde BEFORE DELETE ON partner_prospects BEGIN SELECT RAISE(ABORT, 'partner_prospects : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS partner_prospects_fige BEFORE UPDATE ON partner_prospects BEGIN SELECT RAISE(ABORT, 'partner_prospects : une adresse rangée ne change plus'); END;

-- Le premier mail préparé, un seul par adresse, jamais deux fois [R05]. Rien ne part d'ici : le passage par le
-- contrôle central des envois, en mode essai, revient au branchement (U09).
CREATE TABLE IF NOT EXISTS partner_prospect_mails (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  prospect_id TEXT NOT NULL UNIQUE REFERENCES partner_prospects (id) ON DELETE RESTRICT,
  -- Le jour ouvré, à Paris, qui compte dans le plafond [R79].
  day TEXT NOT NULL,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 50 AND 1200),
  -- L'empreinte du jeton du lien d'opposition, jamais le jeton lui-même.
  optout_token_sha256 TEXT NOT NULL UNIQUE CHECK (length(optout_token_sha256) = 64),
  -- La décision du contrôle central au moment de la préparation : la règle qui refuse (R03 tant que H32 n'est pas
  -- tranché), ou rien si l'envoi était permis. Le branchement (U09) redécide au moment de l'envoi.
  decision_rule TEXT,
  decision_reason TEXT NOT NULL,
  prepared_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS partner_prospect_mails_day ON partner_prospect_mails (network_id, day);
CREATE TRIGGER IF NOT EXISTS partner_prospect_mails_garde BEFORE DELETE ON partner_prospect_mails BEGIN SELECT RAISE(ABORT, 'partner_prospect_mails : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS partner_prospect_mails_fige BEFORE UPDATE ON partner_prospect_mails BEGIN SELECT RAISE(ABORT, 'partner_prospect_mails : un mail préparé ne change plus'); END;
-- Le plafond du jour ouvré, tenu par la base même quand deux passages tournent ensemble [R79].
CREATE TRIGGER IF NOT EXISTS partner_prospect_mails_plafond BEFORE INSERT ON partner_prospect_mails
WHEN (SELECT COUNT(*) FROM partner_prospect_mails WHERE network_id = NEW.network_id AND day = NEW.day) >= 5
BEGIN SELECT RAISE(ABORT, 'partner_prospect_mails : plafond du jour atteint'); END;
-- Une adresse opposée ne reçoit plus rien, vérifié au moment même de l'écriture [R04].
CREATE TRIGGER IF NOT EXISTS partner_prospect_mails_opposition BEFORE INSERT ON partner_prospect_mails
WHEN EXISTS (SELECT 1 FROM partner_prospect_optouts o JOIN partner_prospects p ON p.email = o.email AND p.network_id = o.network_id WHERE p.id = NEW.prospect_id)
BEGIN SELECT RAISE(ABORT, 'partner_prospect_mails : adresse opposée'); END;

-- L'opposition, par adresse : elle arrête tout, sur tous les canaux, pour toujours [R04, R02].
CREATE TABLE IF NOT EXISTS partner_prospect_optouts (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  email TEXT NOT NULL CHECK (email = lower(email)),
  via TEXT NOT NULL CHECK (via IN ('lien', 'agent')),
  at TEXT NOT NULL,
  PRIMARY KEY (network_id, email)
);
CREATE TRIGGER IF NOT EXISTS partner_prospect_optouts_garde BEFORE DELETE ON partner_prospect_optouts BEGIN SELECT RAISE(ABORT, 'partner_prospect_optouts : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS partner_prospect_optouts_fige BEFORE UPDATE ON partner_prospect_optouts BEGIN SELECT RAISE(ABORT, 'partner_prospect_optouts : une opposition ne change plus'); END;
