-- HX46 · Avis clients vérifiables, publiés partout (M11) [R520, R521, R522, R523].
-- Une invitation par client d'un dossier clos, tirée par l'agent du dossier ou la direction, rangée par l'empreinte de son
-- jeton seulement ; elle expire. Seul un dossier clos en reçoit une [R520]. Rien ne s'efface.
CREATE TABLE IF NOT EXISTS verified_review_invites (
  token_hash TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  file_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('vendeur', 'acquereur')),
  closed_on TEXT NOT NULL CHECK (closed_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS verified_review_invites_file ON verified_review_invites (file_id, person_id);
CREATE TRIGGER IF NOT EXISTS verified_review_invites_garde BEFORE DELETE ON verified_review_invites BEGIN SELECT RAISE(ABORT, 'verified_review_invites : rien ne s''efface'); END;

-- Les avis publiés, un par client et par dossier, enchaînés par agent : chaque avis porte l'empreinte du précédent.
-- Aucun avis ne s'efface ni ne change, aucun ne se masque : il n'existe aucune colonne pour le cacher [R521].
-- La preuve publique est un engagement sur le dossier clos (empreinte du dossier, du jour de l'acte et d'un sel gardé
-- ici) : elle ne dit rien de la personne ni du bien [R522].
CREATE TABLE IF NOT EXISTS verified_reviews (
  code TEXT PRIMARY KEY CHECK (length(code) = 12),
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  file_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('vendeur', 'acquereur')),
  score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 20 AND 2000),
  published_on TEXT NOT NULL CHECK (published_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  file_salt TEXT NOT NULL CHECK (length(file_salt) = 64),
  file_commitment TEXT NOT NULL CHECK (length(file_commitment) = 64),
  -- L'empreinte porte sur celle du texte : une procédure d'effacement de la conformité pourra caviarder le texte sans
  -- casser la chaîne [R17].
  text_hash TEXT NOT NULL CHECK (length(text_hash) = 64),
  prev_hash TEXT NOT NULL CHECK (length(prev_hash) = 64),
  hash TEXT NOT NULL UNIQUE CHECK (length(hash) = 64),
  published_at TEXT NOT NULL,
  UNIQUE (file_id, person_id),
  UNIQUE (agent_id, seq)
);
CREATE INDEX IF NOT EXISTS verified_reviews_agent ON verified_reviews (network_id, agent_id, seq);
CREATE TRIGGER IF NOT EXISTS verified_reviews_garde BEFORE DELETE ON verified_reviews BEGIN SELECT RAISE(ABORT, 'verified_reviews : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS verified_reviews_fige BEFORE UPDATE ON verified_reviews BEGIN SELECT RAISE(ABORT, 'verified_reviews : un avis ne change plus'); END;
-- Un avis vient d'une invitation consommée, donc d'un dossier clos, pour ce client et ce dossier [R520].
CREATE TRIGGER IF NOT EXISTS verified_reviews_invite BEFORE INSERT ON verified_reviews
  WHEN NOT EXISTS (SELECT 1 FROM verified_review_invites i WHERE i.file_id = NEW.file_id AND i.person_id = NEW.person_id AND i.network_id = NEW.network_id AND i.agent_id = NEW.agent_id AND i.side = NEW.side AND i.used_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'verified_reviews : un avis vient d''un dossier clos, par son invitation [R520]'); END;
-- La chaîne ne se coupe pas : le premier avis d'un agent part de zéro, chaque suivant porte l'empreinte du précédent [R521].
CREATE TRIGGER IF NOT EXISTS verified_reviews_chaine BEFORE INSERT ON verified_reviews
  WHEN NOT (
    (NEW.seq = 1 AND NEW.prev_hash = '0000000000000000000000000000000000000000000000000000000000000000' AND NOT EXISTS (SELECT 1 FROM verified_reviews r WHERE r.agent_id = NEW.agent_id))
    OR EXISTS (SELECT 1 FROM verified_reviews r WHERE r.agent_id = NEW.agent_id AND r.seq = NEW.seq - 1 AND r.hash = NEW.prev_hash AND r.seq = (SELECT max(seq) FROM verified_reviews x WHERE x.agent_id = NEW.agent_id))
  )
BEGIN SELECT RAISE(ABORT, 'verified_reviews : la chaîne des avis ne se coupe pas [R521]'); END;
