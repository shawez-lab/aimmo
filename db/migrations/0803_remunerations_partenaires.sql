-- U03 · Rémunérations des partenaires, déclarées ou refusées (M18) [R76, R17].
-- Toute rémunération venant d'un partenaire est déclarée dans sa mise en relation, avant l'accord du client ;
-- elle ne change plus et ne s'efface pas.
CREATE TABLE IF NOT EXISTS partner_referral_fees (
  id TEXT PRIMARY KEY,
  referral_id TEXT NOT NULL REFERENCES partner_referrals (id) ON DELETE RESTRICT,
  partner_id TEXT NOT NULL REFERENCES partners (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('commission', 'remise', 'cadeau', 'prestation', 'autre')),
  amount_cents INTEGER CHECK (amount_cents IS NULL OR amount_cents > 0),
  rate_bp INTEGER CHECK (rate_bp IS NULL OR rate_bp BETWEEN 1 AND 10000),
  payer TEXT NOT NULL CHECK (payer IN ('partenaire', 'banque')),
  payee TEXT NOT NULL CHECK (payee IN ('reseau', 'agent')),
  declared_by TEXT NOT NULL,
  declared_at TEXT NOT NULL,
  CHECK ((amount_cents IS NULL) <> (rate_bp IS NULL))
);
CREATE INDEX IF NOT EXISTS partner_referral_fees_referral ON partner_referral_fees (referral_id, partner_id);
CREATE TRIGGER IF NOT EXISTS partner_referral_fees_garde BEFORE DELETE ON partner_referral_fees BEGIN SELECT RAISE(ABORT, 'partner_referral_fees : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS partner_referral_fees_fige BEFORE UPDATE ON partner_referral_fees BEGIN SELECT RAISE(ABORT, 'partner_referral_fees : une rémunération déclarée ne change plus'); END;

-- Chaque fois que le texte des rémunérations est montré au client, avec son empreinte : la preuve qu'il l'a vu avant son accord.
CREATE TABLE IF NOT EXISTS partner_referral_disclosures (
  id TEXT PRIMARY KEY,
  referral_id TEXT NOT NULL REFERENCES partner_referrals (id) ON DELETE RESTRICT,
  text_sha256 TEXT NOT NULL CHECK (length(text_sha256) = 64),
  fees_count INTEGER NOT NULL CHECK (fees_count >= 0),
  shown_by TEXT NOT NULL,
  shown_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS partner_referral_disclosures_referral ON partner_referral_disclosures (referral_id, shown_at);
CREATE TRIGGER IF NOT EXISTS partner_referral_disclosures_garde BEFORE DELETE ON partner_referral_disclosures BEGIN SELECT RAISE(ABORT, 'partner_referral_disclosures : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS partner_referral_disclosures_fige BEFORE UPDATE ON partner_referral_disclosures BEGIN SELECT RAISE(ABORT, 'partner_referral_disclosures : un texte montré ne change plus'); END;

-- La base garde elle-même les deux invariants, d'un seul coup, même si deux demandes se croisent [R76] :
-- aucune rémunération ne s'ajoute une fois une étape rangée (accord du client ou suite) ;
CREATE TRIGGER IF NOT EXISTS partner_referral_fees_avant_accord BEFORE INSERT ON partner_referral_fees
WHEN EXISTS (SELECT 1 FROM partner_referral_steps WHERE referral_id = NEW.referral_id)
BEGIN SELECT RAISE(ABORT, 'partner_referral_fees : accord du client déjà rangé'); END;
-- aucun accord n'est rangé sans un texte montré, au plus tard à la date de l'accord, qui cite toutes les rémunérations.
CREATE TRIGGER IF NOT EXISTS partner_referral_steps_remunerations_montrees BEFORE INSERT ON partner_referral_steps
WHEN NEW.state = 'accord_client'
  AND EXISTS (SELECT 1 FROM partner_referral_fees WHERE referral_id = NEW.referral_id)
  AND NOT EXISTS (
    SELECT 1 FROM partner_referral_disclosures d
    WHERE d.referral_id = NEW.referral_id AND d.shown_at <= NEW.consent_at
      AND d.fees_count = (SELECT COUNT(*) FROM partner_referral_fees f WHERE f.referral_id = NEW.referral_id)
  )
BEGIN SELECT RAISE(ABORT, 'partner_referral_steps : rémunérations non montrées avant l''accord'); END;
