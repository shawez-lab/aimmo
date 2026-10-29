-- AT06 · Fiche Google : informations, publications et réponses aux avis, préparées puis validées [R154, R64, R26].
-- Rien ne s'efface ni ne se réécrit : chaque réglage, avis, texte, validation et envoi s'ajoute.

-- La fiche Google d'un agent : sa référence chez Google et ce qu'elle doit montrer, réglés par la direction.
CREATE TABLE IF NOT EXISTS gbp_locations (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  location_ref TEXT NOT NULL CHECK (length(location_ref) BETWEEN 3 AND 200),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 2 AND 100),
  website_uri TEXT NOT NULL CHECK (length(website_uri) BETWEEN 10 AND 300),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS gbp_locations_agent ON gbp_locations (network_id, agent_id, set_at);

-- Un avis lu sur la fiche. Le nom de son auteur n'est jamais gardé : seules les empreintes de ses mots, pour qu'aucune
-- réponse ne puisse le citer.
CREATE TABLE IF NOT EXISTS gbp_reviews (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  review_ref TEXT NOT NULL CHECK (length(review_ref) BETWEEN 3 AND 300),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT CHECK (comment IS NULL OR length(comment) <= 4096),
  author_token_hashes TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  UNIQUE (network_id, review_ref),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS gbp_reviews_agent ON gbp_reviews (network_id, agent_id, reviewed_at);

-- Un texte à publier sur la fiche : réponse à un avis ou publication tirée d'un bien publié.
CREATE TABLE IF NOT EXISTS gbp_drafts (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reponse', 'publication')),
  review_id TEXT REFERENCES gbp_reviews (id) ON DELETE RESTRICT,
  property_id TEXT,
  listing_seq INTEGER,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1500),
  link_uri TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('ia', 'secours', 'code', 'agent')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK ((kind = 'reponse' AND review_id IS NOT NULL AND property_id IS NULL) OR (kind = 'publication' AND review_id IS NULL AND property_id IS NOT NULL AND listing_seq IS NOT NULL)),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS gbp_drafts_agent ON gbp_drafts (network_id, agent_id, created_at);
CREATE INDEX IF NOT EXISTS gbp_drafts_review ON gbp_drafts (review_id);
CREATE INDEX IF NOT EXISTS gbp_drafts_property ON gbp_drafts (property_id, created_at);

-- La validation nommée du texte exact, par une personne [R154].
CREATE TABLE IF NOT EXISTS gbp_validations (
  draft_id TEXT PRIMARY KEY REFERENCES gbp_drafts (id) ON DELETE RESTRICT,
  text_sha256 TEXT NOT NULL CHECK (length(text_sha256) = 64),
  validated_by TEXT NOT NULL,
  validated_at TEXT NOT NULL
);

-- Ce qui est parti, ou serait parti en mode essai [R26]. Un texte ne part qu'une fois.
CREATE TABLE IF NOT EXISTS gbp_sends (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  draft_id TEXT REFERENCES gbp_drafts (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('reponse', 'publication', 'informations')),
  info_sha256 TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('essai', 'reel')),
  outcome TEXT NOT NULL CHECK (outcome IN ('essai', 'envoye', 'echec')),
  sent_by TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  CHECK ((kind = 'informations') = (draft_id IS NULL)),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
-- Un texte ne part qu'une fois par mode : un essai ne consomme pas l'envoi réel.
CREATE UNIQUE INDEX IF NOT EXISTS gbp_sends_draft_ok ON gbp_sends (draft_id, mode) WHERE outcome IN ('essai', 'envoye');
CREATE INDEX IF NOT EXISTS gbp_sends_agent ON gbp_sends (network_id, agent_id, kind, sent_at);

-- La réservation d'un envoi, prise avant d'appeler Google : deux demandes simultanées ne font partir qu'un texte, et un
-- avis ne reçoit qu'une réponse. Après une panne, l'essai suivant prend une nouvelle réservation.
CREATE TABLE IF NOT EXISTS gbp_claims (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  draft_id TEXT NOT NULL REFERENCES gbp_drafts (id) ON DELETE RESTRICT,
  target TEXT NOT NULL CHECK (length(target) BETWEEN 3 AND 120),
  mode TEXT NOT NULL CHECK (mode IN ('essai', 'reel')),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  claimed_by TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  UNIQUE (target, mode, attempt)
);

CREATE TRIGGER IF NOT EXISTS gbp_claims_garde BEFORE DELETE ON gbp_claims BEGIN SELECT RAISE(ABORT, 'gbp_claims : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS gbp_claims_fige BEFORE UPDATE ON gbp_claims BEGIN SELECT RAISE(ABORT, 'gbp_claims : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS gbp_locations_garde BEFORE DELETE ON gbp_locations BEGIN SELECT RAISE(ABORT, 'gbp_locations : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS gbp_locations_fige BEFORE UPDATE ON gbp_locations BEGIN SELECT RAISE(ABORT, 'gbp_locations : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS gbp_reviews_garde BEFORE DELETE ON gbp_reviews BEGIN SELECT RAISE(ABORT, 'gbp_reviews : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS gbp_reviews_fige BEFORE UPDATE ON gbp_reviews BEGIN SELECT RAISE(ABORT, 'gbp_reviews : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS gbp_drafts_garde BEFORE DELETE ON gbp_drafts BEGIN SELECT RAISE(ABORT, 'gbp_drafts : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS gbp_drafts_fige BEFORE UPDATE ON gbp_drafts BEGIN SELECT RAISE(ABORT, 'gbp_drafts : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS gbp_validations_garde BEFORE DELETE ON gbp_validations BEGIN SELECT RAISE(ABORT, 'gbp_validations : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS gbp_validations_fige BEFORE UPDATE ON gbp_validations BEGIN SELECT RAISE(ABORT, 'gbp_validations : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS gbp_sends_garde BEFORE DELETE ON gbp_sends BEGIN SELECT RAISE(ABORT, 'gbp_sends : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS gbp_sends_fige BEFORE UPDATE ON gbp_sends BEGIN SELECT RAISE(ABORT, 'gbp_sends : rien ne se réécrit'); END;
