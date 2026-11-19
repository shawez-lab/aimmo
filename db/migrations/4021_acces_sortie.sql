-- AU111 · L'accès de sortie d'un agent parti : un lien à durée limitée, donné par la direction, qui ne montre que son
-- solde, ses pièces personnelles, son temps de formation et son relevé, jamais un client. Le lien n'est gardé que par
-- son empreinte ; rien ne s'efface ni ne se réécrit, un retrait se range à part [R16, R17].
CREATE TABLE IF NOT EXISTS agent_exit_accesses (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  expires_on TEXT NOT NULL CHECK (length(expires_on) = 10),
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS agent_exit_accesses_garde BEFORE DELETE ON agent_exit_accesses BEGIN SELECT RAISE(ABORT, 'agent_exit_accesses : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS agent_exit_accesses_fige BEFORE UPDATE ON agent_exit_accesses BEGIN SELECT RAISE(ABORT, 'agent_exit_accesses : rien ne se réécrit'); END;

CREATE TABLE IF NOT EXISTS agent_exit_access_revocations (
  access_id TEXT PRIMARY KEY REFERENCES agent_exit_accesses (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  revoked_by TEXT NOT NULL,
  revoked_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS agent_exit_access_revocations_garde BEFORE DELETE ON agent_exit_access_revocations BEGIN SELECT RAISE(ABORT, 'agent_exit_access_revocations : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS agent_exit_access_revocations_fige BEFORE UPDATE ON agent_exit_access_revocations BEGIN SELECT RAISE(ABORT, 'agent_exit_access_revocations : rien ne se réécrit'); END;
