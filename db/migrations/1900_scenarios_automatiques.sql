-- HX24 · Scénarios automatiques réglables, essayés avant d'être allumés. Uniquement des tables nouvelles, en ajout :
-- rien ne s'efface [R17]. Aucun texte ni aucune donnée de personne n'est écrit au journal [R13].

-- Chaque version d'un scénario, composée par la direction : un déclencheur, une attente, un message, une tâche [R403].
-- Une version ne change jamais : modifier un scénario en crée une nouvelle, qu'il faut essayer de nouveau [R400].
CREATE TABLE IF NOT EXISTS automation_scenarios (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  definition TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE INDEX IF NOT EXISTS automation_scenarios_network ON automation_scenarios (network_id, id);

CREATE TRIGGER IF NOT EXISTS automation_scenarios_sans_modification
BEFORE UPDATE ON automation_scenarios
BEGIN
  SELECT RAISE(ABORT, 'automation_scenarios en ajout seul');
END;

-- Chaque essai sur le passé : ce que la version aurait fait, sans rien envoyer ni ranger d'autre [R400].
CREATE TABLE IF NOT EXISTS automation_simulations (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  scenario_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  messages INTEGER NOT NULL CHECK (messages >= 0),
  reached INTEGER NOT NULL CHECK (reached >= 0),
  tasks INTEGER NOT NULL CHECK (tasks >= 0),
  refused TEXT NOT NULL,
  same_day_twice INTEGER NOT NULL CHECK (same_day_twice >= 0),
  -- Le nombre d'allumages du réseau vu par l'essai : un allumage venu depuis rend l'essai caduc [R400].
  lit_revision INTEGER NOT NULL CHECK (lit_revision >= 0),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (scenario_id, version) REFERENCES automation_scenarios (id, version) ON DELETE RESTRICT
);

CREATE TRIGGER IF NOT EXISTS automation_simulations_sans_modification
BEFORE UPDATE ON automation_simulations
BEGIN
  SELECT RAISE(ABORT, 'automation_simulations en ajout seul');
END;

-- Chaque allumage et chaque arrêt, gardés : l'état du scénario est la dernière ligne [R400].
CREATE TABLE IF NOT EXISTS automation_switches (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  scenario_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  lit INTEGER NOT NULL CHECK (lit IN (0, 1)),
  simulation_id TEXT REFERENCES automation_simulations (id) ON DELETE RESTRICT,
  at TEXT NOT NULL,
  seq INTEGER NOT NULL,
  by TEXT NOT NULL,
  CHECK (lit = 0 OR simulation_id IS NOT NULL),
  UNIQUE (scenario_id, seq),
  FOREIGN KEY (scenario_id, version) REFERENCES automation_scenarios (id, version) ON DELETE RESTRICT
);

CREATE TRIGGER IF NOT EXISTS automation_switches_sans_modification
BEFORE UPDATE ON automation_switches
BEGIN
  SELECT RAISE(ABORT, 'automation_switches en ajout seul');
END;

-- Un passage du scénario pour un fait déclencheur, une seule fois par fait [R18, R401].
CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  scenario_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  trigger_ref TEXT NOT NULL,
  person_id TEXT NOT NULL,
  triggered_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'a_faire' CHECK (status IN ('a_faire', 'en_cours', 'fait', 'annule')),
  message_status TEXT CHECK (message_status IN ('essai', 'refuse')),
  message_rule TEXT,
  message_id TEXT,
  task_id TEXT,
  done_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (scenario_id, trigger_ref),
  FOREIGN KEY (scenario_id, version) REFERENCES automation_scenarios (id, version) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS automation_runs_due ON automation_runs (network_id, status, due_at);

-- Un seul message de scénario par personne et par jour, tous scénarios confondus [R402].
CREATE TABLE IF NOT EXISTS automation_daily_messages (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  day TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES automation_runs (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (network_id, person_id, day)
);

-- Les tâches créées par un scénario, pour l'agent qui suit la fiche (sinon la direction).
CREATE TABLE IF NOT EXISTS automation_tasks (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL UNIQUE REFERENCES automation_runs (id) ON DELETE RESTRICT,
  agent_id TEXT,
  person_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  due_day TEXT NOT NULL,
  created_at TEXT NOT NULL,
  done_at TEXT,
  done_by TEXT
);
CREATE INDEX IF NOT EXISTS automation_tasks_agent ON automation_tasks (network_id, agent_id, done_at);
