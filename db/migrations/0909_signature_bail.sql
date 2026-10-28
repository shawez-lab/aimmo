-- W12 · Signature en ligne du bail par D08, en mode essai (M15) [R108, R101, R105, R17].
-- Chaque partie (bailleur, locataire choisi) signe l'empreinte du bail en vigueur, par un code à usage unique dont seule
-- l'empreinte est gardée. Une signature d'essai ne rend jamais un bail signé réel tant que H08 et H24 ne sont pas faits.
CREATE TABLE IF NOT EXISTS rental_lease_signatures (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  listing_id TEXT NOT NULL REFERENCES rental_listings (id) ON DELETE RESTRICT,
  lease_id TEXT NOT NULL REFERENCES rental_leases (id) ON DELETE RESTRICT,
  party TEXT NOT NULL CHECK (party IN ('bailleur', 'locataire')),
  person_id TEXT NOT NULL REFERENCES persons (id) ON DELETE RESTRICT,
  -- L'empreinte du bail à l'ouverture : c'est elle que la partie signe.
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  code_hash TEXT NOT NULL CHECK (length(code_hash) = 64),
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  status TEXT NOT NULL CHECK (status IN ('ouverte', 'signee', 'bloquee')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  signed_at TEXT,
  -- Empreinte de la signature tracée à l'écran, jamais le tracé.
  drawing_hash TEXT CHECK (drawing_hash IS NULL OR length(drawing_hash) = 64),
  -- Le dossier de preuve, en JSON, sans donnée personnelle ; toujours une signature d'essai.
  proof TEXT CHECK (proof IS NULL OR json_valid(proof)),
  CHECK ((status = 'signee') = (signed_at IS NOT NULL AND proof IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS rental_lease_signatures_lease ON rental_lease_signatures (lease_id, party);
-- Une seule signature par partie et par bail, même avec deux sessions signées en même temps.
CREATE UNIQUE INDEX IF NOT EXISTS rental_lease_signatures_une ON rental_lease_signatures (lease_id, party) WHERE status = 'signee';
CREATE TRIGGER IF NOT EXISTS rental_lease_signatures_garde BEFORE DELETE ON rental_lease_signatures BEGIN SELECT RAISE(ABORT, 'rental_lease_signatures : rien ne s''efface'); END;
-- Une session signée ou bloquée ne change plus ; ce qu'elle a ouvert (bail, partie, empreinte, code) ne change jamais.
CREATE TRIGGER IF NOT EXISTS rental_lease_signatures_fige BEFORE UPDATE ON rental_lease_signatures
WHEN OLD.status <> 'ouverte'
  OR NEW.id IS NOT OLD.id OR NEW.network_id IS NOT OLD.network_id OR NEW.listing_id IS NOT OLD.listing_id OR NEW.lease_id IS NOT OLD.lease_id
  OR NEW.party IS NOT OLD.party OR NEW.person_id IS NOT OLD.person_id OR NEW.content_sha256 IS NOT OLD.content_sha256
  OR NEW.code_hash IS NOT OLD.code_hash OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'rental_lease_signatures : une signature rangée ne change plus'); END;

-- L'exemplaire du bail signé par les deux parties : un seul, de même empreinte pour chacune.
CREATE TABLE IF NOT EXISTS rental_lease_copies (
  lease_id TEXT PRIMARY KEY REFERENCES rental_leases (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL,
  listing_id TEXT NOT NULL REFERENCES rental_listings (id) ON DELETE RESTRICT,
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS rental_lease_copies_garde BEFORE DELETE ON rental_lease_copies BEGIN SELECT RAISE(ABORT, 'rental_lease_copies : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_lease_copies_fige BEFORE UPDATE ON rental_lease_copies BEGIN SELECT RAISE(ABORT, 'rental_lease_copies : un exemplaire ne change plus'); END;

-- L'avis de l'exemplaire (référence et empreinte) remis à chaque partie par le contrôle central (en essai : boîte
-- d'essai), pour vérifier l'exemplaire que l'agent lui remet ; une ligne par partie.
CREATE TABLE IF NOT EXISTS rental_lease_copy_deliveries (
  lease_id TEXT NOT NULL REFERENCES rental_lease_copies (lease_id) ON DELETE RESTRICT,
  party TEXT NOT NULL CHECK (party IN ('bailleur', 'locataire')),
  copy_sha256 TEXT NOT NULL CHECK (length(copy_sha256) = 64),
  sent_at TEXT NOT NULL,
  PRIMARY KEY (lease_id, party)
);
CREATE TRIGGER IF NOT EXISTS rental_lease_copy_deliveries_garde BEFORE DELETE ON rental_lease_copy_deliveries BEGIN SELECT RAISE(ABORT, 'rental_lease_copy_deliveries : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_lease_copy_deliveries_fige BEFORE UPDATE ON rental_lease_copy_deliveries BEGIN SELECT RAISE(ABORT, 'rental_lease_copy_deliveries : une remise ne change plus'); END;
