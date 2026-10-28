-- J11 · Départ d'un agent (M14) [R86, R16, R17].
-- Le départ est rangé d'avance par la direction : date du préavis, jour du départ, motif codé (jamais un texte libre).
-- Le jour venu, l'agent passe à « parti », ses clients et ses biens vont à son successeur accepté ou à la file de la
-- direction ; chaque passage est rangé, rien n'est effacé [R17].
CREATE TABLE IF NOT EXISTS agent_departures (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  notice_given_on TEXT NOT NULL,
  leaves_on TEXT NOT NULL CHECK (leaves_on >= notice_given_on),
  reason TEXT NOT NULL CHECK (reason IN ('demission_agent', 'fin_par_reseau', 'accord_mutuel', 'faute_grave', 'age_maladie', 'cession_successeur')),
  -- Le préavis légal en mois, calculé par le code à la date du préavis (1, 2 ou 3).
  notice_months INTEGER NOT NULL CHECK (notice_months BETWEEN 1 AND 3),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  cancelled_at TEXT,
  cancelled_by TEXT,
  successor_agent_id TEXT,
  successor_status TEXT CHECK (successor_status IS NULL OR successor_status IN ('presente', 'accepte', 'refuse')),
  successor_decided_by TEXT,
  successor_decided_at TEXT,
  processed_at TEXT,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (successor_agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT,
  CHECK ((successor_agent_id IS NULL) = (successor_status IS NULL)),
  CHECK (successor_agent_id IS NULL OR successor_agent_id <> agent_id),
  CHECK (cancelled_at IS NULL OR processed_at IS NULL)
);
-- Un seul départ en vigueur par agent.
CREATE UNIQUE INDEX IF NOT EXISTS agent_departures_un ON agent_departures (agent_id) WHERE cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS agent_departures_jour ON agent_departures (network_id, leaves_on);
CREATE TRIGGER IF NOT EXISTS agent_departures_garde BEFORE DELETE ON agent_departures BEGIN SELECT RAISE(ABORT, 'agent_departures : rien ne s''efface'); END;
-- Ce qui a été rangé ne change plus : seuls l'annulation, le successeur et le passage du jour s'ajoutent.
CREATE TRIGGER IF NOT EXISTS agent_departures_fige BEFORE UPDATE ON agent_departures
WHEN OLD.id IS NOT NEW.id OR OLD.network_id IS NOT NEW.network_id OR OLD.agent_id IS NOT NEW.agent_id
  OR OLD.notice_given_on IS NOT NEW.notice_given_on OR OLD.leaves_on IS NOT NEW.leaves_on OR OLD.reason IS NOT NEW.reason
  OR OLD.notice_months IS NOT NEW.notice_months OR OLD.created_by IS NOT NEW.created_by OR OLD.created_at IS NOT NEW.created_at
  OR (OLD.cancelled_at IS NOT NULL AND (OLD.cancelled_at IS NOT NEW.cancelled_at OR OLD.cancelled_by IS NOT NEW.cancelled_by))
  OR (OLD.processed_at IS NOT NULL AND (OLD.processed_at IS NOT NEW.processed_at OR OLD.cancelled_at IS NOT NEW.cancelled_at
    OR OLD.successor_agent_id IS NOT NEW.successor_agent_id OR OLD.successor_status IS NOT NEW.successor_status))
  OR (OLD.successor_status IN ('accepte', 'refuse') AND (OLD.successor_agent_id IS NOT NEW.successor_agent_id OR OLD.successor_status IS NOT NEW.successor_status))
BEGIN SELECT RAISE(ABORT, 'agent_departures : un départ rangé ne change plus'); END;

-- Chaque client, chaque bien et chaque projet qui quitte l'agent parti : d'où il vient, où il va (NULL : la file de la direction).
CREATE TABLE IF NOT EXISTS agent_departure_handovers (
  departure_id TEXT NOT NULL REFERENCES agent_departures (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('person', 'property', 'project')),
  subject_id TEXT NOT NULL,
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (departure_id, kind, subject_id)
);
CREATE INDEX IF NOT EXISTS agent_departure_handovers_file ON agent_departure_handovers (network_id, to_agent_id, kind);
CREATE TRIGGER IF NOT EXISTS agent_departure_handovers_garde BEFORE DELETE ON agent_departure_handovers BEGIN SELECT RAISE(ABORT, 'agent_departure_handovers : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS agent_departure_handovers_fige BEFORE UPDATE ON agent_departure_handovers BEGIN SELECT RAISE(ABORT, 'agent_departure_handovers : un passage rangé ne change plus'); END;

-- La direction réattribue ensuite ce qui est dans sa file, une fois par client ou par bien et par départ.
CREATE TABLE IF NOT EXISTS agent_departure_reassignments (
  departure_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('person', 'property', 'project')),
  subject_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  to_agent_id TEXT NOT NULL,
  by TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (departure_id, kind, subject_id),
  FOREIGN KEY (departure_id, kind, subject_id) REFERENCES agent_departure_handovers (departure_id, kind, subject_id) ON DELETE RESTRICT,
  FOREIGN KEY (to_agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS agent_departure_reassignments_garde BEFORE DELETE ON agent_departure_reassignments BEGIN SELECT RAISE(ABORT, 'agent_departure_reassignments : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS agent_departure_reassignments_fige BEFORE UPDATE ON agent_departure_reassignments BEGIN SELECT RAISE(ABORT, 'agent_departure_reassignments : une réattribution rangée ne change plus'); END;
