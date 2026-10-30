-- U12 · Relances et prospection de M18 par le contrôle central des envois [R01, R03, R04, R05, R06, R11, R13, R17, R79].
-- Un partenaire et un futur partenaire ne sont pas des personnes de la fiche client : leurs envois ont leurs propres
-- tables, sans jamais créer de fiche.

-- L'adresse professionnelle d'un partenaire de l'annuaire, avec l'accord qu'il a donné de recevoir par mail le suivi
-- des demandes qui lui sont confiées (date et preuve) [R03]. Une nouvelle version s'ajoute, rien ne change [R17].
CREATE TABLE IF NOT EXISTS partner_addresses (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL,
  partner_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  email TEXT NOT NULL CHECK (length(email) BETWEEN 6 AND 254 AND email = lower(email)),
  -- La preuve de l'accord : une note de la direction (« accord écrit dans le contrat du 12 mars »), jamais un fichier.
  consent_proof TEXT NOT NULL CHECK (length(trim(consent_proof)) BETWEEN 3 AND 500),
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (partner_id, version),
  FOREIGN KEY (partner_id, network_id) REFERENCES partners (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS partner_addresses_garde BEFORE DELETE ON partner_addresses BEGIN SELECT RAISE(ABORT, 'partner_addresses : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS partner_addresses_fige BEFORE UPDATE ON partner_addresses BEGIN SELECT RAISE(ABORT, 'partner_addresses : une adresse rangée ne change plus'); END;

-- L'opposition d'un partenaire de l'annuaire, rangée par la direction, même sans aucune adresse rangée : plus rien ne
-- lui part, sur aucun canal, pour toujours [R04, R02].
CREATE TABLE IF NOT EXISTS partner_optouts (
  network_id TEXT NOT NULL,
  partner_id TEXT NOT NULL,
  via TEXT NOT NULL CHECK (via IN ('agent')),
  at TEXT NOT NULL,
  PRIMARY KEY (network_id, partner_id),
  FOREIGN KEY (partner_id, network_id) REFERENCES partners (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS partner_optouts_garde BEFORE DELETE ON partner_optouts BEGIN SELECT RAISE(ABORT, 'partner_optouts : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS partner_optouts_fige BEFORE UPDATE ON partner_optouts BEGIN SELECT RAISE(ABORT, 'partner_optouts : une opposition ne change plus'); END;

-- Chaque envoi parti à un professionnel, une seule fois par sujet [R05]. Après une panne du canal, le sujet est
-- libéré (renommé), jamais effacé : un nouvel essai reste possible.
CREATE TABLE IF NOT EXISTS pro_sends (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  subject TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('partner', 'prospecting')),
  -- `partner:<id>` ou `prospect:<id>` : jamais l'adresse.
  recipient TEXT NOT NULL,
  -- Le jour, à Paris, qui compte dans le plafond [R11, R79].
  day TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  UNIQUE (network_id, subject)
);
CREATE INDEX IF NOT EXISTS pro_sends_day ON pro_sends (network_id, kind, day);
CREATE TRIGGER IF NOT EXISTS pro_sends_garde BEFORE DELETE ON pro_sends BEGIN SELECT RAISE(ABORT, 'pro_sends : rien ne s''efface'); END;
-- Seule la libération après une panne renomme le sujet ; rien d'autre ne change.
CREATE TRIGGER IF NOT EXISTS pro_sends_fige BEFORE UPDATE ON pro_sends
WHEN NEW.id <> OLD.id OR NEW.network_id <> OLD.network_id OR NEW.kind <> OLD.kind OR NEW.recipient <> OLD.recipient OR NEW.day <> OLD.day OR NEW.sent_at <> OLD.sent_at
  OR NEW.subject NOT LIKE OLD.subject || '#panne:%'
BEGIN SELECT RAISE(ABORT, 'pro_sends : un envoi rangé ne change plus'); END;

-- Le journal de chaque décision : parti, refusé pour de bon, en attente (heure, plafond, adresse) ou en panne.
-- Ni adresse ni texte [R13].
CREATE TABLE IF NOT EXISTS pro_send_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  subject TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('partner', 'prospecting')),
  outcome TEXT NOT NULL CHECK (outcome IN ('sent', 'refused', 'waiting', 'failed')),
  rule TEXT,
  reason TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode = 'essai'),
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pro_send_log_subject ON pro_send_log (network_id, subject, id);
CREATE TRIGGER IF NOT EXISTS pro_send_log_garde BEFORE DELETE ON pro_send_log BEGIN SELECT RAISE(ABORT, 'pro_send_log : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS pro_send_log_fige BEFORE UPDATE ON pro_send_log BEGIN SELECT RAISE(ABORT, 'pro_send_log : une décision rangée ne change plus'); END;

-- La boîte d'essai des envois aux professionnels : ce qui aurait pu partir, rangé, jamais envoyé.
CREATE TABLE IF NOT EXISTS pro_trial_outbox (
  send_id TEXT PRIMARY KEY REFERENCES pro_sends (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS pro_trial_outbox_garde BEFORE DELETE ON pro_trial_outbox BEGIN SELECT RAISE(ABORT, 'pro_trial_outbox : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS pro_trial_outbox_fige BEFORE UPDATE ON pro_trial_outbox BEGIN SELECT RAISE(ABORT, 'pro_trial_outbox : rien ne change'); END;
