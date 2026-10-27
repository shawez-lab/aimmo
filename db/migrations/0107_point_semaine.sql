-- T07 · Point de la semaine au vendeur. Un seul par mandat et par lundi [R18] ; préparé par le système, validé par
-- l'agent, puis envoyé par le contrôle central. Chiffres lus dans la base ; une donnée absente est « non
-- communiquée » ; jamais de baisse de prix [R53]. Rien ne s'efface ; un point validé ne change plus [R17].
CREATE TABLE IF NOT EXISTS weekly_points (
  mandate_id TEXT NOT NULL REFERENCES mandates (id) ON DELETE RESTRICT,
  week TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  -- Les chiffres et les avis, en JSON, tels que lus à la préparation.
  figures TEXT NOT NULL,
  next_actions TEXT,
  status TEXT NOT NULL CHECK (status IN ('prepare', 'valide')),
  validated_by TEXT,
  validated_at TEXT,
  delivery_status TEXT CHECK (delivery_status IS NULL OR delivery_status IN ('sent', 'waiting', 'refused', 'failed')),
  delivery_rule TEXT,
  message_id TEXT REFERENCES messages (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (mandate_id, week)
);
CREATE INDEX IF NOT EXISTS weekly_points_agent ON weekly_points (network_id, agent_id, week);
CREATE TRIGGER IF NOT EXISTS weekly_points_garde BEFORE DELETE ON weekly_points BEGIN SELECT RAISE(ABORT, 'point gardé'); END;
CREATE TRIGGER IF NOT EXISTS weekly_points_fige
BEFORE UPDATE ON weekly_points
WHEN OLD.status = 'valide' AND (NEW.figures IS NOT OLD.figures OR NEW.next_actions IS NOT OLD.next_actions OR NEW.status IS NOT OLD.status OR NEW.validated_at IS NOT OLD.validated_at)
BEGIN
  SELECT RAISE(ABORT, 'point validé : figé');
END;
