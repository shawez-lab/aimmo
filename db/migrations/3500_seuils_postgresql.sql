-- HX66 · Les seuils du passage à PostgreSQL (Architecture technique, « Données » et « Exigences de service » ;
-- Feuille de route, phase 4) [R630, R631, R632]. Tables nouvelles, en ajout seul : rien ne change ni ne s'efface [R17].
-- Aucune donnée personnelle : des nombres, des dates et une sorte de geste ; qui a relevé ou décidé est au journal.

-- Chaque relevé des trois seuils. Une mesure absente ou en échec reste NULL : elle est « inconnue », jamais « sous le
-- seuil » [R630].
CREATE TABLE IF NOT EXISTS postgres_threshold_readings (
  id TEXT PRIMARY KEY,
  -- L'ordre des relevés, qui se suit sans trou : deux relevés du même instant restent dans leur ordre [R630].
  seq INTEGER NOT NULL UNIQUE CHECK (seq >= 1),
  measured_at TEXT NOT NULL,
  agents_active INTEGER CHECK (agents_active IS NULL OR agents_active >= 0),
  db_bytes INTEGER CHECK (db_bytes IS NULL OR db_bytes >= 0),
  report_ms INTEGER CHECK (report_ms IS NULL OR report_ms >= 0),
  source TEXT NOT NULL CHECK (source IN ('direction', 'passage'))
);
CREATE INDEX IF NOT EXISTS postgres_threshold_readings_at ON postgres_threshold_readings (measured_at);
CREATE TRIGGER IF NOT EXISTS postgres_threshold_readings_suite BEFORE INSERT ON postgres_threshold_readings
WHEN NEW.seq <> 1 + COALESCE((SELECT MAX(r.seq) FROM postgres_threshold_readings r), 0)
BEGIN SELECT RAISE(ABORT, 'postgres_threshold_readings : relevé hors suite'); END;
CREATE TRIGGER IF NOT EXISTS postgres_threshold_readings_garde BEFORE DELETE ON postgres_threshold_readings BEGIN SELECT RAISE(ABORT, 'postgres_threshold_readings : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS postgres_threshold_readings_fige BEFORE UPDATE ON postgres_threshold_readings BEGIN SELECT RAISE(ABORT, 'postgres_threshold_readings : un relevé ne change plus'); END;

-- La première fois qu'un seuil est franchi : une seule alerte par seuil, rattachée au relevé qui l'a vu [R631].
CREATE TABLE IF NOT EXISTS postgres_threshold_alerts (
  threshold TEXT PRIMARY KEY CHECK (threshold IN ('agents', 'taille', 'rapport')),
  reading_id TEXT NOT NULL REFERENCES postgres_threshold_readings (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS postgres_threshold_alerts_garde BEFORE DELETE ON postgres_threshold_alerts BEGIN SELECT RAISE(ABORT, 'postgres_threshold_alerts : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS postgres_threshold_alerts_fige BEFORE UPDATE ON postgres_threshold_alerts BEGIN SELECT RAISE(ABORT, 'postgres_threshold_alerts : une alerte ne change plus'); END;

-- Les décisions de la direction, par versions qui se suivent : « passer » ou « attendre ». Rien ne bascule seul [R631].
CREATE TABLE IF NOT EXISTS postgres_decisions (
  version INTEGER PRIMARY KEY CHECK (version >= 1),
  choice TEXT NOT NULL CHECK (choice IN ('passer', 'attendre')),
  decided_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS postgres_decisions_suite BEFORE INSERT ON postgres_decisions
WHEN NEW.version <> 1 + COALESCE((SELECT MAX(d.version) FROM postgres_decisions d), 0)
  OR NOT EXISTS (SELECT 1 FROM postgres_threshold_alerts)
BEGIN SELECT RAISE(ABORT, 'postgres_decisions : version hors suite ou aucun seuil franchi'); END;
CREATE TRIGGER IF NOT EXISTS postgres_decisions_garde BEFORE DELETE ON postgres_decisions BEGIN SELECT RAISE(ABORT, 'postgres_decisions : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS postgres_decisions_fige BEFORE UPDATE ON postgres_decisions BEGIN SELECT RAISE(ABORT, 'postgres_decisions : une décision ne change plus, une version s''ajoute'); END;
