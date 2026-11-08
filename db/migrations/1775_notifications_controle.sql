-- SV15 · Les notifications aux agents passent par le contrôle central. Tables nouvelles, en ajout seul : rien ne
-- s'efface [R17]. Ni texte, ni nom, ni coordonnée : l'envoi est connu par son identifiant seul [R13, R415].

-- Un envoi au téléphone d'un agent, réservé par son identifiant avant l'appel au service : il ne part qu'une fois
-- [R05, R225]. `outcome` reste vide tant que le service n'a pas répondu ; il se pose une seule fois.
CREATE TABLE IF NOT EXISTS agent_push_sends (
  push_id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode = 'essai'),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('ok', 'aucun_appareil', 'echec')),
  reserved_at TEXT NOT NULL,
  done_at TEXT,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS agent_push_sends_sans_effacement BEFORE DELETE ON agent_push_sends
BEGIN
  SELECT RAISE(ABORT, 'agent_push_sends : rien ne s''efface');
END;
CREATE TRIGGER IF NOT EXISTS agent_push_sends_fige BEFORE UPDATE ON agent_push_sends
WHEN OLD.outcome IS NOT NULL OR NEW.push_id IS NOT OLD.push_id OR NEW.network_id IS NOT OLD.network_id OR NEW.agent_id IS NOT OLD.agent_id
  OR NEW.mode IS NOT OLD.mode OR NEW.reserved_at IS NOT OLD.reserved_at
BEGIN
  SELECT RAISE(ABORT, 'agent_push_sends : un envoi réservé ne change que par sa réponse, une fois');
END;

-- Chaque décision du contrôle sur un envoi à un agent, partie ou refusée, avec sa règle, sans donnée [R13].
CREATE TABLE IF NOT EXISTS agent_push_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  network_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  push_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'aucun_appareil', 'echec', 'refuse')),
  rule TEXT,
  reason TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode = 'essai'),
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_push_log_push ON agent_push_log (push_id, id);
CREATE TRIGGER IF NOT EXISTS agent_push_log_sans_effacement BEFORE DELETE ON agent_push_log
BEGIN
  SELECT RAISE(ABORT, 'agent_push_log : rien ne s''efface');
END;
CREATE TRIGGER IF NOT EXISTS agent_push_log_fige BEFORE UPDATE ON agent_push_log
BEGIN
  SELECT RAISE(ABORT, 'agent_push_log : une décision rangée ne change plus');
END;

-- La boîte d'essai des notifications : ce qui aurait pu partir vers un téléphone, rangé, jamais envoyé [R26].
CREATE TABLE IF NOT EXISTS agent_push_trial_outbox (
  push_id TEXT PRIMARY KEY REFERENCES agent_push_sends (push_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS agent_push_trial_outbox_sans_effacement BEFORE DELETE ON agent_push_trial_outbox
BEGIN
  SELECT RAISE(ABORT, 'agent_push_trial_outbox : rien ne s''efface');
END;
