-- D07 · Avenant au mandat.

-- Le mandat auquel se rattache un document (un avenant) ; vide pour un mandat.
ALTER TABLE documents ADD COLUMN mandate_id TEXT REFERENCES mandates (id);

-- L'avenant signé : rangé en une seule fois, avec son exemplaire ; jamais modifié ni effacé.
CREATE TABLE IF NOT EXISTS signed_amendments (
  document_id TEXT PRIMARY KEY REFERENCES documents (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  mandate_id TEXT NOT NULL REFERENCES mandates (id) ON DELETE RESTRICT,
  signed_at TEXT NOT NULL,
  place TEXT NOT NULL CHECK (place IN ('agence', 'hors_agence', 'distance')),
  scan_ref TEXT NOT NULL CHECK (length(scan_ref) BETWEEN 1 AND 200),
  copy_content TEXT NOT NULL,
  copy_hash TEXT NOT NULL,
  registered_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS signed_amendments_mandate ON signed_amendments (mandate_id, signed_at);
CREATE TRIGGER IF NOT EXISTS signed_amendments_fige BEFORE UPDATE ON signed_amendments BEGIN SELECT RAISE(ABORT, 'avenant figé'); END;
CREATE TRIGGER IF NOT EXISTS signed_amendments_garde BEFORE DELETE ON signed_amendments BEGIN SELECT RAISE(ABORT, 'avenant gardé'); END;
