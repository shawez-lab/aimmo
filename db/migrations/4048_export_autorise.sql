-- AU110 · L'export de reprise d'un agent, autorisé par la direction au vu d'un contrat : son périmètre (les fiches de
-- ses clients, et leurs pièces s'il le dit), la référence du contrat, et sa durée. Rien ne s'efface ni ne se réécrit [R16, R17].
CREATE TABLE IF NOT EXISTS agent_export_authorizations (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('clients', 'clients_pieces')),
  contract_ref TEXT NOT NULL CHECK (length(contract_ref) BETWEEN 1 AND 200),
  expires_on TEXT NOT NULL CHECK (length(expires_on) = 10),
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS agent_export_authorizations_garde BEFORE DELETE ON agent_export_authorizations BEGIN SELECT RAISE(ABORT, 'agent_export_authorizations : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS agent_export_authorizations_fige BEFORE UPDATE ON agent_export_authorizations BEGIN SELECT RAISE(ABORT, 'agent_export_authorizations : rien ne se réécrit'); END;
