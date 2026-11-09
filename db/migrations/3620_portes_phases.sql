-- HX71 · La porte des phases : chaque phase ne s'ouvre que sur la condition de la précédente, prouvée à l'instant
-- (Feuille de route, « Cinq phases, chacune ouverte seulement si la précédente a rempli sa condition ») [R646, R647,
-- R648]. Table nouvelle, en ajout seul : rien ne change ni ne s'efface [R17]. La phase 1 est ouverte d'office : elle
-- n'a pas de ligne.

-- L'ouverture d'une phase par la direction, une seule par phase, avec la condition de la phase d'avant telle qu'elle
-- était lue à l'instant et son empreinte [R647]. Le rapport ne porte que des nombres, des mois et des raisons.
CREATE TABLE IF NOT EXISTS phase_openings (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  phase INTEGER NOT NULL CHECK (phase BETWEEN 2 AND 5),
  opened_at TEXT NOT NULL,
  opened_by TEXT NOT NULL CHECK (length(opened_by) BETWEEN 1 AND 200),
  evidence TEXT NOT NULL,
  evidence_hash TEXT NOT NULL CHECK (length(evidence_hash) = 64),
  PRIMARY KEY (network_id, phase)
);
-- Une phase ne s'ouvre qu'après la précédente, même par une écriture directe [R647].
CREATE TRIGGER IF NOT EXISTS phase_openings_suite BEFORE INSERT ON phase_openings
WHEN NEW.phase > 2 AND NOT EXISTS (SELECT 1 FROM phase_openings o WHERE o.network_id = NEW.network_id AND o.phase = NEW.phase - 1)
BEGIN SELECT RAISE(ABORT, 'phase_openings : la phase d''avant n''est pas ouverte'); END;
CREATE TRIGGER IF NOT EXISTS phase_openings_garde BEFORE DELETE ON phase_openings BEGIN SELECT RAISE(ABORT, 'phase_openings : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS phase_openings_fige BEFORE UPDATE ON phase_openings BEGIN SELECT RAISE(ABORT, 'phase_openings : une ouverture ne change plus'); END;
