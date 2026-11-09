-- HX64 · Vidéos et épisodes du podcast, mesurés jusqu'à l'agent resté (M14, Feuille de route phase 4) [R620, R621, R622].

-- Une vidéo YouTube ou un épisode du podcast qui sert au recrutement, rangé par la direction seule [R620].
-- Le titre et la description ont passé le contrôle des textes de recrutement [R80] dans le code. Le code est celui
-- du lien marqué vers la page de candidature [R621]. Un contenu ne change ni ne s'efface : il se retire [R17].
CREATE TABLE IF NOT EXISTS recruiting_contents (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('video', 'podcast')),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 140),
  url TEXT NOT NULL CHECK (length(url) BETWEEN 12 AND 500 AND url LIKE 'https://%'),
  description TEXT CHECK (description IS NULL OR length(trim(description)) BETWEEN 1 AND 2000),
  published_on TEXT NOT NULL CHECK (published_on GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  code TEXT NOT NULL UNIQUE CHECK (length(code) = 12),
  created_by TEXT NOT NULL CHECK (created_by LIKE 'direction:%'),
  created_at TEXT NOT NULL,
  UNIQUE (id, network_id)
);
CREATE INDEX IF NOT EXISTS recruiting_contents_network ON recruiting_contents (network_id, published_on);
CREATE TRIGGER IF NOT EXISTS recruiting_contents_garde BEFORE DELETE ON recruiting_contents BEGIN SELECT RAISE(ABORT, 'recruiting_contents : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS recruiting_contents_fige BEFORE UPDATE ON recruiting_contents BEGIN SELECT RAISE(ABORT, 'recruiting_contents : un contenu ne change plus, il se retire'); END;

-- Le retrait d'un contenu, une fois, par la direction : son lien ne rattache plus aucune candidature [R620, R621].
CREATE TABLE IF NOT EXISTS recruiting_content_withdrawals (
  content_id TEXT PRIMARY KEY REFERENCES recruiting_contents (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  withdrawn_by TEXT NOT NULL CHECK (withdrawn_by LIKE 'direction:%'),
  withdrawn_at TEXT NOT NULL,
  FOREIGN KEY (content_id, network_id) REFERENCES recruiting_contents (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS recruiting_content_withdrawals_garde BEFORE DELETE ON recruiting_content_withdrawals BEGIN SELECT RAISE(ABORT, 'recruiting_content_withdrawals : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS recruiting_content_withdrawals_fige BEFORE UPDATE ON recruiting_content_withdrawals BEGIN SELECT RAISE(ABORT, 'recruiting_content_withdrawals : un retrait ne change plus'); END;

-- Le contenu d'origine d'une candidature : un seul, rangé avec elle, qui ne change plus [R621].
CREATE TABLE IF NOT EXISTS candidate_content_origins (
  candidate_id TEXT PRIMARY KEY REFERENCES candidates (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  content_id TEXT NOT NULL,
  at TEXT NOT NULL,
  FOREIGN KEY (content_id, network_id) REFERENCES recruiting_contents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS candidate_content_origins_content ON candidate_content_origins (content_id);
-- La base refuse un rattachement à un contenu retiré, à une candidature d'un autre réseau, ou dont la source n'est
-- pas la sorte du contenu [R621].
CREATE TRIGGER IF NOT EXISTS candidate_content_origins_controle BEFORE INSERT ON candidate_content_origins
WHEN EXISTS (SELECT 1 FROM recruiting_content_withdrawals w WHERE w.content_id = NEW.content_id)
  OR NOT EXISTS (
    SELECT 1 FROM candidates c JOIN recruiting_contents r ON r.id = NEW.content_id
     WHERE c.id = NEW.candidate_id AND c.network_id = NEW.network_id AND r.network_id = NEW.network_id AND c.source = r.kind)
BEGIN SELECT RAISE(ABORT, 'candidate_content_origins : contenu retiré, autre réseau ou autre source'); END;
CREATE TRIGGER IF NOT EXISTS candidate_content_origins_garde BEFORE DELETE ON candidate_content_origins BEGIN SELECT RAISE(ABORT, 'candidate_content_origins : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS candidate_content_origins_fige BEFORE UPDATE ON candidate_content_origins BEGIN SELECT RAISE(ABORT, 'candidate_content_origins : une origine ne change plus'); END;
