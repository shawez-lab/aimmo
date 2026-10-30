-- G07 · Engagements de service rangés par la direction, versionnés (M20). Chacun a sa mesure, écrite dans le code,
-- et son délai ; le taux réellement tenu par chaque agent se recalcule depuis la base [R141, R17].
CREATE TABLE IF NOT EXISTS service_commitments (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  code TEXT NOT NULL CHECK (length(code) BETWEEN 2 AND 40),
  version INTEGER NOT NULL CHECK (version >= 1),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 5 AND 120),
  measure TEXT NOT NULL CHECK (measure IN ('compte_rendu_visite', 'point_semaine')),
  delay_hours INTEGER NOT NULL CHECK (delay_hours BETWEEN 1 AND 336),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  set_by TEXT NOT NULL CHECK (set_by LIKE 'direction:%'),
  set_at TEXT NOT NULL,
  UNIQUE (network_id, code, version)
);
CREATE TRIGGER IF NOT EXISTS service_commitments_garde BEFORE DELETE ON service_commitments BEGIN SELECT RAISE(ABORT, 'service_commitments : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS service_commitments_fige BEFORE UPDATE ON service_commitments BEGIN SELECT RAISE(ABORT, 'service_commitments : un engagement rangé ne change plus, une version s''ajoute'); END;
