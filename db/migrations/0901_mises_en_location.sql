-- W01 · Mise en location et contrôle du logement avant toute annonce (M15) [R100, R101, R17].
-- AIMMO met en location, jamais en gestion : aucune table de M15 ne porte un loyer encaissé ni un dépôt reçu [R107].
-- Le logement est un bien de la fiche (`properties`), son propriétaire une personne de la fiche client.
CREATE TABLE IF NOT EXISTS rental_listings (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  owner_person_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (id, network_id),
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS rental_listings_property ON rental_listings (network_id, property_id);
CREATE TRIGGER IF NOT EXISTS rental_listings_garde BEFORE DELETE ON rental_listings BEGIN SELECT RAISE(ABORT, 'rental_listings : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_listings_fige BEFORE UPDATE ON rental_listings BEGIN SELECT RAISE(ABORT, 'rental_listings : une mise en location rangée ne change plus'); END;

-- Les faits du logement, par version : une correction est une nouvelle version, la dernière compte [R17].
-- Montants en centimes ; surface habitable en centièmes de m² ; consommation en énergie finale, kWh/m²/an.
CREATE TABLE IF NOT EXISTS rental_facts (
  listing_id TEXT NOT NULL REFERENCES rental_listings (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  furnished INTEGER NOT NULL CHECK (furnished IN (0, 1)),
  rent_cents INTEGER NOT NULL CHECK (rent_cents > 0),
  charges_cents INTEGER NOT NULL CHECK (charges_cents >= 0),
  living_area_hundredths INTEGER NOT NULL CHECK (living_area_hundredths > 0),
  energy_class TEXT NOT NULL CHECK (energy_class IN ('A', 'B', 'C', 'D', 'E', 'F', 'G')),
  final_energy_kwh INTEGER NOT NULL CHECK (final_energy_kwh >= 0),
  build_year INTEGER NOT NULL CHECK (build_year BETWEEN 1000 AND 2100),
  electricity_over_15 INTEGER NOT NULL CHECK (electricity_over_15 IN (0, 1)),
  gas TEXT NOT NULL CHECK (gas IN ('aucune', 'moins_de_15_ans', 'plus_de_15_ans')),
  lease_start TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (listing_id, version)
);
CREATE TRIGGER IF NOT EXISTS rental_facts_garde BEFORE DELETE ON rental_facts BEGIN SELECT RAISE(ABORT, 'rental_facts : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_facts_fige BEFORE UPDATE ON rental_facts BEGIN SELECT RAISE(ABORT, 'rental_facts : une version rangée ne change plus'); END;

-- Les annexes du bail : une référence de stockage, jamais le contenu ; la date du diagnostic ; la fin de validité
-- calculée par le code. Une annexe remplacée reste [R17].
CREATE TABLE IF NOT EXISTS rental_annexes (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES rental_listings (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('dpe', 'erp', 'crep', 'electricite', 'gaz', 'surface_habitable')),
  version INTEGER NOT NULL CHECK (version >= 1),
  ref TEXT NOT NULL UNIQUE,
  diagnosed_on TEXT NOT NULL,
  valid_until TEXT,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (listing_id, kind, version)
);
CREATE TRIGGER IF NOT EXISTS rental_annexes_garde BEFORE DELETE ON rental_annexes BEGIN SELECT RAISE(ABORT, 'rental_annexes : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_annexes_fige BEFORE UPDATE ON rental_annexes BEGIN SELECT RAISE(ABORT, 'rental_annexes : une annexe rangée ne change plus'); END;

-- Chaque contrôle du logement, rangé avec ce qu'il a vu : version des faits, empreinte des annexes, raisons [R100, R101].
CREATE TABLE IF NOT EXISTS rental_checks (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES rental_listings (id) ON DELETE RESTRICT,
  facts_version INTEGER NOT NULL,
  annexes_key TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('louable', 'bloque')),
  reasons TEXT NOT NULL CHECK (json_valid(reasons)),
  checked_by TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  FOREIGN KEY (listing_id, facts_version) REFERENCES rental_facts (listing_id, version) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS rental_checks_latest ON rental_checks (listing_id, checked_at DESC);
CREATE TRIGGER IF NOT EXISTS rental_checks_garde BEFORE DELETE ON rental_checks BEGIN SELECT RAISE(ABORT, 'rental_checks : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_checks_fige BEFORE UPDATE ON rental_checks BEGIN SELECT RAISE(ABORT, 'rental_checks : un contrôle rangé ne change plus'); END;

-- L'échéance du propriétaire : texte écrit par le code, préparé une seule fois par logement et par date d'interdiction,
-- jamais envoyé d'ici ; son passage par le contrôle central des envois revient à W10.
CREATE TABLE IF NOT EXISTS rental_owner_notices (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES rental_listings (id) ON DELETE RESTRICT,
  owner_person_id TEXT NOT NULL,
  energy_class TEXT NOT NULL CHECK (energy_class IN ('E', 'F', 'G')),
  banned_from TEXT NOT NULL,
  text TEXT NOT NULL,
  prepared_at TEXT NOT NULL,
  UNIQUE (listing_id, banned_from)
);
CREATE TRIGGER IF NOT EXISTS rental_owner_notices_garde BEFORE DELETE ON rental_owner_notices BEGIN SELECT RAISE(ABORT, 'rental_owner_notices : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_owner_notices_fige BEFORE UPDATE ON rental_owner_notices BEGIN SELECT RAISE(ABORT, 'rental_owner_notices : une échéance préparée ne change plus'); END;
