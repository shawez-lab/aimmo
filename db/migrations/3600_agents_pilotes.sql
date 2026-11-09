-- HX69 · Les agents pilotes signent-ils plus qu'avant leur arrivée ? (Feuille de route, « Les phases et leurs
-- conditions », phase 3) [R640, R641, R642]. Tables nouvelles, en ajout seul : rien ne change ni ne s'efface [R17].

-- Un agent désigné pilote par la direction seule, une fois, jamais retiré.
CREATE TABLE IF NOT EXISTS pilot_agents (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  designated_by TEXT NOT NULL CHECK (designated_by LIKE 'direction:%'),
  designated_at TEXT NOT NULL,
  PRIMARY KEY (network_id, agent_id),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS pilot_agents_garde BEFORE DELETE ON pilot_agents BEGIN SELECT RAISE(ABORT, 'pilot_agents : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS pilot_agents_fige BEFORE UPDATE ON pilot_agents BEGIN SELECT RAISE(ABORT, 'pilot_agents : une désignation ne change plus'); END;

-- Les mandats signés par le pilote dans chacun des 3 mois de Paris qui précèdent son mois d'arrivée, dits par la
-- direction avec la référence de leur preuve (l'extrait de son ancien registre des mandats, rangé dans le stockage),
-- par versions qui se suivent [R640].
CREATE TABLE IF NOT EXISTS pilot_before_declarations (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  month_1 INTEGER NOT NULL CHECK (month_1 BETWEEN 0 AND 500),
  month_2 INTEGER NOT NULL CHECK (month_2 BETWEEN 0 AND 500),
  month_3 INTEGER NOT NULL CHECK (month_3 BETWEEN 0 AND 500),
  proof_ref TEXT NOT NULL CHECK (length(proof_ref) BETWEEN 3 AND 200),
  declared_by TEXT NOT NULL CHECK (declared_by LIKE 'direction:%'),
  declared_at TEXT NOT NULL,
  PRIMARY KEY (network_id, agent_id, version),
  FOREIGN KEY (network_id, agent_id) REFERENCES pilot_agents (network_id, agent_id) ON DELETE RESTRICT
);
-- Chaque version suit la précédente, sans trou [R640].
CREATE TRIGGER IF NOT EXISTS pilot_before_declarations_suite BEFORE INSERT ON pilot_before_declarations
WHEN NEW.version <> 1 + COALESCE((SELECT MAX(d.version) FROM pilot_before_declarations d WHERE d.network_id = NEW.network_id AND d.agent_id = NEW.agent_id), 0)
BEGIN SELECT RAISE(ABORT, 'pilot_before_declarations : version hors suite'); END;
CREATE TRIGGER IF NOT EXISTS pilot_before_declarations_garde BEFORE DELETE ON pilot_before_declarations BEGIN SELECT RAISE(ABORT, 'pilot_before_declarations : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS pilot_before_declarations_fige BEFORE UPDATE ON pilot_before_declarations BEGIN SELECT RAISE(ABORT, 'pilot_before_declarations : une déclaration ne change plus, une version s''ajoute'); END;
