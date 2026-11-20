-- AU030 · Les biens repris d'un agent gardent leur dossier : photos, diagnostics, mandats signés, diffusion (M14, J05)
-- [R84, R13, R16, R18].
-- Un export « dossier des biens » (Hektor, Apimo, Excel, Google) liste, pièce par pièce, ce que l'ancien logiciel
-- garde pour chaque bien : le nom du fichier, son lien, sa date, et pour un mandat s'il est signé. Chaque pièce rejoint
-- seulement un bien repris par le même agent, depuis le même logiciel. Une pièce sans bien de l'agent n'est jamais
-- rangée : elle est comptée au bilan, avec son numéro de ligne et sa raison, avant comme après la validation.
-- Rien ne s'efface ni ne change. Rien n'est publié : une annonce de l'ancien logiciel reste un lien, le bien reste en
-- brouillon.
CREATE TABLE IF NOT EXISTS agent_import_property_pieces (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  origin_key TEXT NOT NULL CHECK (length(origin_key) BETWEEN 1 AND 200),
  agent_id TEXT NOT NULL,
  property_id TEXT NOT NULL REFERENCES properties (id) ON DELETE RESTRICT,
  category TEXT NOT NULL CHECK (category IN ('photo', 'diagnostic', 'mandate', 'diffusion', 'document')),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  file_name TEXT CHECK (file_name IS NULL OR length(file_name) BETWEEN 1 AND 200),
  link_url TEXT CHECK (link_url IS NULL OR (length(link_url) BETWEEN 9 AND 500 AND substr(link_url, 1, 8) = 'https://')),
  dated_on TEXT CHECK (dated_on IS NULL OR length(dated_on) = 10),
  -- Pour un mandat seulement : 1 signé, 0 non signé, NULL non dit. Rien n'est deviné.
  signed INTEGER CHECK (signed IS NULL OR (category = 'mandate' AND signed IN (0, 1))),
  portal TEXT CHECK (portal IS NULL OR (category = 'diffusion' AND length(portal) BETWEEN 1 AND 80)),
  source_format TEXT NOT NULL CHECK (source_format IN ('hektor', 'apimo', 'excel', 'google')),
  export_line INTEGER NOT NULL CHECK (export_line >= 2),
  created_at TEXT NOT NULL,
  PRIMARY KEY (network_id, origin_key),
  CHECK (file_name IS NOT NULL OR link_url IS NOT NULL),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS agent_import_property_pieces_property ON agent_import_property_pieces (property_id, category, export_line);
CREATE TRIGGER IF NOT EXISTS agent_import_property_pieces_garde BEFORE DELETE ON agent_import_property_pieces BEGIN SELECT RAISE(ABORT, 'agent_import_property_pieces : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS agent_import_property_pieces_fige BEFORE UPDATE ON agent_import_property_pieces BEGIN SELECT RAISE(ABORT, 'agent_import_property_pieces : une pièce reprise ne change plus'); END;
