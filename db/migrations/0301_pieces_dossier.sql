-- N01 · Pièces du dossier notaire (M10). Une pièce est une référence de stockage datée, jamais son contenu ; une
-- nouvelle version s'ajoute, rien ne change ni ne s'efface [R17]. Aucune pièce d'identité, aucun document
-- anti-blanchiment, aucun RIB : la liste des pièces est fermée et écrite dans le code [R15, R60].
CREATE TABLE IF NOT EXISTS sale_file_pieces (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES sale_files (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  piece TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  -- `dossiers/<id du dossier>/<identifiant tiré au hasard>.<pdf|jpg|png>`, donné par le stockage.
  ref TEXT NOT NULL UNIQUE,
  -- La date du document lui-même (`AAAA-MM-JJ`), pour juger sa durée de validité à l'acte (N06).
  issued_on TEXT NOT NULL,
  received_at TEXT NOT NULL,
  by TEXT NOT NULL,
  UNIQUE (file_id, piece, version)
);
CREATE INDEX IF NOT EXISTS sale_file_pieces_file ON sale_file_pieces (file_id, piece, version DESC);
CREATE TRIGGER IF NOT EXISTS sale_file_pieces_fige BEFORE UPDATE ON sale_file_pieces BEGIN SELECT RAISE(ABORT, 'sale_file_pieces : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS sale_file_pieces_sans_effacement BEFORE DELETE ON sale_file_pieces BEGIN SELECT RAISE(ABORT, 'sale_file_pieces : rien ne s''efface'); END;
