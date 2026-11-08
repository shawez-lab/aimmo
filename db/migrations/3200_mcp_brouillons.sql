-- HX55 · Serveur MCP et API ouverte (Intégrations) [R590, R591].

-- Brouillons écrits par l'assistant de l'agent (ChatGPT, Claude) par le serveur MCP. Un outil n'écrit jamais rien de
-- définitif : il range un brouillon « à valider », et seul l'agent lui-même le valide ou le refuse, depuis
-- l'application, jamais par le serveur MCP [R591]. Un brouillon ne s'efface pas ; son contenu ne change jamais, et une
-- décision prise ne change plus [R17].
CREATE TABLE IF NOT EXISTS mcp_drafts (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('note', 'prix')),
  -- `person:<id>` pour une note, `property:<id>` pour un prix.
  subject TEXT NOT NULL CHECK ((kind = 'note' AND subject GLOB 'person:?*') OR (kind = 'prix' AND subject GLOB 'property:?*')),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  status TEXT NOT NULL DEFAULT 'a_valider' CHECK (status IN ('a_valider', 'valide', 'refuse')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  CHECK ((status = 'a_valider') = (decided_at IS NULL)),
  CHECK ((status = 'a_valider') = (decided_by IS NULL)),
  -- Seul l'agent du brouillon décide [R591].
  CHECK (decided_by IS NULL OR decided_by = agent_id),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS mcp_drafts_agent ON mcp_drafts (network_id, agent_id, created_at);
-- Un brouillon naît « à valider » : rien de définitif ne s'écrit d'un coup [R591]. Un identifiant déjà pris est refusé :
-- `INSERT OR REPLACE` effacerait la ligne sans passer par la garde ci-dessous.
CREATE TRIGGER IF NOT EXISTS mcp_drafts_naissance BEFORE INSERT ON mcp_drafts
WHEN NEW.status <> 'a_valider' OR EXISTS (SELECT 1 FROM mcp_drafts WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'mcp_drafts : un brouillon naît à valider, une seule fois [R591]'); END;
CREATE TRIGGER IF NOT EXISTS mcp_drafts_garde BEFORE DELETE ON mcp_drafts
BEGIN SELECT RAISE(ABORT, 'mcp_drafts : rien ne s''efface'); END;
-- Seule la décision change, une fois : ni le contenu, ni l'agent, ni le sujet.
CREATE TRIGGER IF NOT EXISTS mcp_drafts_fige BEFORE UPDATE ON mcp_drafts
WHEN OLD.status <> 'a_valider' OR NEW.status = 'a_valider' OR NEW.id IS NOT OLD.id OR NEW.network_id IS NOT OLD.network_id
  OR NEW.agent_id IS NOT OLD.agent_id OR NEW.kind IS NOT OLD.kind OR NEW.subject IS NOT OLD.subject
  OR NEW.payload IS NOT OLD.payload OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'mcp_drafts : un brouillon ne change plus, seule une décision s''y ajoute [R591]'); END;
