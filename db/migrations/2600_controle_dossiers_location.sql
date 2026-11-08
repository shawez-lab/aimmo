-- HX47 · Dossiers de location contrôlés contre la fraude. Table nouvelle, en ajout seul : rien ne s'efface ni ne se
-- réécrit [R17]. Le constat d'une pièce de candidature, contrôle par contrôle (conforme, écart, non vérifiable) :
-- jamais une note, un total ni un rang [R14, R530], jamais une valeur lue sur la pièce [R534].
CREATE TABLE IF NOT EXISTS rental_piece_findings (
  piece_id TEXT NOT NULL REFERENCES rental_application_pieces (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  network_id TEXT NOT NULL,
  application_id TEXT NOT NULL REFERENCES rental_applications (id) ON DELETE RESTRICT,
  -- La liste des contrôles et de leur résultat, sans aucune valeur lue.
  findings TEXT NOT NULL CHECK (json_valid(findings) AND json_type(findings) = 'array'),
  checked_by TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (piece_id, version)
);
CREATE INDEX IF NOT EXISTS rental_piece_findings_app ON rental_piece_findings (application_id);
CREATE TRIGGER IF NOT EXISTS rental_piece_findings_garde BEFORE DELETE ON rental_piece_findings BEGIN SELECT RAISE(ABORT, 'rental_piece_findings : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_piece_findings_fige BEFORE UPDATE ON rental_piece_findings BEGIN SELECT RAISE(ABORT, 'rental_piece_findings : rien ne se réécrit'); END;
