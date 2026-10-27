-- D04 · Mandat signé sur papier, numéroté au registre [R39].
-- Une ligne par document signé : elle réserve le document avant tout, puis reçoit son mandat, son numéro et
-- l'exemplaire du mandant. Une valeur posée ne change plus ; rien ne s'efface.
CREATE TABLE IF NOT EXISTS signed_documents (
  document_id TEXT PRIMARY KEY REFERENCES documents (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  signed_at TEXT NOT NULL,
  -- Lieu de signature : à l'agence, hors agence (domicile du vendeur…) ou à distance ; il décide du délai de
  -- rétractation (D05).
  place TEXT NOT NULL CHECK (place IN ('agence', 'hors_agence', 'distance')),
  -- Référence du scan de l'exemplaire signé, rangé hors de la base.
  scan_ref TEXT NOT NULL CHECK (length(scan_ref) BETWEEN 1 AND 200),
  mandate_id TEXT REFERENCES mandates (id) ON DELETE RESTRICT,
  number TEXT,
  copy_content TEXT,
  copy_hash TEXT,
  registered_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS signed_documents_mandate ON signed_documents (mandate_id) WHERE mandate_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS signed_documents_sans_effacement
BEFORE DELETE ON signed_documents
BEGIN
  SELECT RAISE(ABORT, 'signature gardée');
END;

-- Seules les valeurs encore vides se remplissent ; rien de posé ne change.
CREATE TRIGGER IF NOT EXISTS signed_documents_fige
BEFORE UPDATE ON signed_documents
WHEN NEW.document_id IS NOT OLD.document_id OR NEW.network_id IS NOT OLD.network_id OR NEW.signed_at IS NOT OLD.signed_at
  OR NEW.place IS NOT OLD.place OR NEW.scan_ref IS NOT OLD.scan_ref OR NEW.registered_by IS NOT OLD.registered_by OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.mandate_id IS NOT NULL AND NEW.mandate_id IS NOT OLD.mandate_id)
  OR (OLD.number IS NOT NULL AND NEW.number IS NOT OLD.number)
  OR (OLD.copy_content IS NOT NULL AND NEW.copy_content IS NOT OLD.copy_content)
  OR (OLD.copy_hash IS NOT NULL AND NEW.copy_hash IS NOT OLD.copy_hash)
  OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS NOT OLD.completed_at)
BEGIN
  SELECT RAISE(ABORT, 'signature figée');
END;
