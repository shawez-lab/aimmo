-- W03 · Annonce de location conforme (M15) [R100, R101, R102, R103, R06, R17].
-- Le texte vient de l'IA (derrière une interface), du secours fait par le code, ou de l'agent ; les mentions
-- obligatoires sont calculées par le code et rangées à part. Chaque version garde ce qu'elle a vu : faits, barème,
-- fiche du bien. Rien ne s'efface ; une correction est une nouvelle version [R17].
CREATE TABLE IF NOT EXISTS rental_ads (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES rental_listings (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  facts_version INTEGER NOT NULL,
  fees_version INTEGER NOT NULL,
  sheet_version INTEGER NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 3000),
  mentions TEXT NOT NULL CHECK (length(mentions) BETWEEN 1 AND 2000),
  origin TEXT NOT NULL CHECK (origin IN ('ia', 'secours', 'agent')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (listing_id, version),
  FOREIGN KEY (listing_id, facts_version) REFERENCES rental_facts (listing_id, version) ON DELETE RESTRICT,
  FOREIGN KEY (listing_id, fees_version) REFERENCES rental_fees (listing_id, version) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS rental_ads_garde BEFORE DELETE ON rental_ads BEGIN SELECT RAISE(ABORT, 'rental_ads : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_ads_fige BEFORE UPDATE ON rental_ads BEGIN SELECT RAISE(ABORT, 'rental_ads : une annonce rangée ne change plus'); END;

-- La validation de l'agent du logement : l'empreinte du texte exact validé (titre, corps, mentions).
CREATE TABLE IF NOT EXISTS rental_ad_validations (
  ad_id TEXT PRIMARY KEY REFERENCES rental_ads (id) ON DELETE RESTRICT,
  text_sha256 TEXT NOT NULL CHECK (length(text_sha256) = 64),
  validated_by TEXT NOT NULL,
  validated_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS rental_ad_validations_garde BEFORE DELETE ON rental_ad_validations BEGIN SELECT RAISE(ABORT, 'rental_ad_validations : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_ad_validations_fige BEFORE UPDATE ON rental_ad_validations BEGIN SELECT RAISE(ABORT, 'rental_ad_validations : une validation ne change plus'); END;
