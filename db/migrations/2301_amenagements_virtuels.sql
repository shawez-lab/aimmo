-- HX41 · Aménagement virtuel des pièces. En ajout seul : rien ne s'efface ni ne se réécrit [R17].

-- Ce qui a changé sur une image aménagée, en liste fermée, et sa photo réelle jumelle : une photo du même cliché (même
-- empreinte d'original), certifiée sans aménagement, publiée juste avant elle [R492, R493]. Une déclaration par image.
CREATE TABLE IF NOT EXISTS virtual_stagings (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  staged_ref TEXT NOT NULL CHECK (length(staged_ref) BETWEEN 1 AND 200),
  staged_token TEXT NOT NULL REFERENCES photo_certificates (token) ON DELETE RESTRICT,
  real_ref TEXT NOT NULL CHECK (length(real_ref) BETWEEN 1 AND 200),
  real_token TEXT NOT NULL REFERENCES photo_certificates (token) ON DELETE RESTRICT,
  changes TEXT NOT NULL CHECK (length(changes) BETWEEN 2 AND 2000),
  declared_by TEXT NOT NULL,
  declared_at TEXT NOT NULL,
  UNIQUE (property_id, staged_ref),
  UNIQUE (staged_token),
  CHECK (staged_ref <> real_ref),
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS virtual_stagings_garde BEFORE DELETE ON virtual_stagings BEGIN SELECT RAISE(ABORT, 'virtual_stagings : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS virtual_stagings_fige BEFORE UPDATE ON virtual_stagings BEGIN SELECT RAISE(ABORT, 'virtual_stagings : rien ne se réécrit'); END;
