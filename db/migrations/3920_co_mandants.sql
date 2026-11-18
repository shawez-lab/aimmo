-- AU001 · Le mandat d'un couple ou d'une indivision : chaque propriétaire est un mandant, avec sa propre fiche, jamais
-- réunie à celle de l'autre. Le document garde son premier mandant (`documents.person_id`) ; les autres sont ici, fixés à
-- la génération, dans l'ordre où le document les nomme. Rien ne s'efface ni ne se réécrit.
CREATE TABLE IF NOT EXISTS document_co_mandants (
  document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 1),
  added_at TEXT NOT NULL,
  PRIMARY KEY (document_id, person_id)
);
CREATE INDEX IF NOT EXISTS document_co_mandants_person ON document_co_mandants (person_id);
CREATE TRIGGER IF NOT EXISTS document_co_mandants_fige BEFORE UPDATE ON document_co_mandants
BEGIN
  SELECT RAISE(ABORT, 'document_co_mandants : un mandant ne se réécrit pas');
END;
CREATE TRIGGER IF NOT EXISTS document_co_mandants_garde BEFORE DELETE ON document_co_mandants
BEGIN
  SELECT RAISE(ABORT, 'document_co_mandants : rien ne s''efface');
END;

-- La signature en ligne : chaque mandant signe dans sa propre session. Vide pour une session d'avant AU001 : le signataire
-- est alors le premier mandant du document.
ALTER TABLE signature_sessions ADD COLUMN signer_person_id TEXT;
CREATE TRIGGER IF NOT EXISTS signature_sessions_signataire_fige BEFORE UPDATE OF signer_person_id ON signature_sessions
WHEN NEW.signer_person_id IS NOT OLD.signer_person_id
BEGIN
  SELECT RAISE(ABORT, 'signature figée');
END;
