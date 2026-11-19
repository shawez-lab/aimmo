-- AU113 · Le relecteur d'une langue pour un bien, désigné par la direction : un agent du réseau qui déclare la langue.
-- La plus récente désignation d'un bien et d'une langue fait foi ; sans agent, elle retire le relecteur.
CREATE TABLE IF NOT EXISTS translation_reviewers (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL REFERENCES properties (id) ON DELETE RESTRICT,
  language TEXT NOT NULL CHECK (language IN ('en', 'ur', 'hi', 'pa', 'fa', 'ar', 'el')),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  reviewer_agent_id TEXT,
  designated_by TEXT NOT NULL,
  designated_at TEXT NOT NULL,
  UNIQUE (property_id, language, seq)
);
CREATE TRIGGER IF NOT EXISTS translation_reviewers_garde BEFORE DELETE ON translation_reviewers BEGIN SELECT RAISE(ABORT, 'translation_reviewers : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS translation_reviewers_fige BEFORE UPDATE ON translation_reviewers BEGIN SELECT RAISE(ABORT, 'translation_reviewers : rien ne se réécrit'); END;
