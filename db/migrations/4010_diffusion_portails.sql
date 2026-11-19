-- AU004 · Diffusion réelle sur chaque portail souscrit, avec accusé et statut par portail [R668, R42, R44].
-- Les portails à diffuser sont ceux de HX38 (`diffusion_portal_settings`, choix et retraits par bien).

-- Chaque envoi à un portail : publier, modifier ou retirer une version publiée. « envoi » est rangé avant de rien
-- envoyer (clé, ordre et version du geste) ; puis « accuse » seulement avec l'accusé
-- rendu par le portail ; « essai » quand aucun connecteur réel n'existe (rien n'est parti) ; « echec » sinon.
CREATE TABLE IF NOT EXISTS portal_operations (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL REFERENCES properties (id) ON DELETE RESTRICT,
  portal TEXT NOT NULL,
  -- Le rang du geste pour ce bien et ce portail : 1, 2, 3… L'ordre ne dépend jamais de l'horloge.
  n INTEGER NOT NULL CHECK (n >= 1),
  version_id TEXT NOT NULL REFERENCES listing_versions (id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL,
  -- La clé d'envoi du geste : la même à chaque nouvel essai d'un geste resté sans accusé, une autre pour tout autre geste.
  op_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('publier', 'modifier', 'retirer')),
  outcome TEXT NOT NULL CHECK (outcome IN ('envoi', 'accuse', 'essai', 'echec')),
  receipt TEXT,
  portal_listing_id TEXT,
  error_code TEXT,
  at TEXT NOT NULL,
  CHECK ((outcome = 'accuse') = (receipt IS NOT NULL)),
  CHECK ((outcome = 'echec') = (error_code IS NOT NULL))
);
-- Un essai n'est rangé qu'une fois par version et par geste. Les accusés, eux, se suivent sous le bail du passage :
-- un portail arrêté puis repris reçoit de nouveau la même version.
CREATE UNIQUE INDEX IF NOT EXISTS portal_operations_essai ON portal_operations (property_id, portal, seq, action) WHERE outcome = 'essai';
CREATE UNIQUE INDEX IF NOT EXISTS portal_operations_rang ON portal_operations (property_id, portal, n);
CREATE TRIGGER IF NOT EXISTS portal_operations_garde BEFORE DELETE ON portal_operations BEGIN SELECT RAISE(ABORT, 'portal_operations : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS portal_operations_fige BEFORE UPDATE ON portal_operations BEGIN SELECT RAISE(ABORT, 'portal_operations : rien ne se réécrit'); END;

-- Un seul passage à la fois par bien vers les portails : deux passages n'envoient jamais deux fois la même version.
CREATE TABLE IF NOT EXISTS portal_sync_leases (
  property_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
