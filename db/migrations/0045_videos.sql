-- P06 · Le contrôle du texte d'une vidéo du bien (sous-titres et légende) avant toute publication : jamais d'adresse
-- [R46]. Seul le résultat est gardé, avec l'empreinte du texte contrôlé ; chaque contrôle s'ajoute [R17].
CREATE TABLE IF NOT EXISTS video_text_checks (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  media_ref TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'refuse')),
  text_hash TEXT NOT NULL,
  checked_by TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS video_text_checks_ref ON video_text_checks (property_id, media_ref, checked_at);

CREATE TRIGGER IF NOT EXISTS video_text_checks_sans_effacement
BEFORE DELETE ON video_text_checks
BEGIN
  SELECT RAISE(ABORT, 'video_text_checks : rien ne s''efface');
END;

CREATE TRIGGER IF NOT EXISTS video_text_checks_fige
BEFORE UPDATE ON video_text_checks
BEGIN
  SELECT RAISE(ABORT, 'video_text_checks : un contrôle rangé ne change plus');
END;
