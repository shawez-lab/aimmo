-- D14 : un scan déposé prouve une seule signature, de mandat ou d'avenant. Seules les références du dépôt sont
-- concernées : les références plus anciennes, saisies à la main, restent telles quelles.
CREATE UNIQUE INDEX IF NOT EXISTS signed_amendments_scan_unique ON signed_amendments (scan_ref) WHERE scan_ref LIKE 'mandats/%';

CREATE TRIGGER IF NOT EXISTS signed_amendments_scan_libre BEFORE INSERT ON signed_amendments
WHEN NEW.scan_ref LIKE 'mandats/%' AND EXISTS (SELECT 1 FROM signed_documents WHERE scan_ref = NEW.scan_ref)
BEGIN
  SELECT RAISE(ABORT, 'scan_deja_utilise');
END;

CREATE TRIGGER IF NOT EXISTS signed_documents_scan_libre BEFORE INSERT ON signed_documents
WHEN NEW.scan_ref LIKE 'mandats/%' AND EXISTS (SELECT 1 FROM signed_amendments WHERE scan_ref = NEW.scan_ref)
BEGIN
  SELECT RAISE(ABORT, 'scan_deja_utilise');
END;
