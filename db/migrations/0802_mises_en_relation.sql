-- U02 · Mise en relation avec l'accord du client, choix du client (M18) [R74, R75, R17].
-- Une mise en relation part d'un projet du client ; les partenaires montrés le sont dans un ordre tiré au sort,
-- rejouable par sa graine, jamais trié par une note ni un avis [R75].
CREATE TABLE IF NOT EXISTS partner_referrals (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL,
  property_id TEXT,
  trade TEXT NOT NULL,
  domain TEXT NOT NULL,
  postcode TEXT NOT NULL CHECK (length(postcode) = 5 AND postcode NOT GLOB '*[^0-9]*'),
  seed INTEGER NOT NULL CHECK (seed BETWEEN 0 AND 4294967295),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (id, network_id),
  FOREIGN KEY (project_id, network_id) REFERENCES projects (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS partner_referrals_project ON partner_referrals (network_id, project_id, created_at);
CREATE TRIGGER IF NOT EXISTS partner_referrals_garde BEFORE DELETE ON partner_referrals BEGIN SELECT RAISE(ABORT, 'partner_referrals : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS partner_referrals_fige BEFORE UPDATE ON partner_referrals BEGIN SELECT RAISE(ABORT, 'partner_referrals : une mise en relation rangée ne change plus'); END;

-- Les partenaires montrés au client, dans l'ordre du tirage.
CREATE TABLE IF NOT EXISTS partner_referral_options (
  referral_id TEXT NOT NULL REFERENCES partner_referrals (id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 1),
  partner_id TEXT NOT NULL REFERENCES partners (id) ON DELETE RESTRICT,
  PRIMARY KEY (referral_id, position),
  UNIQUE (referral_id, partner_id)
);
CREATE TRIGGER IF NOT EXISTS partner_referral_options_garde BEFORE DELETE ON partner_referral_options BEGIN SELECT RAISE(ABORT, 'partner_referral_options : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS partner_referral_options_fige BEFORE UPDATE ON partner_referral_options BEGIN SELECT RAISE(ABORT, 'partner_referral_options : un tirage ne change plus'); END;

-- Les étapes, à la suite : l'accord du client porte le partenaire qu'il a choisi, sa date, son canal et sa preuve [R74].
CREATE TABLE IF NOT EXISTS partner_referral_steps (
  referral_id TEXT NOT NULL REFERENCES partner_referrals (id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  state TEXT NOT NULL CHECK (state IN ('accord_client', 'confiee', 'en_cours', 'terminee', 'abandonnee')),
  partner_id TEXT REFERENCES partners (id) ON DELETE RESTRICT,
  consent_at TEXT,
  consent_channel TEXT CHECK (consent_channel IS NULL OR consent_channel IN ('oral', 'ecrit', 'mail', 'sms', 'whatsapp')),
  consent_proof_ref TEXT UNIQUE,
  actor TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (referral_id, seq),
  CHECK ((state = 'accord_client') = (partner_id IS NOT NULL AND consent_at IS NOT NULL AND consent_channel IS NOT NULL AND consent_proof_ref IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS partner_referral_steps_garde BEFORE DELETE ON partner_referral_steps BEGIN SELECT RAISE(ABORT, 'partner_referral_steps : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS partner_referral_steps_fige BEFORE UPDATE ON partner_referral_steps BEGIN SELECT RAISE(ABORT, 'partner_referral_steps : une étape ne change plus'); END;

-- Les étapes se suivent sans trou, et seulement dans l'ordre permis : une demande validée contre un état ancien
-- ne peut pas s'ajouter après une étape qu'elle n'a pas vue [R74, R77].
CREATE TRIGGER IF NOT EXISTS partner_referral_steps_ordre BEFORE INSERT ON partner_referral_steps
WHEN NEW.seq <> (SELECT COUNT(*) + 1 FROM partner_referral_steps WHERE referral_id = NEW.referral_id)
  OR NOT (
    (NEW.seq = 1 AND NEW.state IN ('accord_client', 'abandonnee'))
    OR EXISTS (
      SELECT 1 FROM partner_referral_steps p WHERE p.referral_id = NEW.referral_id AND p.seq = NEW.seq - 1 AND (
        (p.state = 'accord_client' AND NEW.state IN ('confiee', 'abandonnee'))
        OR (p.state = 'confiee' AND NEW.state IN ('en_cours', 'terminee', 'abandonnee'))
        OR (p.state = 'en_cours' AND NEW.state IN ('terminee', 'abandonnee'))
      )
    )
  )
BEGIN SELECT RAISE(ABORT, 'partner_referral_steps : étape hors ordre'); END;
