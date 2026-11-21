-- AU103 · L'image entière de la photo HDR [R677].
-- La saisie de la photo dit l'image gardée : son empreinte, sa taille, son poids, et les chiffres du contrôle refait par
-- le serveur sur sa version réduite. Les photos reçues avant restent sans image (colonnes vides).
ALTER TABLE visit_photos ADD COLUMN image_sha256 TEXT CHECK (image_sha256 IS NULL OR length(image_sha256) = 64);
ALTER TABLE visit_photos ADD COLUMN image_width INTEGER CHECK (image_width IS NULL OR image_width BETWEEN 1 AND 2048);
ALTER TABLE visit_photos ADD COLUMN image_height INTEGER CHECK (image_height IS NULL OR image_height BETWEEN 1 AND 2048);
ALTER TABLE visit_photos ADD COLUMN image_bytes INTEGER CHECK (image_bytes IS NULL OR image_bytes BETWEEN 1 AND 4000000);
ALTER TABLE visit_photos ADD COLUMN kept_brightness REAL;
ALTER TABLE visit_photos ADD COLUMN kept_clipped REAL;
ALTER TABLE visit_photos ADD COLUMN kept_sharpness REAL;
-- L'image gardée réduite (au plus 128 points de côté, en base 64) : le fichier reçu ensuite doit la montrer.
ALTER TABLE visit_photos ADD COLUMN kept_luma TEXT CHECK (kept_luma IS NULL OR length(kept_luma) <= 22000);

-- Le fichier de l'image, rangé à part quand le téléphone a pu l'envoyer : une fois, jamais changé ni effacé.
CREATE TABLE IF NOT EXISTS visit_photo_files (
  photo_id TEXT PRIMARY KEY REFERENCES visit_photos (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  media_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  bytes INTEGER NOT NULL CHECK (bytes BETWEEN 1 AND 4000000),
  deposited_at TEXT NOT NULL,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS visit_photo_files_fige BEFORE UPDATE ON visit_photo_files BEGIN SELECT RAISE(ABORT, 'visit_photo_files : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS visit_photo_files_garde BEFORE DELETE ON visit_photo_files BEGIN SELECT RAISE(ABORT, 'visit_photo_files : rien ne s''efface'); END;
