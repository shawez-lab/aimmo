-- G04 · Suivi de valeur : un propriétaire qui l'a demandé, avec son accord pour ce suivi, reçoit à intervalle réglé la
-- fourchette de sa commune, jamais le prix de son bien [R31], par le contrôle central des envois ; en mode essai, rien
-- ne part [R26]. Quand il répond qu'il pense à vendre, son agent est alerté. Rien ne s'efface [R17].
CREATE TABLE IF NOT EXISTS value_tracking (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT,
  -- Une seule inscription par fiche.
  person_id TEXT NOT NULL UNIQUE,
  postal_code TEXT NOT NULL,
  town TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('apartment', 'house')),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);

-- Un envoi par période au plus [R05]. `pending` pendant le passage, `waiting` refusé pour l'heure [R01] et repris,
-- `sent` passé par le contrôle (en essai : rangé, jamais envoyé), `refused` refusé par une règle, `failed` panne,
-- `no_data` pas de fourchette de commune ce jour-là.
CREATE TABLE IF NOT EXISTS value_tracking_sends (
  tracking_id TEXT NOT NULL REFERENCES value_tracking (id) ON DELETE RESTRICT,
  period INTEGER NOT NULL CHECK (period >= 1),
  status TEXT NOT NULL CHECK (status IN ('pending', 'waiting', 'sent', 'refused', 'failed', 'no_data')),
  rule TEXT,
  message_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('essai')),
  sent_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tracking_id, period)
);

-- L'alerte de l'agent : le propriétaire a répondu qu'il pense à vendre. Une par message reçu.
CREATE TABLE IF NOT EXISTS value_tracking_alerts (
  id TEXT PRIMARY KEY,
  tracking_id TEXT NOT NULL REFERENCES value_tracking (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  seen_at TEXT,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS value_tracking_alerts_person ON value_tracking_alerts (person_id, created_at);

CREATE TRIGGER IF NOT EXISTS value_tracking_sans_effacement
BEFORE DELETE ON value_tracking
BEGIN
  SELECT RAISE(ABORT, 'value_tracking : rien ne s''efface');
END;

CREATE TRIGGER IF NOT EXISTS value_tracking_sends_sans_effacement
BEFORE DELETE ON value_tracking_sends
BEGIN
  SELECT RAISE(ABORT, 'value_tracking_sends : rien ne s''efface');
END;

CREATE TRIGGER IF NOT EXISTS value_tracking_alerts_sans_effacement
BEFORE DELETE ON value_tracking_alerts
BEGIN
  SELECT RAISE(ABORT, 'value_tracking_alerts : rien ne s''efface');
END;
