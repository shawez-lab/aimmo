-- X01 · Guide de prise de vue (M19) : la photo retenue pour chaque vue du guide, par sa référence de stockage dans la
-- fiche du bien de M07, jamais un fichier. Un choix plus récent s'ajoute, rien ne s'efface ni ne se réécrit [R17].
-- Les migrations de M19 commencent à 1201.
CREATE TABLE IF NOT EXISTS photo_guide_shots (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  network_id TEXT NOT NULL,
  view_key TEXT NOT NULL CHECK (length(view_key) BETWEEN 3 AND 40),
  media_ref TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS photo_guide_shots_property ON photo_guide_shots (property_id, view_key, recorded_at);
CREATE TRIGGER IF NOT EXISTS photo_guide_shots_garde BEFORE DELETE ON photo_guide_shots BEGIN SELECT RAISE(ABORT, 'photo_guide_shots : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS photo_guide_shots_fige BEFORE UPDATE ON photo_guide_shots BEGIN SELECT RAISE(ABORT, 'photo_guide_shots : un choix rangé ne change plus'); END;

-- La validation par la direction d'un bien photographié avec le guide : une fois par bien, avec la liste des photos vue.
CREATE TABLE IF NOT EXISTS photo_guide_validations (
  property_id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL,
  shots_sha256 TEXT NOT NULL CHECK (length(shots_sha256) = 64),
  validated_by TEXT NOT NULL,
  validated_at TEXT NOT NULL,
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS photo_guide_validations_garde BEFORE DELETE ON photo_guide_validations BEGIN SELECT RAISE(ABORT, 'photo_guide_validations : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS photo_guide_validations_fige BEFORE UPDATE ON photo_guide_validations BEGIN SELECT RAISE(ABORT, 'photo_guide_validations : une validation ne change plus'); END;
