-- G02 · Plan du jour figé à 7 h 30, heure de Paris : un par agent et par jour. Un plan figé ne change plus, rien ne
-- s'efface [R17]. Il porte des données de fiche (prénom), comme la fiche elle-même ; le journal n'en porte aucune [R13].
CREATE TABLE IF NOT EXISTS daily_plans (
  agent_id TEXT NOT NULL,
  -- `AAAA-MM-JJ`, heure de Paris.
  day TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  -- Les lignes du plan, en JSON, dans l'ordre écrit [R35].
  items TEXT NOT NULL,
  -- Les personnes écartées, comptées sans donnée personnelle [R36].
  removed TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, day),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);

CREATE TRIGGER IF NOT EXISTS daily_plans_sans_effacement
BEFORE DELETE ON daily_plans
BEGIN
  SELECT RAISE(ABORT, 'daily_plans : rien ne s''efface');
END;

CREATE TRIGGER IF NOT EXISTS daily_plans_fige
BEFORE UPDATE ON daily_plans
BEGIN
  SELECT RAISE(ABORT, 'daily_plans : un plan figé ne change plus');
END;
