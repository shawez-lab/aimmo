-- HX16 · Veille des nouveaux diagnostics énergétiques par secteur. Tables nouvelles, en ajout seul : rien ne change ni
-- ne s'efface [R17]. Aucune colonne pour un nom, un numéro, un mail ou une adresse de propriétaire : il n'est jamais
-- cherché [R288]. L'adresse du logement diagnostiqué n'est lue que par l'agent de la zone et la direction, jamais au
-- journal [R13].

-- Un secteur de veille : une commune des zones de l'agent, avec son code postal [R289].
CREATE TABLE IF NOT EXISTS dpe_watch_sectors (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  commune TEXT NOT NULL CHECK (length(trim(commune)) BETWEEN 1 AND 80),
  commune_slug TEXT NOT NULL CHECK (length(commune_slug) BETWEEN 1 AND 80),
  postcode TEXT NOT NULL CHECK (length(postcode) = 5),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (id, network_id),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS dpe_watch_sectors_agent ON dpe_watch_sectors (network_id, agent_id);
CREATE TRIGGER IF NOT EXISTS dpe_watch_sectors_fige BEFORE UPDATE ON dpe_watch_sectors BEGIN SELECT RAISE(ABORT, 'dpe_watch_sectors : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS dpe_watch_sectors_garde BEFORE DELETE ON dpe_watch_sectors BEGIN SELECT RAISE(ABORT, 'dpe_watch_sectors : rien ne s''efface'); END;

-- La fin d'un secteur de veille : il ne reçoit plus rien.
CREATE TABLE IF NOT EXISTS dpe_watch_stops (
  sector_id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  stopped_by TEXT NOT NULL,
  stopped_at TEXT NOT NULL,
  FOREIGN KEY (sector_id, network_id) REFERENCES dpe_watch_sectors (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS dpe_watch_stops_fige BEFORE UPDATE ON dpe_watch_stops BEGIN SELECT RAISE(ABORT, 'dpe_watch_stops : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS dpe_watch_stops_garde BEFORE DELETE ON dpe_watch_stops BEGIN SELECT RAISE(ABORT, 'dpe_watch_stops : rien ne s''efface'); END;

-- Un diagnostic publié par l'ADEME, rangé une seule fois par réseau, sous son numéro : jamais vu deux fois [R288].
CREATE TABLE IF NOT EXISTS dpe_diagnoses (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  number TEXT NOT NULL CHECK (length(number) BETWEEN 8 AND 24),
  kind TEXT NOT NULL CHECK (kind IN ('apartment', 'house', 'building')),
  energy_class TEXT NOT NULL CHECK (energy_class IN ('A', 'B', 'C', 'D', 'E', 'F', 'G')),
  ghg_class TEXT CHECK (ghg_class IS NULL OR ghg_class IN ('A', 'B', 'C', 'D', 'E', 'F', 'G')),
  surface_m2 REAL CHECK (surface_m2 IS NULL OR (surface_m2 > 0 AND surface_m2 < 10000)),
  diagnosed_on TEXT NOT NULL CHECK (length(diagnosed_on) = 10),
  received_on TEXT NOT NULL CHECK (length(received_on) = 10),
  street_number TEXT CHECK (street_number IS NULL OR length(trim(street_number)) BETWEEN 1 AND 12),
  street TEXT NOT NULL CHECK (length(trim(street)) BETWEEN 3 AND 80),
  postcode TEXT NOT NULL CHECK (length(postcode) = 5),
  commune TEXT NOT NULL CHECK (length(trim(commune)) BETWEEN 1 AND 80),
  commune_slug TEXT NOT NULL CHECK (length(commune_slug) BETWEEN 1 AND 80),
  lat REAL CHECK (lat IS NULL OR (lat BETWEEN -90 AND 90)),
  lon REAL CHECK (lon IS NULL OR (lon BETWEEN -180 AND 180)),
  first_seen_at TEXT NOT NULL,
  UNIQUE (network_id, number),
  UNIQUE (id, network_id)
);
CREATE INDEX IF NOT EXISTS dpe_diagnoses_commune ON dpe_diagnoses (network_id, commune_slug, received_on);
CREATE TRIGGER IF NOT EXISTS dpe_diagnoses_fige BEFORE UPDATE ON dpe_diagnoses BEGIN SELECT RAISE(ABORT, 'dpe_diagnoses : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS dpe_diagnoses_garde BEFORE DELETE ON dpe_diagnoses BEGIN SELECT RAISE(ABORT, 'dpe_diagnoses : rien ne s''efface'); END;

-- Une ligne de l'alerte du jour d'un secteur : un diagnostic n'y remonte qu'une fois [R288, R289].
CREATE TABLE IF NOT EXISTS dpe_alert_items (
  sector_id TEXT NOT NULL,
  diagnosis_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  alerted_on TEXT NOT NULL CHECK (length(alerted_on) = 10),
  created_at TEXT NOT NULL,
  PRIMARY KEY (sector_id, diagnosis_id),
  FOREIGN KEY (sector_id, network_id) REFERENCES dpe_watch_sectors (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (diagnosis_id, network_id) REFERENCES dpe_diagnoses (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS dpe_alert_items_day ON dpe_alert_items (sector_id, alerted_on);
CREATE TRIGGER IF NOT EXISTS dpe_alert_items_fige BEFORE UPDATE ON dpe_alert_items BEGIN SELECT RAISE(ABORT, 'dpe_alert_items : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS dpe_alert_items_garde BEFORE DELETE ON dpe_alert_items BEGIN SELECT RAISE(ABORT, 'dpe_alert_items : rien ne s''efface'); END;

-- La lettre « Au propriétaire » d'un logement classé F ou G, une seule par diagnostic dans le réseau, écrite par le
-- code avec la date d'interdiction de louer de M15 [R290]. Aucun nom : le destinataire est la liste fermée de G06.
CREATE TABLE IF NOT EXISTS dpe_letters (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  diagnosis_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  energy_class TEXT NOT NULL CHECK (energy_class IN ('F', 'G')),
  banned_from TEXT NOT NULL CHECK (length(banned_from) = 10),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 20 AND 1200),
  created_at TEXT NOT NULL,
  UNIQUE (network_id, diagnosis_id),
  UNIQUE (id, network_id),
  FOREIGN KEY (diagnosis_id, network_id) REFERENCES dpe_diagnoses (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS dpe_letters_fige BEFORE UPDATE ON dpe_letters BEGIN SELECT RAISE(ABORT, 'dpe_letters : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS dpe_letters_garde BEFORE DELETE ON dpe_letters BEGIN SELECT RAISE(ABORT, 'dpe_letters : rien ne s''efface'); END;
