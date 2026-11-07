-- HX18 · Adresse probable d'une annonce de particulier, et bien créé sans ressaisie. Tables nouvelles, en ajout seul :
-- rien ne change ni ne s'efface [R17]. Aucune colonne pour un nom, un numéro ou un mail du particulier : ses
-- coordonnées ne sont jamais cherchées [R294, R273].

-- Ce que l'annonce dit de son diagnostic : la classe énergie et, quand elle la dit, sa date.
CREATE TABLE IF NOT EXISTS pige_ad_energy (
  ad_id TEXT PRIMARY KEY REFERENCES pige_ads (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  energy_class TEXT NOT NULL CHECK (energy_class IN ('A', 'B', 'C', 'D', 'E', 'F', 'G')),
  diagnosed_on TEXT CHECK (diagnosed_on IS NULL OR length(diagnosed_on) = 10)
);
CREATE TRIGGER IF NOT EXISTS pige_ad_energy_fige BEFORE UPDATE ON pige_ad_energy BEGIN SELECT RAISE(ABORT, 'pige_ad_energy : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS pige_ad_energy_garde BEFORE DELETE ON pige_ad_energy BEGIN SELECT RAISE(ABORT, 'pige_ad_energy : rien ne s''efface'); END;

-- Les adresses proposées pour une annonce, un jour : le numéro de chaque diagnostic retenu et sa confiance, jamais la rue
-- ni le numéro de voie. Un bien fermé plus tard ne laisse ainsi aucune adresse probable derrière lui [R294, R273].
CREATE TABLE IF NOT EXISTS pige_address_proposals (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  ad_id TEXT NOT NULL REFERENCES pige_ads (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  candidates TEXT NOT NULL CHECK (json_valid(candidates) AND json_type(candidates) = 'array'),
  missing TEXT NOT NULL CHECK (json_valid(missing) AND json_type(missing) = 'array'),
  created_at TEXT NOT NULL,
  UNIQUE (id, network_id),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS pige_address_proposals_ad ON pige_address_proposals (network_id, ad_id, created_at);
CREATE TRIGGER IF NOT EXISTS pige_address_proposals_fige BEFORE UPDATE ON pige_address_proposals BEGIN SELECT RAISE(ABORT, 'pige_address_proposals : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS pige_address_proposals_garde BEFORE DELETE ON pige_address_proposals BEGIN SELECT RAISE(ABORT, 'pige_address_proposals : rien ne s''efface'); END;

-- Le bien créé depuis une annonce de pige : la source « pige » reste attachée au bien, jusqu'au mandat et après, pour
-- mesurer ce que la pige rapporte [R295, R296]. Un seul bien par bien de pige.
CREATE TABLE IF NOT EXISTS pige_properties (
  property_id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK (source = 'pige'),
  ad_id TEXT NOT NULL REFERENCES pige_ads (id) ON DELETE RESTRICT,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  ad_site TEXT NOT NULL CHECK (length(ad_site) BETWEEN 2 AND 60),
  ad_kind TEXT NOT NULL CHECK (ad_kind IN ('apartment', 'house')),
  energy_class TEXT CHECK (energy_class IS NULL OR energy_class IN ('A', 'B', 'C', 'D', 'E', 'F', 'G')),
  diagnosed_on TEXT CHECK (diagnosed_on IS NULL OR length(diagnosed_on) = 10),
  published_at TEXT NOT NULL,
  proposal_id TEXT REFERENCES pige_address_proposals (id) ON DELETE RESTRICT,
  diagnosis_number TEXT CHECK (diagnosis_number IS NULL OR length(diagnosis_number) BETWEEN 8 AND 24),
  street_number TEXT CHECK (street_number IS NULL OR length(trim(street_number)) BETWEEN 1 AND 12),
  street TEXT CHECK (street IS NULL OR length(trim(street)) BETWEEN 3 AND 80),
  confidence INTEGER CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100),
  agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- Une adresse retenue vient toujours d'une proposition, avec sa confiance.
  CHECK ((street IS NULL) = (confidence IS NULL) AND (street IS NULL) = (diagnosis_number IS NULL) AND (street IS NULL OR proposal_id IS NOT NULL)),
  UNIQUE (network_id, fingerprint),
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS pige_properties_agent ON pige_properties (network_id, agent_id);
-- Un bien « pas d'agence » ou fermé par un non n'est jamais converti [R295, R273, R04].
CREATE TRIGGER IF NOT EXISTS pige_properties_ferme
BEFORE INSERT ON pige_properties
WHEN EXISTS (SELECT 1 FROM pige_no_agency n WHERE n.network_id = NEW.network_id AND n.fingerprint = NEW.fingerprint)
  OR EXISTS (SELECT 1 FROM pige_oppositions o WHERE o.network_id = NEW.network_id AND o.fingerprint = NEW.fingerprint)
BEGIN
  SELECT RAISE(ABORT, 'pige_properties : bien fermé');
END;
-- Toutes les empreintes et clés reliées au bien de pige converti (autre site, surface à 1 m² près, surface corrigée) :
-- chacune ne sert qu'à un bien, et aucune n'est fermée. Rangées dans le même lot que le bien : deux conversions d'un même
-- bien relié, en même temps, n'en gardent qu'une [R295, R273, R04].
CREATE TABLE IF NOT EXISTS pige_property_keys (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  key TEXT NOT NULL CHECK (length(key) = 64),
  property_id TEXT NOT NULL REFERENCES pige_properties (property_id) ON DELETE RESTRICT,
  PRIMARY KEY (network_id, key)
);
CREATE TRIGGER IF NOT EXISTS pige_property_keys_ferme
BEFORE INSERT ON pige_property_keys
WHEN EXISTS (SELECT 1 FROM pige_no_agency n WHERE n.network_id = NEW.network_id AND n.fingerprint = NEW.key)
  OR EXISTS (SELECT 1 FROM pige_oppositions o WHERE o.network_id = NEW.network_id AND o.fingerprint = NEW.key)
BEGIN
  SELECT RAISE(ABORT, 'pige_property_keys : bien fermé');
END;
CREATE TRIGGER IF NOT EXISTS pige_property_keys_fige BEFORE UPDATE ON pige_property_keys BEGIN SELECT RAISE(ABORT, 'pige_property_keys : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS pige_property_keys_garde BEFORE DELETE ON pige_property_keys BEGIN SELECT RAISE(ABORT, 'pige_property_keys : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS pige_properties_fige BEFORE UPDATE ON pige_properties BEGIN SELECT RAISE(ABORT, 'pige_properties : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS pige_properties_garde BEFORE DELETE ON pige_properties BEGIN SELECT RAISE(ABORT, 'pige_properties : rien ne s''efface'); END;
