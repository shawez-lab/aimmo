-- AU003 · La signature en ligne réelle. Une signature en ligne n'est réelle que si l'avocat du réseau a validé le format
-- du dossier de preuve (H24, enregistré par la direction) et que le mail réel est branché (H05) ; sinon elle reste
-- d'essai, dite telle partout. Signé réellement par tous les mandants, le mandat est inscrit au registre, son dossier de
-- preuve est figé et chaque mandant reçoit son exemplaire avec le dossier. Rien ne s'efface ni ne se réécrit.

-- La validation de l'avocat, pour un format du dossier de preuve : la référence de son avis écrit, jamais l'avis.
CREATE TABLE IF NOT EXISTS signature_validations (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  proof_format TEXT NOT NULL CHECK (length(proof_format) BETWEEN 1 AND 40),
  reference TEXT NOT NULL CHECK (length(reference) BETWEEN 3 AND 120),
  validated_on TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS signature_validations_reseau ON signature_validations (network_id, proof_format, recorded_at);
CREATE TRIGGER IF NOT EXISTS signature_validations_fige BEFORE UPDATE ON signature_validations
BEGIN
  SELECT RAISE(ABORT, 'signature_validations : une validation ne se réécrit pas');
END;
CREATE TRIGGER IF NOT EXISTS signature_validations_garde BEFORE DELETE ON signature_validations
BEGIN
  SELECT RAISE(ABORT, 'signature_validations : rien ne s''efface');
END;

-- Le mode de chaque session, fixé à son ouverture : nul pour une session d'avant AU003, qui est d'essai.
ALTER TABLE signature_sessions ADD COLUMN mode TEXT CHECK (mode IS NULL OR mode IN ('essai', 'reel'));
CREATE TRIGGER IF NOT EXISTS signature_sessions_mode_fige BEFORE UPDATE ON signature_sessions
WHEN NEW.mode IS NOT OLD.mode
BEGIN
  SELECT RAISE(ABORT, 'signature figée');
END;

-- Le dossier de preuve d'un document signé réellement par tous ses mandants, et l'exemplaire remis à chacun : le
-- document numéroté suivi du dossier. Le dossier ne nomme personne : chaque mandant y est dit par son rang.
CREATE TABLE IF NOT EXISTS signature_dossiers (
  document_id TEXT PRIMARY KEY REFERENCES documents (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  content_hash TEXT NOT NULL,
  validation_id TEXT NOT NULL REFERENCES signature_validations (id) ON DELETE RESTRICT,
  dossier TEXT NOT NULL,
  dossier_hash TEXT NOT NULL,
  copy_content TEXT NOT NULL,
  copy_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS signature_dossiers_fige BEFORE UPDATE ON signature_dossiers
BEGIN
  SELECT RAISE(ABORT, 'signature_dossiers : un dossier de preuve ne se réécrit pas');
END;
CREATE TRIGGER IF NOT EXISTS signature_dossiers_garde BEFORE DELETE ON signature_dossiers
BEGIN
  SELECT RAISE(ABORT, 'signature_dossiers : rien ne s''efface');
END;

-- La remise de l'exemplaire et du dossier à chaque mandant : à envoyer, puis envoyée, jamais l'inverse.
CREATE TABLE IF NOT EXISTS signature_remises (
  document_id TEXT NOT NULL REFERENCES signature_dossiers (document_id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 1),
  status TEXT NOT NULL CHECK (status IN ('a_envoyer', 'envoyee')),
  -- Le rang de l'essai d'envoi : un essai abandonné (panne avant la remise) est remplacé par le suivant.
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  created_at TEXT NOT NULL,
  sent_at TEXT,
  PRIMARY KEY (document_id, person_id)
);
CREATE TRIGGER IF NOT EXISTS signature_remises_fige BEFORE UPDATE ON signature_remises
WHEN NOT ((OLD.status = 'a_envoyer' AND NEW.status = 'envoyee' AND NEW.sent_at IS NOT NULL AND NEW.attempt IS OLD.attempt)
       OR (OLD.status = 'a_envoyer' AND NEW.status = 'a_envoyer' AND NEW.attempt = OLD.attempt + 1 AND NEW.sent_at IS NULL))
  OR NEW.document_id IS NOT OLD.document_id OR NEW.person_id IS NOT OLD.person_id OR NEW.network_id IS NOT OLD.network_id
  OR NEW.position IS NOT OLD.position OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'signature_remises : une remise ne revient pas en arrière');
END;
CREATE TRIGGER IF NOT EXISTS signature_remises_garde BEFORE DELETE ON signature_remises
BEGIN
  SELECT RAISE(ABORT, 'signature_remises : rien ne s''efface');
END;
