-- U01 · Annuaire des partenaires par zone, justificatifs datés (M18) [R73, R14, R17].
-- Un partenaire est un professionnel, dans ses propres tables : jamais une fiche client.
-- Son métier vient d'une liste fermée ; il ne porte ni note, ni rang, ni avis [R14, R75].
CREATE TABLE IF NOT EXISTS partners (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  trade TEXT NOT NULL CHECK (trade IN ('notaire', 'diagnostiqueur', 'courtier', 'artisan', 'demenageur', 'photographe', 'geometre', 'gestionnaire', 'avocat', 'expert_comptable', 'promoteur', 'expert_viager')),
  business_name TEXT NOT NULL CHECK (length(business_name) BETWEEN 2 AND 120),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (id, network_id)
);
CREATE INDEX IF NOT EXISTS partners_trade ON partners (network_id, trade, id);
CREATE TRIGGER IF NOT EXISTS partners_garde BEFORE DELETE ON partners BEGIN SELECT RAISE(ABORT, 'partners : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS partners_fige BEFORE UPDATE ON partners BEGIN SELECT RAISE(ABORT, 'partners : un partenaire rangé ne change plus'); END;

-- Les zones où il intervient, par code postal ; une zone ajoutée reste.
CREATE TABLE IF NOT EXISTS partner_zones (
  partner_id TEXT NOT NULL REFERENCES partners (id) ON DELETE RESTRICT,
  postcode TEXT NOT NULL CHECK (length(postcode) = 5 AND postcode NOT GLOB '*[^0-9]*'),
  network_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (partner_id, postcode)
);
CREATE INDEX IF NOT EXISTS partner_zones_postcode ON partner_zones (network_id, postcode);
CREATE TRIGGER IF NOT EXISTS partner_zones_garde BEFORE DELETE ON partner_zones BEGIN SELECT RAISE(ABORT, 'partner_zones : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS partner_zones_fige BEFORE UPDATE ON partner_zones BEGIN SELECT RAISE(ABORT, 'partner_zones : une zone ne change plus'); END;

-- Les justificatifs : une référence de stockage de la preuve, jamais son contenu ; une période de validité ;
-- qui l'a vérifié. Un justificatif rangé ne change plus : une nouvelle version s'ajoute [R17].
-- `domain` n'existe que pour une certification de diagnostiqueur, '' sinon.
CREATE TABLE IF NOT EXISTS partner_credentials (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL,
  partner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('assurance_rcp', 'certification_diagnostic', 'immatriculation_orias', 'carte_g', 'inscription_ordre')),
  domain TEXT NOT NULL CHECK (domain IN ('', 'amiante', 'plomb', 'dpe', 'electricite', 'gaz', 'termites')),
  version INTEGER NOT NULL CHECK (version >= 1),
  number TEXT NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  valid_from TEXT NOT NULL,
  valid_until TEXT NOT NULL CHECK (valid_until >= valid_from),
  proof_ref TEXT NOT NULL UNIQUE,
  verified_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (partner_id, kind, domain, version),
  CHECK ((kind = 'certification_diagnostic') = (domain <> '')),
  FOREIGN KEY (partner_id, network_id) REFERENCES partners (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS partner_credentials_partner ON partner_credentials (partner_id, kind, domain, version);
CREATE INDEX IF NOT EXISTS partner_credentials_until ON partner_credentials (network_id, valid_until);
CREATE TRIGGER IF NOT EXISTS partner_credentials_garde BEFORE DELETE ON partner_credentials BEGIN SELECT RAISE(ABORT, 'partner_credentials : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS partner_credentials_fige BEFORE UPDATE ON partner_credentials BEGIN SELECT RAISE(ABORT, 'partner_credentials : un justificatif rangé ne change plus'); END;

-- Une alerte d'échéance par justificatif : rendue une fois au planificateur, 30 jours avant.
CREATE TABLE IF NOT EXISTS partner_credential_alerts (
  credential_id TEXT NOT NULL REFERENCES partner_credentials (id) ON DELETE RESTRICT,
  alert TEXT NOT NULL CHECK (alert IN ('j30')),
  network_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (credential_id, alert)
);
CREATE TRIGGER IF NOT EXISTS partner_credential_alerts_garde BEFORE DELETE ON partner_credential_alerts BEGIN SELECT RAISE(ABORT, 'partner_credential_alerts : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS partner_credential_alerts_fige BEFORE UPDATE ON partner_credential_alerts BEGIN SELECT RAISE(ABORT, 'partner_credential_alerts : une alerte ne change plus'); END;
