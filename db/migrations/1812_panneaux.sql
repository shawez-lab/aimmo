-- HX14 · Stock de panneaux. Tables nouvelles, en ajout seul : rien ne change ni ne s'efface [R17].
-- L'adresse d'une pose n'est lue que par l'agent du bien et la direction ; jamais au journal [R13, R284].

-- Un panneau du stock du réseau, rangé par la direction, avec un numéro donné par le code, unique dans le réseau, et
-- un format d'une liste fermée [R282].
CREATE TABLE IF NOT EXISTS signs (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  number INTEGER NOT NULL CHECK (number >= 1),
  size TEXT NOT NULL CHECK (size IN ('grand', 'moyen', 'petit')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (network_id, number),
  UNIQUE (id, network_id)
);
CREATE TRIGGER IF NOT EXISTS signs_fige BEFORE UPDATE ON signs BEGIN SELECT RAISE(ABORT, 'signs : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS signs_garde BEFORE DELETE ON signs BEGIN SELECT RAISE(ABORT, 'signs : rien ne s''efface'); END;

-- Une pose : tel panneau, sur tel bien, à telle adresse (code postal et commune du bien), par qui, quand [R282]. Tant
-- qu'elle n'a pas de retrait, le panneau est posé.
CREATE TABLE IF NOT EXISTS sign_placements (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  sign_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  -- L'agent du bien au moment de la pose : celui qui le récupérera.
  agent_id TEXT NOT NULL,
  -- Le mandat qui permettait la diffusion au moment de la pose [R42].
  mandate_id TEXT NOT NULL,
  street_number TEXT NOT NULL CHECK (length(trim(street_number)) BETWEEN 1 AND 12),
  street TEXT NOT NULL CHECK (length(trim(street)) BETWEEN 3 AND 80),
  postcode TEXT NOT NULL CHECK (length(postcode) = 5),
  city TEXT NOT NULL CHECK (length(trim(city)) BETWEEN 1 AND 80),
  placed_by TEXT NOT NULL,
  placed_at TEXT NOT NULL,
  UNIQUE (id, network_id),
  FOREIGN KEY (sign_id, network_id) REFERENCES signs (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS sign_placements_sign ON sign_placements (sign_id, placed_at);
CREATE INDEX IF NOT EXISTS sign_placements_agent ON sign_placements (network_id, agent_id);
CREATE TRIGGER IF NOT EXISTS sign_placements_fige BEFORE UPDATE ON sign_placements BEGIN SELECT RAISE(ABORT, 'sign_placements : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS sign_placements_garde BEFORE DELETE ON sign_placements BEGIN SELECT RAISE(ABORT, 'sign_placements : rien ne s''efface'); END;

-- Le retrait d'une pose : récupéré (le panneau revient au stock) ou perdu (il n'en sort plus) [R283].
CREATE TABLE IF NOT EXISTS sign_removals (
  placement_id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('recupere', 'perdu')),
  removed_by TEXT NOT NULL,
  removed_at TEXT NOT NULL,
  FOREIGN KEY (placement_id, network_id) REFERENCES sign_placements (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS sign_removals_fige BEFORE UPDATE ON sign_removals BEGIN SELECT RAISE(ABORT, 'sign_removals : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS sign_removals_garde BEFORE DELETE ON sign_removals BEGIN SELECT RAISE(ABORT, 'sign_removals : rien ne s''efface'); END;

-- Un panneau n'est posé qu'à un endroit à la fois, et un panneau perdu ne se pose plus, même demandé deux fois en même
-- temps [R282].
CREATE TRIGGER IF NOT EXISTS sign_placements_un_seul
BEFORE INSERT ON sign_placements
WHEN EXISTS (SELECT 1 FROM sign_placements p WHERE p.sign_id = NEW.sign_id AND NOT EXISTS (SELECT 1 FROM sign_removals r WHERE r.placement_id = p.id))
  OR EXISTS (SELECT 1 FROM sign_placements p JOIN sign_removals r ON r.placement_id = p.id WHERE p.sign_id = NEW.sign_id AND r.outcome = 'perdu')
BEGIN
  SELECT RAISE(ABORT, 'sign_placements : panneau déjà posé ou perdu');
END;

-- La tâche « récupérer le panneau », rangée seule pour l'agent de la pose quand le bien est vendu ou ne peut plus être
-- diffusé ; une seule par pose [R283]. Elle est faite quand la pose a son retrait.
CREATE TABLE IF NOT EXISTS sign_pickup_tasks (
  placement_id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('vendu', 'fin_mandat')),
  -- La raison de la porte de diffusion, quand c'est la fin du mandat (échu, rétracté, annulé…).
  detail TEXT CHECK (detail IS NULL OR length(detail) BETWEEN 1 AND 40),
  due_day TEXT NOT NULL CHECK (length(due_day) = 10),
  created_at TEXT NOT NULL,
  CHECK ((reason = 'fin_mandat') = (detail IS NOT NULL)),
  FOREIGN KEY (placement_id, network_id) REFERENCES sign_placements (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS sign_pickup_tasks_agent ON sign_pickup_tasks (network_id, agent_id, due_day);
CREATE TRIGGER IF NOT EXISTS sign_pickup_tasks_fige BEFORE UPDATE ON sign_pickup_tasks BEGIN SELECT RAISE(ABORT, 'sign_pickup_tasks : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS sign_pickup_tasks_garde BEFORE DELETE ON sign_pickup_tasks BEGIN SELECT RAISE(ABORT, 'sign_pickup_tasks : rien ne s''efface'); END;
