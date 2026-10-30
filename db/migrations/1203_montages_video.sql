-- X03 · Montage vidéo sur l'appareil à partir d'un modèle (M19) [R130, R133, R46]. Le montage se fait sur le
-- téléphone ou l'ordinateur de l'agent ; le serveur ne range que sa description : la référence de la vidéo finie et
-- son empreinte, le modèle suivi, la durée, la musique choisie dans la bibliothèque sous licence. Jamais un fichier.
CREATE TABLE IF NOT EXISTS video_montages (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  network_id TEXT NOT NULL,
  video_ref TEXT NOT NULL,
  video_sha256 TEXT NOT NULL CHECK (length(video_sha256) = 64),
  template_sha256 TEXT NOT NULL CHECK (length(template_sha256) = 64),
  clips_count INTEGER NOT NULL CHECK (clips_count BETWEEN 1 AND 40),
  duration_s INTEGER NOT NULL CHECK (duration_s BETWEEN 1 AND 600),
  music_id TEXT,
  processed_on TEXT NOT NULL CHECK (processed_on = 'appareil'),
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (property_id, video_ref),
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS video_montages_garde BEFORE DELETE ON video_montages BEGIN SELECT RAISE(ABORT, 'video_montages : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS video_montages_fige BEFORE UPDATE ON video_montages BEGIN SELECT RAISE(ABORT, 'video_montages : un montage rangé ne change plus'); END;
