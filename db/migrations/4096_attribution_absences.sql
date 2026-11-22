-- AU040 · Un agent déclaré absent n'est jamais candidat à l'attribution : le contact suit la règle de remplacement
-- (le binôme de l'absence, à défaut un autre agent de la commune, à défaut la direction) (M03, M14 ; audit A040) [R680].
-- Table nouvelle, en ajout seul : rien ne change ni ne s'efface [R17].

-- Chaque agent écarté d'une attribution parce qu'il était absent ce jour-là, avec l'absence qui l'a écarté et, s'il y
-- en a un, son binôme qui a reçu le contact à sa place. Aucune personne n'y figure : des identifiants.
CREATE TABLE IF NOT EXISTS attribution_absences (
  attribution_id TEXT NOT NULL REFERENCES attributions (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  absent_agent_id TEXT NOT NULL,
  absence_id TEXT NOT NULL REFERENCES agent_absences (id) ON DELETE RESTRICT,
  -- Le binôme de l'absence quand c'est lui qui a reçu le contact ; NULL sinon.
  cover_agent_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (attribution_id, absent_agent_id),
  CHECK (cover_agent_id IS NULL OR cover_agent_id <> absent_agent_id),
  FOREIGN KEY (absent_agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS attribution_absences_network ON attribution_absences (network_id, created_at);
CREATE TRIGGER IF NOT EXISTS attribution_absences_garde BEFORE DELETE ON attribution_absences BEGIN SELECT RAISE(ABORT, 'attribution_absences : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS attribution_absences_fige BEFORE UPDATE ON attribution_absences BEGIN SELECT RAISE(ABORT, 'attribution_absences : une trace d''absence ne change plus'); END;
