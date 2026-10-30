-- AT04 · Référencement : sites publics, page de référence unique, signalement aux moteurs [R153, R26].
-- Les sites sont réglés par la direction : le site du réseau, et le site d'un agent quand il en a un. Chaque réglage
-- s'ajoute, le dernier compte ; rien ne s'efface ni ne se réécrit [R17].
CREATE TABLE IF NOT EXISTS public_sites (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('reseau', 'agent')),
  agent_id TEXT,
  -- L'origine https du site, sans chemin : `https://exemple.test`.
  base_url TEXT NOT NULL CHECK (length(base_url) BETWEEN 9 AND 200),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  CHECK ((kind = 'reseau') = (agent_id IS NULL)),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS public_sites_latest ON public_sites (network_id, kind, agent_id, set_at);
CREATE TRIGGER IF NOT EXISTS public_sites_garde BEFORE DELETE ON public_sites BEGIN SELECT RAISE(ABORT, 'public_sites : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS public_sites_fige BEFORE UPDATE ON public_sites BEGIN SELECT RAISE(ABORT, 'public_sites : rien ne se réécrit'); END;

-- Chaque page signalée aux moteurs (IndexNow), avec son état et l'empreinte de ce qui a été signalé. En mode essai,
-- rien ne part : la ligne dit « essai » [R26]. Un échec est rangé, et la page est signalée de nouveau au passage suivant.
CREATE TABLE IF NOT EXISTS seo_signals (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  url TEXT NOT NULL CHECK (length(url) BETWEEN 9 AND 400),
  change TEXT NOT NULL CHECK (change IN ('publiee', 'modifiee', 'retiree')),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  mode TEXT NOT NULL CHECK (mode IN ('essai', 'reel')),
  outcome TEXT NOT NULL CHECK (outcome IN ('essai', 'ok', 'echec')),
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS seo_signals_url ON seo_signals (network_id, url, at);
CREATE TRIGGER IF NOT EXISTS seo_signals_garde BEFORE DELETE ON seo_signals BEGIN SELECT RAISE(ABORT, 'seo_signals : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS seo_signals_fige BEFORE UPDATE ON seo_signals BEGIN SELECT RAISE(ABORT, 'seo_signals : rien ne se réécrit'); END;
