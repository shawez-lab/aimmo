-- I05 · Lancer la reprise sur les vraies bases. Uniquement des tables nouvelles. Rien n'est jamais effacé [R17].

-- Les fichiers de H15, déposés par la direction depuis l'application : jamais dans le dépôt, jamais dans un journal.
-- Un nouveau dépôt s'ajoute, l'ancien reste : la reprise prend le dernier de chaque sorte.
CREATE TABLE IF NOT EXISTS reprise_depots (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  tool TEXT NOT NULL CHECK (tool IN ('exclusion_list', 'gohighlevel', 'manychat')),
  -- L'agent à qui les fiches reprises sont confiées.
  agent_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  lines INTEGER NOT NULL,
  parts INTEGER NOT NULL CHECK (parts >= 1),
  deposited_by TEXT NOT NULL,
  deposited_at TEXT NOT NULL,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS reprise_depots_dernier ON reprise_depots (network_id, tool, deposited_at);

-- Le texte d'un dépôt, en morceaux : une ligne de D1 a une taille limitée.
CREATE TABLE IF NOT EXISTS reprise_depot_morceaux (
  depot_id TEXT NOT NULL REFERENCES reprise_depots (id) ON DELETE RESTRICT,
  rank INTEGER NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY (depot_id, rank)
);

CREATE TRIGGER IF NOT EXISTS reprise_depots_sans_modification BEFORE UPDATE ON reprise_depots
BEGIN SELECT RAISE(ABORT, 'reprise_depots en ajout seul'); END;
CREATE TRIGGER IF NOT EXISTS reprise_depots_sans_effacement BEFORE DELETE ON reprise_depots
BEGIN SELECT RAISE(ABORT, 'reprise_depots en ajout seul'); END;
CREATE TRIGGER IF NOT EXISTS reprise_depot_morceaux_sans_modification BEFORE UPDATE ON reprise_depot_morceaux
BEGIN SELECT RAISE(ABORT, 'reprise_depot_morceaux en ajout seul'); END;
CREATE TRIGGER IF NOT EXISTS reprise_depot_morceaux_sans_effacement BEFORE DELETE ON reprise_depot_morceaux
BEGIN SELECT RAISE(ABORT, 'reprise_depot_morceaux en ajout seul'); END;

-- Où en est le lancement, par réseau : la source et la position du prochain morceau, et les totaux déjà faits
-- (seulement des nombres [R13]). L'empreinte dit sur quels fichiers et quelle lecture du site il porte : si elle
-- change, la reprise repart du début, ce qui ne double rien.
CREATE TABLE IF NOT EXISTS reprise_avancement (
  network_id TEXT PRIMARY KEY REFERENCES networks (id) ON DELETE RESTRICT,
  fingerprint TEXT NOT NULL,
  source TEXT NOT NULL,
  position INTEGER NOT NULL,
  totals TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  done_at TEXT
);
CREATE TRIGGER IF NOT EXISTS reprise_avancement_sans_effacement BEFORE DELETE ON reprise_avancement
BEGIN SELECT RAISE(ABORT, 'reprise_avancement sans effacement'); END;
