-- HX53 · Lettre d'information et magazine des biens (M07, M08, M12) [R583, R584, R585, R586].

-- Une édition de la lettre, ouverte par la direction : une lettre par personne et par édition, jamais deux [R05].
-- Rien ne change ni ne s'efface.
CREATE TABLE IF NOT EXISTS newsletter_editions (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 80),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (id, network_id)
);
CREATE TRIGGER IF NOT EXISTS newsletter_editions_garde BEFORE DELETE ON newsletter_editions BEGIN SELECT RAISE(ABORT, 'newsletter_editions : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS newsletter_editions_fige BEFORE UPDATE ON newsletter_editions BEGIN SELECT RAISE(ABORT, 'newsletter_editions : une édition ne change plus'); END;

-- La lettre d'une personne pour une édition : réservée avant l'envoi pour ne partir qu'une fois, puis son issue. Le
-- texte n'est jamais rangé ici, seulement le message du contrôle central [R13]. Rien ne s'efface.
CREATE TABLE IF NOT EXISTS newsletter_letters (
  edition_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  network_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'refused', 'waiting', 'failed')),
  rule TEXT,
  message_id TEXT,
  properties INTEGER NOT NULL DEFAULT 0 CHECK (properties >= 0),
  mode TEXT NOT NULL CHECK (mode IN ('essai')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (edition_id, person_id),
  FOREIGN KEY (edition_id, network_id) REFERENCES newsletter_editions (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS newsletter_letters_garde BEFORE DELETE ON newsletter_letters BEGIN SELECT RAISE(ABORT, 'newsletter_letters : rien ne s''efface'); END;
-- Une lettre partie ou refusée pour de bon ne revient jamais en arrière [R05].
CREATE TRIGGER IF NOT EXISTS newsletter_letters_fin BEFORE UPDATE ON newsletter_letters
WHEN OLD.status IN ('sent', 'refused') OR NEW.edition_id <> OLD.edition_id OR NEW.person_id <> OLD.person_id OR NEW.network_id <> OLD.network_id
BEGIN SELECT RAISE(ABORT, 'newsletter_letters : une lettre partie ou refusée ne change plus'); END;

-- Les liens de désinscription de la lettre, rangés par l'empreinte du jeton seulement [R584]. Ils ne retirent que
-- l'accord de la lettre, jamais celui des alertes ni du suivi de valeur.
CREATE TABLE IF NOT EXISTS newsletter_unsubscribe_tokens (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  network_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS newsletter_unsubscribe_tokens_garde BEFORE DELETE ON newsletter_unsubscribe_tokens BEGIN SELECT RAISE(ABORT, 'newsletter_unsubscribe_tokens : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS newsletter_unsubscribe_tokens_fige BEFORE UPDATE ON newsletter_unsubscribe_tokens
WHEN OLD.used_at IS NOT NULL OR NEW.token_hash <> OLD.token_hash OR NEW.person_id <> OLD.person_id OR NEW.network_id <> OLD.network_id
BEGIN SELECT RAISE(ABORT, 'newsletter_unsubscribe_tokens : un jeton servi ne change plus'); END;
