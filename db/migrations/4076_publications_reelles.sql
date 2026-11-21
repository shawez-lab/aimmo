-- AU036 : les envois réels des publications vers les réseaux (Facebook, Instagram), à part des essais de X05 (1206),
-- pour qu'un essai réussi avant la mise en service n'empêche jamais la vraie publication. Ajout seul : rien ne change
-- ni ne s'efface [R17]. Un envoi réel garde la référence de la publication chez le réseau et son lien public relu chez
-- lui ; un échec garde son code fermé et ce que l'agent peut faire, jamais le texte du réseau [R13, R134].
CREATE TABLE IF NOT EXISTS social_live_attempts (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES social_posts (id) ON DELETE RESTRICT,
  channel TEXT NOT NULL CHECK (channel IN ('instagram', 'facebook', 'linkedin', 'google', 'tiktok', 'youtube')),
  account TEXT NOT NULL CHECK (account IN ('agent', 'reseau')),
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 0 AND 9),
  mode TEXT NOT NULL CHECK (mode = 'reel'),
  claimed_by TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  UNIQUE (post_id, channel, account, attempt)
);
CREATE TRIGGER IF NOT EXISTS social_live_attempts_garde BEFORE DELETE ON social_live_attempts BEGIN SELECT RAISE(ABORT, 'social_live_attempts : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS social_live_attempts_fige BEFORE UPDATE ON social_live_attempts BEGIN SELECT RAISE(ABORT, 'social_live_attempts : un essai ne change plus'); END;

CREATE TABLE IF NOT EXISTS social_live_sends (
  attempt_id TEXT PRIMARY KEY REFERENCES social_live_attempts (id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('envoye', 'echec')),
  post_ref TEXT,
  url TEXT CHECK (url IS NULL OR (url LIKE 'https://%' AND length(url) <= 500)),
  error_code TEXT,
  action TEXT CHECK (action IS NULL OR action IN ('reessayer', 'reconnecter', 'relier', 'corriger')),
  done_at TEXT NOT NULL,
  CHECK ((outcome = 'envoye' AND post_ref IS NOT NULL AND error_code IS NULL AND action IS NULL)
      OR (outcome = 'echec' AND post_ref IS NULL AND url IS NULL AND error_code IS NOT NULL AND action IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS social_live_sends_garde BEFORE DELETE ON social_live_sends BEGIN SELECT RAISE(ABORT, 'social_live_sends : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS social_live_sends_fige BEFORE UPDATE ON social_live_sends BEGIN SELECT RAISE(ABORT, 'social_live_sends : un envoi ne change plus'); END;
