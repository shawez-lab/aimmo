-- Q03 · Zones des agents par commune, et attribution des contacts par règles fixes, sans IA [R14, R25].
-- Rien n'est jamais effacé [R17] : une zone quittée garde sa ligne avec `ended_at`, une réattribution ajoute une ligne.
CREATE TABLE IF NOT EXISTS agent_zones (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  -- Commune, écrite comme dans la liste des communes (réglage).
  commune TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ended_at TEXT,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS agent_zones_commune ON agent_zones (network_id, commune, ended_at);

CREATE TABLE IF NOT EXISTS attributions (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  qualification_id TEXT REFERENCES qualifications (id) ON DELETE RESTRICT,
  -- NULL : la direction, quand aucune zone ne couvre la commune.
  agent_id TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('zone', 'already_followed', 'no_zone', 'reassigned')),
  -- Délai de rappel de la charte, en heures, à partir de `created_at`.
  callback_hours INTEGER NOT NULL CHECK (callback_hours > 0),
  -- Une seule attribution par qualification ; une réattribution désigne celle qu'elle remplace.
  replaces_id TEXT UNIQUE REFERENCES attributions (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE (qualification_id),
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS attributions_person ON attributions (network_id, person_id, created_at);

CREATE TRIGGER IF NOT EXISTS agent_zones_sans_effacement
BEFORE DELETE ON agent_zones
BEGIN
  SELECT RAISE(ABORT, 'agent_zones : rien ne s''efface');
END;

CREATE TRIGGER IF NOT EXISTS attributions_sans_effacement
BEFORE DELETE ON attributions
BEGIN
  SELECT RAISE(ABORT, 'attributions : rien ne s''efface');
END;
