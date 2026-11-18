-- AU004 · Diffusion réelle sur chaque portail souscrit, avec accusé et statut par portail [R668, R42, R44].
-- Les abonnements aux portails sont réglés par la direction : chaque réglage s'ajoute, rien ne s'efface.
CREATE TABLE IF NOT EXISTS portal_subscriptions (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  portal TEXT NOT NULL CHECK (length(portal) BETWEEN 2 AND 40),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS portal_subscriptions_network ON portal_subscriptions (network_id, portal, set_at);
CREATE TRIGGER IF NOT EXISTS portal_subscriptions_garde BEFORE DELETE ON portal_subscriptions BEGIN SELECT RAISE(ABORT, 'portal_subscriptions : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS portal_subscriptions_fige BEFORE UPDATE ON portal_subscriptions BEGIN SELECT RAISE(ABORT, 'portal_subscriptions : rien ne se réécrit'); END;

-- Chaque envoi à un portail : publier, modifier ou retirer une version publiée. « accuse » seulement avec l'accusé
-- rendu par le portail ; « essai » quand aucun connecteur réel n'existe (rien n'est parti) ; « echec » sinon.
CREATE TABLE IF NOT EXISTS portal_operations (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL REFERENCES properties (id) ON DELETE RESTRICT,
  portal TEXT NOT NULL,
  version_id TEXT NOT NULL REFERENCES listing_versions (id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('publier', 'modifier', 'retirer')),
  outcome TEXT NOT NULL CHECK (outcome IN ('accuse', 'essai', 'echec')),
  receipt TEXT,
  portal_ref TEXT,
  error_code TEXT,
  at TEXT NOT NULL,
  CHECK ((outcome = 'accuse') = (receipt IS NOT NULL)),
  CHECK ((outcome = 'echec') = (error_code IS NOT NULL))
);
-- Un essai n'est rangé qu'une fois par version et par geste. Les accusés, eux, se suivent sous le bail du passage :
-- un portail arrêté puis repris reçoit de nouveau la même version.
CREATE UNIQUE INDEX IF NOT EXISTS portal_operations_essai ON portal_operations (property_id, portal, seq, action) WHERE outcome = 'essai';
CREATE INDEX IF NOT EXISTS portal_operations_bien ON portal_operations (property_id, portal, at);
CREATE TRIGGER IF NOT EXISTS portal_operations_garde BEFORE DELETE ON portal_operations BEGIN SELECT RAISE(ABORT, 'portal_operations : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS portal_operations_fige BEFORE UPDATE ON portal_operations BEGIN SELECT RAISE(ABORT, 'portal_operations : rien ne se réécrit'); END;

-- Un seul passage à la fois par bien vers les portails : deux passages n'envoient jamais deux fois la même version.
CREATE TABLE IF NOT EXISTS portal_sync_leases (
  property_id TEXT PRIMARY KEY REFERENCES properties (id) ON DELETE RESTRICT,
  token TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
