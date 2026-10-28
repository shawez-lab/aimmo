-- W07 · État des lieux d'entrée dans l'application (M15) [R106, R17].
-- Le numéro 0904 prévu au plan était déjà pris par les candidatures : l'état des lieux prend 0907.
-- Chaque version est figée ; une correction est une nouvelle version, permise tant que l'état des lieux n'est pas clos.
-- Les signatures portent l'empreinte de la version signée ; seule l'empreinte du tracé est gardée.
CREATE TABLE IF NOT EXISTS rental_inventories (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES rental_listings (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  lease_id TEXT NOT NULL REFERENCES rental_leases (id) ON DELETE RESTRICT,
  lease_sha256 TEXT NOT NULL CHECK (length(lease_sha256) = 64),
  mode TEXT NOT NULL CHECK (mode IN ('essai', 'reel')),
  status TEXT NOT NULL CHECK (status IN ('complet', 'incomplet')),
  missing TEXT NOT NULL CHECK (json_valid(missing)),
  rooms TEXT NOT NULL CHECK (json_valid(rooms)),
  meters TEXT NOT NULL CHECK (json_valid(meters)),
  keys_given TEXT NOT NULL CHECK (json_valid(keys_given)),
  furniture TEXT NOT NULL CHECK (json_valid(furniture)),
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (listing_id, version)
);
CREATE TRIGGER IF NOT EXISTS rental_inventories_garde BEFORE DELETE ON rental_inventories BEGIN SELECT RAISE(ABORT, 'rental_inventories : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_inventories_fige BEFORE UPDATE ON rental_inventories BEGIN SELECT RAISE(ABORT, 'rental_inventories : un état des lieux rangé ne change plus'); END;

CREATE TABLE IF NOT EXISTS rental_inventory_signatures (
  id TEXT PRIMARY KEY,
  inventory_id TEXT NOT NULL REFERENCES rental_inventories (id) ON DELETE RESTRICT,
  party TEXT NOT NULL CHECK (party IN ('bailleur', 'locataire')),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  drawing_sha256 TEXT NOT NULL CHECK (length(drawing_sha256) = 64),
  signed_by TEXT NOT NULL,
  signed_at TEXT NOT NULL,
  UNIQUE (inventory_id, party)
);
CREATE TRIGGER IF NOT EXISTS rental_inventory_signatures_garde BEFORE DELETE ON rental_inventory_signatures BEGIN SELECT RAISE(ABORT, 'rental_inventory_signatures : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_inventory_signatures_fige BEFORE UPDATE ON rental_inventory_signatures BEGIN SELECT RAISE(ABORT, 'rental_inventory_signatures : une signature ne change plus'); END;

-- Un exemplaire par partie, préparé à la clôture, de même empreinte ; son envoi passe par le contrôle central (W10).
CREATE TABLE IF NOT EXISTS rental_inventory_copies (
  id TEXT PRIMARY KEY,
  inventory_id TEXT NOT NULL REFERENCES rental_inventories (id) ON DELETE RESTRICT,
  party TEXT NOT NULL CHECK (party IN ('bailleur', 'locataire')),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  prepared_at TEXT NOT NULL,
  UNIQUE (inventory_id, party)
);
CREATE TRIGGER IF NOT EXISTS rental_inventory_copies_garde BEFORE DELETE ON rental_inventory_copies BEGIN SELECT RAISE(ABORT, 'rental_inventory_copies : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_inventory_copies_fige BEFORE UPDATE ON rental_inventory_copies BEGIN SELECT RAISE(ABORT, 'rental_inventory_copies : un exemplaire ne change plus'); END;
