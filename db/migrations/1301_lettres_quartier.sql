-- G06 · Lettres de quartier, adressées sans nom (M20) [R140, R37, R46, R17].
-- Une campagne naît d'un mandat signé ou d'une vente rapportée sur un bien de l'agent. Le centre du rayon est gardé
-- par sa seule position ; l'adresse du bien n'est jamais rangée ici.
CREATE TABLE IF NOT EXISTS neighbourhood_campaigns (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('mandat', 'vente')),
  recipient TEXT NOT NULL CHECK (recipient IN ('au_proprietaire', 'aux_habitants')),
  radius_m INTEGER NOT NULL CHECK (radius_m BETWEEN 50 AND 3000),
  center_lat REAL NOT NULL,
  center_lon REAL NOT NULL,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 20 AND 1200),
  text_by TEXT NOT NULL CHECK (text_by IN ('ia', 'secours')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS neighbourhood_campaigns_agent ON neighbourhood_campaigns (network_id, agent_id, created_at);
CREATE TRIGGER IF NOT EXISTS neighbourhood_campaigns_garde BEFORE DELETE ON neighbourhood_campaigns BEGIN SELECT RAISE(ABORT, 'neighbourhood_campaigns : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS neighbourhood_campaigns_fige BEFORE UPDATE ON neighbourhood_campaigns BEGIN SELECT RAISE(ABORT, 'neighbourhood_campaigns : une campagne rangée ne change plus'); END;

-- Une lettre par adresse saisie par l'agent : numéro, voie, commune ; jamais un nom. Le dépôt se note une fois.
CREATE TABLE IF NOT EXISTS neighbourhood_letters (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES neighbourhood_campaigns (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  street_number TEXT NOT NULL CHECK (length(street_number) BETWEEN 1 AND 12),
  street TEXT NOT NULL CHECK (length(street) BETWEEN 3 AND 80),
  postcode TEXT NOT NULL CHECK (length(postcode) = 5 AND postcode NOT GLOB '*[^0-9]*'),
  city TEXT NOT NULL CHECK (length(city) BETWEEN 1 AND 60),
  distance_m INTEGER NOT NULL CHECK (distance_m >= 0),
  position INTEGER NOT NULL CHECK (position >= 1),
  deposited_at TEXT,
  deposited_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (campaign_id, street_number, street, postcode),
  UNIQUE (campaign_id, position),
  CHECK ((deposited_at IS NULL) = (deposited_by IS NULL))
);
CREATE TRIGGER IF NOT EXISTS neighbourhood_letters_garde BEFORE DELETE ON neighbourhood_letters BEGIN SELECT RAISE(ABORT, 'neighbourhood_letters : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS neighbourhood_letters_fige
BEFORE UPDATE ON neighbourhood_letters
WHEN OLD.deposited_at IS NOT NULL OR NEW.id IS NOT OLD.id OR NEW.campaign_id IS NOT OLD.campaign_id OR NEW.network_id IS NOT OLD.network_id
  OR NEW.street_number IS NOT OLD.street_number OR NEW.street IS NOT OLD.street OR NEW.postcode IS NOT OLD.postcode OR NEW.city IS NOT OLD.city
  OR NEW.distance_m IS NOT OLD.distance_m OR NEW.position IS NOT OLD.position OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'neighbourhood_letters : une lettre déposée ne change plus');
END;
