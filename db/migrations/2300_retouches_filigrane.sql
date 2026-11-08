-- HX40 · Retouches déclarées et filigrane. En ajout seul : rien ne s'efface ni ne se réécrit [R17].

-- Les retouches locales déclarées d'une photo (ciel, reflets, objet mobile retiré), en liste fermée contrôlée par le code,
-- inscrites au certificat de X02 [R490]. Une photo certifiée avant HX40 n'en a aucune.
ALTER TABLE photo_certificates ADD COLUMN local_edits TEXT NOT NULL DEFAULT '[]';

-- Chaque export d'une photo certifiée : le filigrane posé (nom de l'agent du bien et code de contenu du bien, AT05),
-- jamais une adresse ni un nom de client [R491, R46].
CREATE TABLE IF NOT EXISTS photo_exports (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  result_ref TEXT NOT NULL CHECK (length(result_ref) BETWEEN 1 AND 200),
  certificate_token TEXT NOT NULL REFERENCES photo_certificates (token) ON DELETE RESTRICT,
  content_code TEXT NOT NULL CHECK (length(content_code) = 12),
  watermark_text TEXT NOT NULL CHECK (length(watermark_text) BETWEEN 5 AND 120),
  width INTEGER NOT NULL CHECK (width BETWEEN 200 AND 12000),
  height INTEGER NOT NULL CHECK (height BETWEEN 200 AND 12000),
  exported_by TEXT NOT NULL,
  exported_at TEXT NOT NULL,
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS photo_exports_bien ON photo_exports (property_id, result_ref);
CREATE TRIGGER IF NOT EXISTS photo_exports_garde BEFORE DELETE ON photo_exports BEGIN SELECT RAISE(ABORT, 'photo_exports : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS photo_exports_fige BEFORE UPDATE ON photo_exports BEGIN SELECT RAISE(ABORT, 'photo_exports : rien ne se réécrit'); END;
