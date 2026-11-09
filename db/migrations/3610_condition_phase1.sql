-- HX70 · 30 jours sans aucun envoi hors règles, et plus aucune tâche du système planifiée dans les applications : la
-- condition de la phase 1 (Feuille de route, « Les phases et leurs conditions ») [R643, R644, R645]. Tables nouvelles,
-- en ajout seul : rien ne change ni ne s'efface [R17]. Aucune donnée personnelle : des jours, des nombres, une
-- application et une référence de preuve ; qui a rangé est au journal.

-- Le relevé figé d'un jour de Paris fini, un seul par jour : ce que la base disait ce jour-là, compté le lendemain ou
-- plus tard, jamais réécrit [R643].
CREATE TABLE IF NOT EXISTS phase1_day_readings (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  day TEXT NOT NULL CHECK (length(day) = 10),
  taken_at TEXT NOT NULL,
  -- Passages du planificateur du socle ce jour-là : à zéro, le socle n'a rien regardé, le jour est « sans donnée ».
  planner_runs INTEGER NOT NULL CHECK (planner_runs >= 0),
  sent INTEGER NOT NULL CHECK (sent >= 0),
  refused INTEGER NOT NULL CHECK (refused >= 0),
  without_control INTEGER NOT NULL CHECK (without_control >= 0),
  while_excluded INTEGER NOT NULL CHECK (while_excluded >= 0),
  site_gaps INTEGER NOT NULL CHECK (site_gaps >= 0),
  site_failures INTEGER NOT NULL CHECK (site_failures >= 0),
  outside INTEGER NOT NULL CHECK (outside >= 0),
  PRIMARY KEY (network_id, day)
);
CREATE TRIGGER IF NOT EXISTS phase1_day_readings_garde BEFORE DELETE ON phase1_day_readings BEGIN SELECT RAISE(ABORT, 'phase1_day_readings : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS phase1_day_readings_fige BEFORE UPDATE ON phase1_day_readings BEGIN SELECT RAISE(ABORT, 'phase1_day_readings : un relevé ne change plus'); END;

-- Un envoi hors règles constaté hors d'AIMMO (une application qui envoie encore seule), rangé par la direction avec la
-- référence de sa preuve. Jamais retiré : il ne peut que rendre un jour moins propre [R644].
CREATE TABLE IF NOT EXISTS phase1_outside_sends (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  day TEXT NOT NULL CHECK (length(day) = 10),
  application TEXT NOT NULL CHECK (application IN ('gohighlevel', 'manychat', 'site', 'github_actions', 'autre')),
  proof_ref TEXT NOT NULL CHECK (length(proof_ref) BETWEEN 3 AND 200),
  declared_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS phase1_outside_sends_day ON phase1_outside_sends (network_id, day);
CREATE TRIGGER IF NOT EXISTS phase1_outside_sends_garde BEFORE DELETE ON phase1_outside_sends BEGIN SELECT RAISE(ABORT, 'phase1_outside_sends : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS phase1_outside_sends_fige BEFORE UPDATE ON phase1_outside_sends BEGIN SELECT RAISE(ABORT, 'phase1_outside_sends : un envoi constaté ne change plus'); END;

-- Les tâches du système encore planifiées dans chaque application, dites par la direction avec la référence de leur
-- preuve (capture de la liste des automatisations), par versions qui se suivent [R644].
CREATE TABLE IF NOT EXISTS phase1_app_inventories (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  gohighlevel INTEGER NOT NULL CHECK (gohighlevel BETWEEN 0 AND 1000),
  manychat INTEGER NOT NULL CHECK (manychat BETWEEN 0 AND 1000),
  site INTEGER NOT NULL CHECK (site BETWEEN 0 AND 1000),
  github_actions INTEGER NOT NULL CHECK (github_actions BETWEEN 0 AND 1000),
  autre INTEGER NOT NULL CHECK (autre BETWEEN 0 AND 1000),
  proof_ref TEXT NOT NULL CHECK (length(proof_ref) BETWEEN 3 AND 200),
  declared_at TEXT NOT NULL,
  PRIMARY KEY (network_id, version)
);
CREATE TRIGGER IF NOT EXISTS phase1_app_inventories_suite BEFORE INSERT ON phase1_app_inventories
WHEN NEW.version <> 1 + COALESCE((SELECT MAX(i.version) FROM phase1_app_inventories i WHERE i.network_id = NEW.network_id), 0)
BEGIN SELECT RAISE(ABORT, 'phase1_app_inventories : version hors suite'); END;
CREATE TRIGGER IF NOT EXISTS phase1_app_inventories_garde BEFORE DELETE ON phase1_app_inventories BEGIN SELECT RAISE(ABORT, 'phase1_app_inventories : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS phase1_app_inventories_fige BEFORE UPDATE ON phase1_app_inventories BEGIN SELECT RAISE(ABORT, 'phase1_app_inventories : un inventaire ne change plus, une version s''ajoute'); END;
