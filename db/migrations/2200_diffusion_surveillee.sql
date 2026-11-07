-- HX38 · Diffusion surveillée portail par portail. Tables nouvelles, en ajout seul : rien ne s'efface ni ne se réécrit [R17].

-- Les portails du réseau, réglés par la direction : nom, domaine des annonces en ligne, champs exigés. Le dernier réglage
-- d'un code fait foi ; un portail éteint ne reçoit plus rien [R470].
CREATE TABLE IF NOT EXISTS diffusion_portal_settings (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  code TEXT NOT NULL CHECK (length(code) BETWEEN 2 AND 30),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  host TEXT NOT NULL CHECK (length(host) BETWEEN 3 AND 100),
  required_fields TEXT NOT NULL CHECK (json_valid(required_fields)),
  min_photos INTEGER NOT NULL CHECK (min_photos BETWEEN 0 AND 50),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS diffusion_portal_settings_code ON diffusion_portal_settings (network_id, code, set_at);
CREATE TRIGGER IF NOT EXISTS diffusion_portal_settings_garde BEFORE DELETE ON diffusion_portal_settings BEGIN SELECT RAISE(ABORT, 'diffusion_portal_settings : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS diffusion_portal_settings_fige BEFORE UPDATE ON diffusion_portal_settings BEGIN SELECT RAISE(ABORT, 'diffusion_portal_settings : rien ne se réécrit'); END;

-- Le choix des portails, bien par bien : le dernier choix d'un portail pour un bien fait foi [R470].
CREATE TABLE IF NOT EXISTS diffusion_portal_choices (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  portal TEXT NOT NULL,
  chosen INTEGER NOT NULL CHECK (chosen IN (0, 1)),
  by_actor TEXT NOT NULL,
  at TEXT NOT NULL,
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS diffusion_portal_choices_bien ON diffusion_portal_choices (property_id, portal, at);
CREATE TRIGGER IF NOT EXISTS diffusion_portal_choices_garde BEFORE DELETE ON diffusion_portal_choices BEGIN SELECT RAISE(ABORT, 'diffusion_portal_choices : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS diffusion_portal_choices_fige BEFORE UPDATE ON diffusion_portal_choices BEGIN SELECT RAISE(ABORT, 'diffusion_portal_choices : rien ne se réécrit'); END;

-- Retrait temporaire d'un bien d'un portail, jusqu'à une date ou jusqu'à la reprise [R472].
CREATE TABLE IF NOT EXISTS diffusion_portal_suspensions (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  portal TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('travaux', 'photos_a_refaire', 'demande_vendeur', 'correction', 'autre')),
  until_at TEXT,
  by_actor TEXT NOT NULL,
  at TEXT NOT NULL,
  CHECK (until_at IS NULL OR until_at > at),
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS diffusion_portal_suspensions_bien ON diffusion_portal_suspensions (property_id, portal, at);
CREATE TRIGGER IF NOT EXISTS diffusion_portal_suspensions_garde BEFORE DELETE ON diffusion_portal_suspensions BEGIN SELECT RAISE(ABORT, 'diffusion_portal_suspensions : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS diffusion_portal_suspensions_fige BEFORE UPDATE ON diffusion_portal_suspensions BEGIN SELECT RAISE(ABORT, 'diffusion_portal_suspensions : rien ne se réécrit'); END;

-- Un seul retrait en cours par bien et portail, gardé par la base [R472].
CREATE TRIGGER IF NOT EXISTS diffusion_portal_suspensions_un_seul
BEFORE INSERT ON diffusion_portal_suspensions
WHEN EXISTS (
  SELECT 1 FROM diffusion_portal_suspensions s
  WHERE s.property_id = NEW.property_id AND s.portal = NEW.portal AND (s.until_at IS NULL OR s.until_at > NEW.at)
    AND NOT EXISTS (SELECT 1 FROM diffusion_portal_resumptions r WHERE r.suspension_id = s.id)
)
BEGIN
  SELECT RAISE(ABORT, 'diffusion_portal_suspensions : un retrait est déjà en cours');
END;

CREATE TABLE IF NOT EXISTS diffusion_portal_resumptions (
  suspension_id TEXT PRIMARY KEY REFERENCES diffusion_portal_suspensions (id) ON DELETE RESTRICT,
  by_actor TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS diffusion_portal_resumptions_garde BEFORE DELETE ON diffusion_portal_resumptions BEGIN SELECT RAISE(ABORT, 'diffusion_portal_resumptions : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS diffusion_portal_resumptions_fige BEFORE UPDATE ON diffusion_portal_resumptions BEGIN SELECT RAISE(ABORT, 'diffusion_portal_resumptions : rien ne se réécrit'); END;

-- Ce que chaque portail répond pour une version publiée : rejet (son code, son texte) ou acceptation (l'adresse de
-- l'annonce en ligne, sur le domaine du portail) [R471, R473]. Une même réponse reçue deux fois n'est rangée qu'une fois.
CREATE TABLE IF NOT EXISTS diffusion_portal_feedback (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  portal TEXT NOT NULL,
  version_id TEXT NOT NULL REFERENCES listing_versions (id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('rejet', 'acceptee')),
  code TEXT,
  detail TEXT CHECK (detail IS NULL OR length(detail) BETWEEN 1 AND 300),
  online_url TEXT CHECK (online_url IS NULL OR (length(online_url) BETWEEN 12 AND 500 AND substr(online_url, 1, 8) = 'https://')),
  at TEXT NOT NULL,
  CHECK ((outcome = 'rejet') = (code IS NOT NULL)),
  CHECK ((outcome = 'acceptee') = (online_url IS NOT NULL)),
  CHECK (outcome = 'rejet' OR detail IS NULL),
  UNIQUE (version_id, portal, outcome, code),
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS diffusion_portal_feedback_une_acceptation ON diffusion_portal_feedback (version_id, portal) WHERE outcome = 'acceptee';
CREATE INDEX IF NOT EXISTS diffusion_portal_feedback_bien ON diffusion_portal_feedback (property_id, portal, at);
CREATE TRIGGER IF NOT EXISTS diffusion_portal_feedback_garde BEFORE DELETE ON diffusion_portal_feedback BEGIN SELECT RAISE(ABORT, 'diffusion_portal_feedback : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS diffusion_portal_feedback_fige BEFORE UPDATE ON diffusion_portal_feedback BEGIN SELECT RAISE(ABORT, 'diffusion_portal_feedback : rien ne se réécrit'); END;

-- Chaque relecture d'une annonce en ligne, comparée à la version publiée : conforme, écart (ce qui diffère),
-- introuvable, illisible, absente comme il se doit, ou encore en ligne alors qu'elle est retirée [R473, R474].
CREATE TABLE IF NOT EXISTS diffusion_portal_checks (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  portal TEXT NOT NULL,
  version_id TEXT NOT NULL REFERENCES listing_versions (id) ON DELETE RESTRICT,
  acceptance_id TEXT NOT NULL REFERENCES diffusion_portal_feedback (id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('conforme', 'retiree_absente', 'ecart', 'introuvable', 'illisible', 'toujours_en_ligne')),
  gaps TEXT NOT NULL CHECK (json_valid(gaps)),
  at TEXT NOT NULL,
  CHECK ((outcome IN ('conforme', 'retiree_absente')) = (gaps = '[]')),
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS diffusion_portal_checks_bien ON diffusion_portal_checks (property_id, portal, at);
CREATE TRIGGER IF NOT EXISTS diffusion_portal_checks_garde BEFORE DELETE ON diffusion_portal_checks BEGIN SELECT RAISE(ABORT, 'diffusion_portal_checks : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS diffusion_portal_checks_fige BEFORE UPDATE ON diffusion_portal_checks BEGIN SELECT RAISE(ABORT, 'diffusion_portal_checks : rien ne se réécrit'); END;

-- La tâche de correction de l'agent du bien : une seule ouverte par bien, portail et sorte (rejet ou écart) [R471].
CREATE TABLE IF NOT EXISTS diffusion_portal_tasks (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  portal TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('rejet', 'ecart')),
  agent_id TEXT,
  first_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS diffusion_portal_tasks_bien ON diffusion_portal_tasks (property_id, portal, kind);
CREATE TRIGGER IF NOT EXISTS diffusion_portal_tasks_garde BEFORE DELETE ON diffusion_portal_tasks BEGIN SELECT RAISE(ABORT, 'diffusion_portal_tasks : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS diffusion_portal_tasks_fige BEFORE UPDATE ON diffusion_portal_tasks BEGIN SELECT RAISE(ABORT, 'diffusion_portal_tasks : rien ne se réécrit'); END;

CREATE TABLE IF NOT EXISTS diffusion_portal_task_closures (
  task_id TEXT PRIMARY KEY REFERENCES diffusion_portal_tasks (id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (reason IN ('acceptee', 'conforme', 'portail_abandonne')),
  ref TEXT,
  at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS diffusion_portal_task_closures_garde BEFORE DELETE ON diffusion_portal_task_closures BEGIN SELECT RAISE(ABORT, 'diffusion_portal_task_closures : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS diffusion_portal_task_closures_fige BEFORE UPDATE ON diffusion_portal_task_closures BEGIN SELECT RAISE(ABORT, 'diffusion_portal_task_closures : rien ne se réécrit'); END;

-- Une seule tâche ouverte par bien, portail et sorte, même si deux rejets arrivent en même temps [R471].
CREATE TRIGGER IF NOT EXISTS diffusion_portal_tasks_une_ouverte
BEFORE INSERT ON diffusion_portal_tasks
WHEN EXISTS (
  SELECT 1 FROM diffusion_portal_tasks t
  WHERE t.property_id = NEW.property_id AND t.portal = NEW.portal AND t.kind = NEW.kind
    AND NOT EXISTS (SELECT 1 FROM diffusion_portal_task_closures c WHERE c.task_id = t.id)
)
BEGIN
  SELECT RAISE(ABORT, 'diffusion_portal_tasks : une tâche est déjà ouverte');
END;
