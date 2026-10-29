-- X05 · Publications prêtes pour chaque bien, visite, offre, vente (M19) [R134, R132, R46, R42, R26]. Une publication
-- préparée est figée ; sa liste de contrôle par visuel, la validation de l'agent et chaque envoi, en mode essai,
-- s'ajoutent. Rien ne s'efface ni ne se réécrit [R17].
CREATE TABLE IF NOT EXISTS social_posts (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  network_id TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('nouveau_bien', 'visite', 'offre', 'vente')),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 10 AND 2200),
  origin TEXT NOT NULL CHECK (origin IN ('ia', 'secours')),
  visuals TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS social_posts_property ON social_posts (property_id, created_at);
CREATE TRIGGER IF NOT EXISTS social_posts_garde BEFORE DELETE ON social_posts BEGIN SELECT RAISE(ABORT, 'social_posts : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS social_posts_fige BEFORE UPDATE ON social_posts BEGIN SELECT RAISE(ABORT, 'social_posts : une publication préparée ne change plus'); END;

-- La liste de contrôle d'un visuel pour une publication, validée par l'agent : une fois, admise ou refusée.
CREATE TABLE IF NOT EXISTS social_visual_checks (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES social_posts (id) ON DELETE RESTRICT,
  media_ref TEXT NOT NULL,
  address_visible INTEGER NOT NULL CHECK (address_visible IN (0, 1)),
  person_visible INTEGER NOT NULL CHECK (person_visible IN (0, 1)),
  consent_ref TEXT,
  staging_label_visible INTEGER CHECK (staging_label_visible IS NULL OR staging_label_visible IN (0, 1)),
  outcome TEXT NOT NULL CHECK (outcome IN ('admis', 'refuse')),
  checked_by TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  UNIQUE (post_id, media_ref)
);
CREATE TRIGGER IF NOT EXISTS social_visual_checks_garde BEFORE DELETE ON social_visual_checks BEGIN SELECT RAISE(ABORT, 'social_visual_checks : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS social_visual_checks_fige BEFORE UPDATE ON social_visual_checks BEGIN SELECT RAISE(ABORT, 'social_visual_checks : une liste de contrôle ne change plus'); END;

CREATE TABLE IF NOT EXISTS social_post_validations (
  post_id TEXT PRIMARY KEY REFERENCES social_posts (id) ON DELETE RESTRICT,
  validated_by TEXT NOT NULL,
  validated_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS social_post_validations_garde BEFORE DELETE ON social_post_validations BEGIN SELECT RAISE(ABORT, 'social_post_validations : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS social_post_validations_fige BEFORE UPDATE ON social_post_validations BEGIN SELECT RAISE(ABORT, 'social_post_validations : une validation ne change plus'); END;

-- Chaque essai d'envoi vers un réseau et un compte : réservé avant l'envoi (un seul passage gagne un essai donné),
-- puis son issue. Toujours en mode essai tant que le plan ne l'a pas mis en service [R26, R134].
CREATE TABLE IF NOT EXISTS social_post_attempts (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES social_posts (id) ON DELETE RESTRICT,
  channel TEXT NOT NULL CHECK (channel IN ('instagram', 'facebook', 'linkedin', 'google', 'tiktok', 'youtube')),
  account TEXT NOT NULL CHECK (account IN ('agent', 'reseau')),
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 0 AND 9),
  mode TEXT NOT NULL CHECK (mode = 'essai'),
  claimed_by TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  UNIQUE (post_id, channel, account, attempt)
);
CREATE TRIGGER IF NOT EXISTS social_post_attempts_garde BEFORE DELETE ON social_post_attempts BEGIN SELECT RAISE(ABORT, 'social_post_attempts : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS social_post_attempts_fige BEFORE UPDATE ON social_post_attempts BEGIN SELECT RAISE(ABORT, 'social_post_attempts : un essai ne change plus'); END;

CREATE TABLE IF NOT EXISTS social_post_sends (
  attempt_id TEXT PRIMARY KEY REFERENCES social_post_attempts (id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('envoye', 'echec')),
  done_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS social_post_sends_garde BEFORE DELETE ON social_post_sends BEGIN SELECT RAISE(ABORT, 'social_post_sends : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS social_post_sends_fige BEFORE UPDATE ON social_post_sends BEGIN SELECT RAISE(ABORT, 'social_post_sends : un envoi ne change plus'); END;
