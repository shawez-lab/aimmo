-- HX54 · Publicité payante mesurée au mandat (M07, M20 « Mesure », M12) [R587, R588, R589].

-- Une campagne de publicité payante, Google Ads ou Meta, d'un réseau. Son ciblage ne peut porter que sur des communes
-- (codes INSEE) et un rayon d'au moins 15 km : aucune colonne pour un autre critère, rien d'autre ne se range [R589].
-- Le code de suivi est porté par les liens de la campagne, pour reconnaître les contacts qu'elle amène.
CREATE TABLE IF NOT EXISTS ad_campaigns (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  platform TEXT NOT NULL CHECK (platform IN ('google_ads', 'meta')),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 3 AND 80),
  code TEXT NOT NULL UNIQUE CHECK (length(code) = 12),
  communes TEXT NOT NULL CHECK (json_valid(communes) AND json_type(communes) = 'array' AND json_array_length(communes) BETWEEN 1 AND 30),
  radius_km INTEGER CHECK (radius_km IS NULL OR radius_km BETWEEN 15 AND 80),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (id, network_id)
);
CREATE TRIGGER IF NOT EXISTS ad_campaigns_garde BEFORE DELETE ON ad_campaigns BEGIN SELECT RAISE(ABORT, 'ad_campaigns : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS ad_campaigns_fige BEFORE UPDATE ON ad_campaigns BEGIN SELECT RAISE(ABORT, 'ad_campaigns : une campagne ne change plus, une nouvelle se crée'); END;

-- La validation de la direction : budget par jour, budget total, seuil de coût par contact. Une version par
-- validation ; seule la direction valide [R587]. Rien ne change ni ne s'efface.
CREATE TABLE IF NOT EXISTS ad_campaign_approvals (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES ad_campaigns (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  daily_budget_cents INTEGER NOT NULL CHECK (daily_budget_cents > 0),
  total_budget_cents INTEGER NOT NULL CHECK (total_budget_cents >= daily_budget_cents),
  max_cost_per_contact_cents INTEGER NOT NULL CHECK (max_cost_per_contact_cents > 0),
  approved_by TEXT NOT NULL CHECK (approved_by LIKE 'direction:%'),
  approved_at TEXT NOT NULL,
  UNIQUE (campaign_id, version)
);
CREATE TRIGGER IF NOT EXISTS ad_campaign_approvals_garde BEFORE DELETE ON ad_campaign_approvals BEGIN SELECT RAISE(ABORT, 'ad_campaign_approvals : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS ad_campaign_approvals_fige BEFORE UPDATE ON ad_campaign_approvals BEGIN SELECT RAISE(ABORT, 'ad_campaign_approvals : une validation ne change plus'); END;

-- Le lancement d'une validation, une seule fois, par la direction ; jamais une validation déjà arrêtée [R587].
CREATE TABLE IF NOT EXISTS ad_campaign_starts (
  approval_id TEXT PRIMARY KEY REFERENCES ad_campaign_approvals (id) ON DELETE RESTRICT,
  campaign_id TEXT NOT NULL REFERENCES ad_campaigns (id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK (mode IN ('essai')),
  started_by TEXT NOT NULL CHECK (started_by LIKE 'direction:%'),
  started_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS ad_campaign_starts_validation BEFORE INSERT ON ad_campaign_starts
WHEN NOT EXISTS (SELECT 1 FROM ad_campaign_approvals a WHERE a.id = NEW.approval_id AND a.campaign_id = NEW.campaign_id)
  OR EXISTS (SELECT 1 FROM ad_campaign_stops s WHERE s.approval_id = NEW.approval_id)
  OR EXISTS (SELECT 1 FROM ad_campaign_approvals b WHERE b.campaign_id = NEW.campaign_id AND b.version > (SELECT version FROM ad_campaign_approvals WHERE id = NEW.approval_id))
BEGIN SELECT RAISE(ABORT, 'ad_campaign_starts : aucun lancement sans la dernière validation en vigueur de la direction'); END;
CREATE TRIGGER IF NOT EXISTS ad_campaign_starts_garde BEFORE DELETE ON ad_campaign_starts BEGIN SELECT RAISE(ABORT, 'ad_campaign_starts : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS ad_campaign_starts_fige BEFORE UPDATE ON ad_campaign_starts BEGIN SELECT RAISE(ABORT, 'ad_campaign_starts : rien ne se réécrit'); END;

-- L'arrêt d'une validation, une seule fois : au seuil, au budget, par la direction, ou lancement en échec [R588].
-- Une validation arrêtée ne repart jamais : il en faut une nouvelle de la direction.
CREATE TABLE IF NOT EXISTS ad_campaign_stops (
  approval_id TEXT PRIMARY KEY REFERENCES ad_campaign_approvals (id) ON DELETE RESTRICT,
  campaign_id TEXT NOT NULL REFERENCES ad_campaigns (id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (reason IN ('seuil', 'budget', 'direction', 'echec_lancement', 'depense_sans_validation')),
  spend_cents INTEGER NOT NULL CHECK (spend_cents >= 0),
  contacts INTEGER NOT NULL CHECK (contacts >= 0),
  stopped_by TEXT NOT NULL,
  stopped_at TEXT NOT NULL,
  -- La pause confirmée par la plateforme ; sans confirmation, elle est redemandée à chaque passage.
  paused_at TEXT
);
CREATE TRIGGER IF NOT EXISTS ad_campaign_stops_garde BEFORE DELETE ON ad_campaign_stops BEGIN SELECT RAISE(ABORT, 'ad_campaign_stops : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS ad_campaign_stops_fige BEFORE UPDATE ON ad_campaign_stops
WHEN NOT (OLD.paused_at IS NULL AND NEW.paused_at IS NOT NULL AND NEW.approval_id = OLD.approval_id AND NEW.campaign_id = OLD.campaign_id AND NEW.reason = OLD.reason
  AND NEW.spend_cents = OLD.spend_cents AND NEW.contacts = OLD.contacts AND NEW.stopped_by = OLD.stopped_by AND NEW.stopped_at = OLD.stopped_at)
BEGIN SELECT RAISE(ABORT, 'ad_campaign_stops : un arrêt ne change plus, seule sa pause se confirme'); END;

-- La dépense lue chez la plateforme, par jour ; une correction s'ajoute en version, la dernière fait foi.
CREATE TABLE IF NOT EXISTS ad_campaign_spend (
  campaign_id TEXT NOT NULL REFERENCES ad_campaigns (id) ON DELETE RESTRICT,
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  version INTEGER NOT NULL CHECK (version >= 1),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  reported_at TEXT NOT NULL,
  PRIMARY KEY (campaign_id, day, version)
);
CREATE TRIGGER IF NOT EXISTS ad_campaign_spend_garde BEFORE DELETE ON ad_campaign_spend BEGIN SELECT RAISE(ABORT, 'ad_campaign_spend : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS ad_campaign_spend_fige BEFORE UPDATE ON ad_campaign_spend BEGIN SELECT RAISE(ABORT, 'ad_campaign_spend : une dépense rangée ne change plus, une version s''ajoute'); END;

-- Les contacts amenés par une campagne, une fois par personne : la fiche, jamais son message ni sa page.
CREATE TABLE IF NOT EXISTS ad_campaign_contacts (
  campaign_id TEXT NOT NULL REFERENCES ad_campaigns (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  arrived_at TEXT NOT NULL,
  PRIMARY KEY (campaign_id, person_id),
  FOREIGN KEY (campaign_id, network_id) REFERENCES ad_campaigns (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS ad_campaign_contacts_person ON ad_campaign_contacts (person_id);
CREATE TRIGGER IF NOT EXISTS ad_campaign_contacts_garde BEFORE DELETE ON ad_campaign_contacts BEGIN SELECT RAISE(ABORT, 'ad_campaign_contacts : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS ad_campaign_contacts_fige BEFORE UPDATE ON ad_campaign_contacts BEGIN SELECT RAISE(ABORT, 'ad_campaign_contacts : rien ne se réécrit'); END;
