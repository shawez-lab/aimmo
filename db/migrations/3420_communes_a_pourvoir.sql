-- HX68 · Les communes où des clients attendent un agent, ouvertes au recrutement (Feuille de route phase 4,
-- « Recrutement en Bourgogne-Franche-Comté » ; M14, « Candidature » ; M03, attribution) [R626, R627, R628].
-- Table nouvelle, en ajout seul : rien ne change ni ne s'efface [R17].

-- L'ouverture ou la fermeture d'une commune au recrutement, dite par la direction seule, par versions : la plus haute
-- vaut. La première version ouvre ; chaque version suivante dit le contraire de la précédente [R627].
CREATE TABLE IF NOT EXISTS recruiting_commune_decisions (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  commune TEXT NOT NULL CHECK (length(trim(commune)) BETWEEN 1 AND 80),
  version INTEGER NOT NULL CHECK (version >= 1),
  is_open INTEGER NOT NULL CHECK (is_open IN (0, 1)),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 200),
  decided_by TEXT NOT NULL CHECK (decided_by LIKE 'direction:%'),
  decided_at TEXT NOT NULL,
  PRIMARY KEY (network_id, commune, version)
);
-- Chaque version suit la précédente sans trou, la première ouvre, et chaque version change l'état [R627].
CREATE TRIGGER IF NOT EXISTS recruiting_commune_decisions_suite BEFORE INSERT ON recruiting_commune_decisions
WHEN NEW.version <> 1 + COALESCE((SELECT MAX(d.version) FROM recruiting_commune_decisions d WHERE d.network_id = NEW.network_id AND d.commune = NEW.commune), 0)
  OR NEW.is_open = COALESCE((SELECT d.is_open FROM recruiting_commune_decisions d WHERE d.network_id = NEW.network_id AND d.commune = NEW.commune ORDER BY d.version DESC LIMIT 1), 0)
BEGIN SELECT RAISE(ABORT, 'recruiting_commune_decisions : version hors suite ou état inchangé'); END;
CREATE TRIGGER IF NOT EXISTS recruiting_commune_decisions_garde BEFORE DELETE ON recruiting_commune_decisions BEGIN SELECT RAISE(ABORT, 'recruiting_commune_decisions : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS recruiting_commune_decisions_fige BEFORE UPDATE ON recruiting_commune_decisions BEGIN SELECT RAISE(ABORT, 'recruiting_commune_decisions : une décision ne change plus, une version s''ajoute'); END;
