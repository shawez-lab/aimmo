-- U07 · Suivi des demandes, relances et avis lus par un humain (M18) [R01, R05, R14, R17, R75, R79].
-- Une relance préparée au partenaire, puis une alerte à l'agent, au plus une de chaque par mise en relation [R05].
-- Rien ne part d'ici : la relance est rangée avec sa date due dans les heures d'envoi ; son passage par le contrôle
-- central des envois revient au branchement (U09).
CREATE TABLE IF NOT EXISTS partner_followups (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  referral_id TEXT NOT NULL REFERENCES partner_referrals (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('relance', 'alerte_agent')),
  -- À qui : le partenaire confié pour une relance, l'agent du projet pour une alerte.
  recipient TEXT NOT NULL,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 20 AND 600),
  due_at TEXT NOT NULL,
  prepared_at TEXT NOT NULL,
  UNIQUE (referral_id, kind)
);
CREATE INDEX IF NOT EXISTS partner_followups_network ON partner_followups (network_id, kind, due_at);
CREATE TRIGGER IF NOT EXISTS partner_followups_garde BEFORE DELETE ON partner_followups BEGIN SELECT RAISE(ABORT, 'partner_followups : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS partner_followups_fige BEFORE UPDATE ON partner_followups BEGIN SELECT RAISE(ABORT, 'partner_followups : une relance préparée ne change plus'); END;

-- L'avis du client sur le service rendu : un texte, jamais une note ni un rang [R14, R75].
CREATE TABLE IF NOT EXISTS partner_reviews (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  referral_id TEXT NOT NULL REFERENCES partner_referrals (id) ON DELETE RESTRICT,
  text TEXT NOT NULL CHECK (length(trim(text)) BETWEEN 1 AND 2000),
  channel TEXT NOT NULL CHECK (channel IN ('oral', 'ecrit', 'mail', 'sms', 'whatsapp')),
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS partner_reviews_referral ON partner_reviews (referral_id, recorded_at);
CREATE TRIGGER IF NOT EXISTS partner_reviews_garde BEFORE DELETE ON partner_reviews BEGIN SELECT RAISE(ABORT, 'partner_reviews : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS partner_reviews_fige BEFORE UPDATE ON partner_reviews BEGIN SELECT RAISE(ABORT, 'partner_reviews : un avis rangé ne change plus'); END;

-- Chaque lecture d'un avis par un humain nommé.
CREATE TABLE IF NOT EXISTS partner_review_reads (
  review_id TEXT NOT NULL REFERENCES partner_reviews (id) ON DELETE RESTRICT,
  reader TEXT NOT NULL,
  read_at TEXT NOT NULL,
  PRIMARY KEY (review_id, reader)
);
CREATE TRIGGER IF NOT EXISTS partner_review_reads_garde BEFORE DELETE ON partner_review_reads BEGIN SELECT RAISE(ABORT, 'partner_review_reads : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS partner_review_reads_fige BEFORE UPDATE ON partner_review_reads BEGIN SELECT RAISE(ABORT, 'partner_review_reads : une lecture ne change plus'); END;
