-- AU041 · La capacité déclarée de chaque agent : combien de nouveaux contacts il peut avoir en attente de rappel en
-- même temps (M03 ; audit A041) [R681]. Tables nouvelles, en ajout seul : rien ne change ni ne s'efface [R17].

-- Une capacité par versions : la plus haute vaut. NULL : sans plafond déclaré ; 0 : aucun nouveau contact.
-- Déclarée par l'agent pour lui-même ou par la direction, toujours avec une raison. Aucune personne n'y figure.
CREATE TABLE IF NOT EXISTS agent_capacities (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  capacity INTEGER CHECK (capacity IS NULL OR (capacity BETWEEN 0 AND 200)),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 200),
  decided_by TEXT NOT NULL CHECK (decided_by LIKE 'direction:%' OR decided_by = 'agent:' || agent_id),
  decided_at TEXT NOT NULL,
  PRIMARY KEY (network_id, agent_id, version),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS agent_capacities_suite BEFORE INSERT ON agent_capacities
WHEN NEW.version <> 1 + COALESCE((SELECT MAX(c.version) FROM agent_capacities c WHERE c.network_id = NEW.network_id AND c.agent_id = NEW.agent_id), 0)
BEGIN SELECT RAISE(ABORT, 'agent_capacities : version hors suite'); END;
CREATE TRIGGER IF NOT EXISTS agent_capacities_garde BEFORE DELETE ON agent_capacities BEGIN SELECT RAISE(ABORT, 'agent_capacities : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS agent_capacities_fige BEFORE UPDATE ON agent_capacities BEGIN SELECT RAISE(ABORT, 'agent_capacities : une version ne change plus, une autre s''ajoute'); END;

-- La trace d'une attribution où la capacité a changé le choix : combien d'agents de la commune étaient pleins
-- (le tirage est passé au suivant dans l'ordre fixe, ou le contact est allé à la direction). Rien de personnel.
CREATE TABLE IF NOT EXISTS attribution_capacity (
  attribution_id TEXT PRIMARY KEY REFERENCES attributions (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  full_agents INTEGER NOT NULL CHECK (full_agents >= 1),
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS attribution_capacity_garde BEFORE DELETE ON attribution_capacity BEGIN SELECT RAISE(ABORT, 'attribution_capacity : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS attribution_capacity_fige BEFORE UPDATE ON attribution_capacity BEGIN SELECT RAISE(ABORT, 'attribution_capacity : rien ne change'); END;
