-- D08 · Signature en ligne AIMMO, en mode essai : jamais une signature réelle tant que l'avocat n'a pas validé le
-- dossier de preuve (H24). Le code à usage unique n'est jamais gardé : seule son empreinte l'est.
CREATE TABLE IF NOT EXISTS signature_sessions (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE RESTRICT,
  -- L'empreinte du document à l'ouverture : un document modifié depuis ne se signe pas.
  content_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  status TEXT NOT NULL CHECK (status IN ('ouverte', 'signee', 'bloquee')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  signed_at TEXT,
  -- Empreinte de la signature manuscrite tracée à l'écran, si elle l'a été ; jamais le tracé lui-même.
  drawing_hash TEXT,
  -- Le dossier de preuve : document, empreinte, horodatage, méthode ; en JSON, sans donnée personnelle.
  proof TEXT
);
CREATE INDEX IF NOT EXISTS signature_sessions_document ON signature_sessions (document_id, created_at);
CREATE TRIGGER IF NOT EXISTS signature_sessions_garde BEFORE DELETE ON signature_sessions BEGIN SELECT RAISE(ABORT, 'signature gardée'); END;
-- Une session signée ou bloquée ne change plus.
CREATE TRIGGER IF NOT EXISTS signature_sessions_fige BEFORE UPDATE ON signature_sessions
WHEN OLD.status <> 'ouverte' OR NEW.id IS NOT OLD.id OR NEW.document_id IS NOT OLD.document_id OR NEW.content_hash IS NOT OLD.content_hash
  OR NEW.code_hash IS NOT OLD.code_hash OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'signature figée'); END;
