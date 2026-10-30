-- X02 · Photos corrigées honnêtement, avec leur certificat (M19) [R130]. La correction se fait sur l'appareil de
-- l'agent ; le serveur ne range que sa description : la référence et l'empreinte de l'original gardé, celles du
-- résultat publié, et les corrections d'ensemble prises dans une liste fermée. Jamais un fichier.
-- Le jeton du certificat est tiré au hasard : il ne dit rien du bien, de l'agent ni de l'adresse.
CREATE TABLE IF NOT EXISTS photo_certificates (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE CHECK (length(token) = 32),
  property_id TEXT NOT NULL,
  network_id TEXT NOT NULL,
  result_ref TEXT NOT NULL,
  result_sha256 TEXT NOT NULL CHECK (length(result_sha256) = 64),
  original_ref TEXT NOT NULL,
  original_sha256 TEXT NOT NULL CHECK (length(original_sha256) = 64),
  operations TEXT NOT NULL,
  virtual_staging INTEGER NOT NULL CHECK (virtual_staging IN (0, 1)),
  processed_on TEXT NOT NULL CHECK (processed_on = 'appareil'),
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (property_id, result_ref),
  CHECK (result_ref <> original_ref),
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS photo_certificates_garde BEFORE DELETE ON photo_certificates BEGIN SELECT RAISE(ABORT, 'photo_certificates : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS photo_certificates_fige BEFORE UPDATE ON photo_certificates BEGIN SELECT RAISE(ABORT, 'photo_certificates : un certificat ne change plus'); END;
