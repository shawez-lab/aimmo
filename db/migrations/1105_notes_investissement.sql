-- Y05 · Note d'investissement : rédigée à partir du seul calcul (Y03) et de ses contraintes (Y04), chaque nombre relié à
-- une ligne du calcul ; montrée au client seulement après validation par l'agent de la fiche [R126]. Rien ne s'efface ;
-- une note ne change plus, sauf sa validation, une seule fois, sans toucher au texte [R17].
CREATE TABLE IF NOT EXISTS investment_notes (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  calculation_id TEXT NOT NULL REFERENCES investment_calculations (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('ia', 'secours')),
  -- La note entière, en JSON contrôlé par le code : alertes, paragraphes et leurs preuves, chiffres, sources, mentions.
  note TEXT NOT NULL CHECK (json_valid(note)),
  -- Le texte rendu, tel que le client le lira, et son empreinte.
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 20000),
  text_sha256 TEXT NOT NULL CHECK (length(text_sha256) = 64),
  status TEXT NOT NULL CHECK (status IN ('a_valider', 'validee')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  validated_by TEXT,
  validated_at TEXT,
  FOREIGN KEY (project_id, network_id) REFERENCES projects (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS investment_notes_project ON investment_notes (network_id, project_id, created_at);

CREATE TRIGGER IF NOT EXISTS investment_notes_garde BEFORE DELETE ON investment_notes
BEGIN
  SELECT RAISE(ABORT, 'investment_notes : rien ne s''efface');
END;
CREATE TRIGGER IF NOT EXISTS investment_notes_fige BEFORE UPDATE ON investment_notes
WHEN NOT (OLD.status = 'a_valider' AND NEW.status = 'validee' AND OLD.validated_at IS NULL AND NEW.validated_at IS NOT NULL
  AND NEW.validated_by IS NOT NULL AND NEW.id = OLD.id AND NEW.network_id = OLD.network_id AND NEW.calculation_id = OLD.calculation_id
  AND NEW.project_id = OLD.project_id AND NEW.origin = OLD.origin AND NEW.note = OLD.note AND NEW.text = OLD.text
  AND NEW.text_sha256 = OLD.text_sha256 AND NEW.created_by = OLD.created_by AND NEW.created_at = OLD.created_at)
BEGIN
  SELECT RAISE(ABORT, 'investment_notes : une note rangée ne change plus');
END;
