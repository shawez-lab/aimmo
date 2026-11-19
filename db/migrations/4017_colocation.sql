-- AU097 · La colocation : un seul bail, plusieurs locataires, chacun une personne avec ses pièces, sa signature et son
-- exemplaire. Tout se range à côté des tables du bail, sans rien refaire ni effacer [R17].

-- Les colocataires d'une candidature, en plus du candidat : ajoutés ou retirés par l'agent, en versions ; la dernière
-- ligne d'une personne dit si elle est colocataire.
CREATE TABLE IF NOT EXISTS rental_cotenant_changes (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  application_id TEXT NOT NULL REFERENCES rental_applications (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES persons (id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  action TEXT NOT NULL CHECK (action IN ('ajout', 'retrait')),
  changed_by TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  UNIQUE (application_id, seq)
);
CREATE INDEX IF NOT EXISTS rental_cotenant_changes_person ON rental_cotenant_changes (application_id, person_id, seq);
CREATE TRIGGER IF NOT EXISTS rental_cotenant_changes_garde BEFORE DELETE ON rental_cotenant_changes BEGIN SELECT RAISE(ABORT, 'rental_cotenant_changes : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_cotenant_changes_fige BEFORE UPDATE ON rental_cotenant_changes BEGIN SELECT RAISE(ABORT, 'rental_cotenant_changes : rien ne se réécrit'); END;

-- Les colocataires nommés dans une version du bail, dans leur ordre : le bail ne vaut plus si la liste change.
CREATE TABLE IF NOT EXISTS rental_lease_cotenants (
  lease_id TEXT NOT NULL REFERENCES rental_leases (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES persons (id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 1),
  PRIMARY KEY (lease_id, person_id),
  UNIQUE (lease_id, position)
);
CREATE TRIGGER IF NOT EXISTS rental_lease_cotenants_garde BEFORE DELETE ON rental_lease_cotenants BEGIN SELECT RAISE(ABORT, 'rental_lease_cotenants : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_lease_cotenants_fige BEFORE UPDATE ON rental_lease_cotenants BEGIN SELECT RAISE(ABORT, 'rental_lease_cotenants : rien ne se réécrit'); END;

-- La version de la liste des colocataires sur laquelle chaque bail est fait : la liste changée depuis, même revenue à
-- l'identique, le bail ne vaut plus.
CREATE TABLE IF NOT EXISTS rental_lease_cotenant_revisions (
  lease_id TEXT PRIMARY KEY REFERENCES rental_leases (id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision >= 0)
);
CREATE TRIGGER IF NOT EXISTS rental_lease_cotenant_revisions_garde BEFORE DELETE ON rental_lease_cotenant_revisions BEGIN SELECT RAISE(ABORT, 'rental_lease_cotenant_revisions : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_lease_cotenant_revisions_fige BEFORE UPDATE ON rental_lease_cotenant_revisions BEGIN SELECT RAISE(ABORT, 'rental_lease_cotenant_revisions : rien ne se réécrit'); END;

-- La signature de chaque colocataire, comme celle des deux parties : une seule par personne et par bail.
CREATE TABLE IF NOT EXISTS rental_lease_cotenant_signatures (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  listing_id TEXT NOT NULL REFERENCES rental_listings (id) ON DELETE RESTRICT,
  lease_id TEXT NOT NULL REFERENCES rental_leases (id) ON DELETE RESTRICT,
  party TEXT NOT NULL CHECK (party = 'colocataire'),
  person_id TEXT NOT NULL REFERENCES persons (id) ON DELETE RESTRICT,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  code_hash TEXT NOT NULL CHECK (length(code_hash) = 64),
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  status TEXT NOT NULL CHECK (status IN ('ouverte', 'signee', 'bloquee')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  signed_at TEXT,
  drawing_hash TEXT CHECK (drawing_hash IS NULL OR length(drawing_hash) = 64),
  -- Le dossier de preuve, en JSON écrit par le code, sans donnée personnelle ; toujours une signature d'essai.
  proof TEXT CHECK (proof IS NULL OR length(proof) BETWEEN 2 AND 4000),
  CHECK ((status = 'signee') = (signed_at IS NOT NULL AND proof IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS rental_lease_cotenant_signatures_lease ON rental_lease_cotenant_signatures (lease_id, person_id);
CREATE UNIQUE INDEX IF NOT EXISTS rental_lease_cotenant_signatures_une ON rental_lease_cotenant_signatures (lease_id, person_id) WHERE status = 'signee';
CREATE TRIGGER IF NOT EXISTS rental_lease_cotenant_signatures_garde BEFORE DELETE ON rental_lease_cotenant_signatures BEGIN SELECT RAISE(ABORT, 'rental_lease_cotenant_signatures : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_lease_cotenant_signatures_fige BEFORE UPDATE ON rental_lease_cotenant_signatures
WHEN OLD.status <> 'ouverte'
  OR NEW.id IS NOT OLD.id OR NEW.network_id IS NOT OLD.network_id OR NEW.listing_id IS NOT OLD.listing_id OR NEW.lease_id IS NOT OLD.lease_id
  OR NEW.party IS NOT OLD.party OR NEW.person_id IS NOT OLD.person_id OR NEW.content_sha256 IS NOT OLD.content_sha256
  OR NEW.code_hash IS NOT OLD.code_hash OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'rental_lease_cotenant_signatures : une session signée ne change plus'); END;

-- La remise de l'exemplaire à chaque colocataire : le même exemplaire que pour les deux parties.
CREATE TABLE IF NOT EXISTS rental_lease_cotenant_copy_deliveries (
  lease_id TEXT NOT NULL REFERENCES rental_lease_copies (lease_id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES persons (id) ON DELETE RESTRICT,
  copy_sha256 TEXT NOT NULL CHECK (length(copy_sha256) = 64),
  sent_at TEXT NOT NULL,
  PRIMARY KEY (lease_id, person_id)
);
CREATE TRIGGER IF NOT EXISTS rental_lease_cotenant_copy_deliveries_garde BEFORE DELETE ON rental_lease_cotenant_copy_deliveries BEGIN SELECT RAISE(ABORT, 'rental_lease_cotenant_copy_deliveries : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_lease_cotenant_copy_deliveries_fige BEFORE UPDATE ON rental_lease_cotenant_copy_deliveries BEGIN SELECT RAISE(ABORT, 'rental_lease_cotenant_copy_deliveries : une remise ne change plus'); END;
