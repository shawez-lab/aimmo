-- F06 · Carnet du propriétaire, un an après (M11) [R10, R65].
-- Un carnet par client et par dossier, fait une fois par le code, relu contre ses sources ; aucun nom, aucune adresse.
CREATE TABLE IF NOT EXISTS owner_booklets (
  file_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (file_id, person_id)
);
CREATE TRIGGER IF NOT EXISTS owner_booklets_garde BEFORE DELETE ON owner_booklets BEGIN SELECT RAISE(ABORT, 'owner_booklets : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS owner_booklets_fige BEFORE UPDATE ON owner_booklets BEGIN SELECT RAISE(ABORT, 'owner_booklets : un carnet fait ne change plus'); END;

-- Les liens vers un carnet, rangés par l'empreinte de leur jeton seulement.
CREATE TABLE IF NOT EXISTS owner_booklet_links (
  token_hash TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (file_id, person_id) REFERENCES owner_booklets (file_id, person_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS owner_booklet_links_garde BEFORE DELETE ON owner_booklet_links BEGIN SELECT RAISE(ABORT, 'owner_booklet_links : rien ne s''efface'); END;
