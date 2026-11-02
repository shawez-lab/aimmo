-- D11 : un scan déposé prouve une seule signature de mandat. Seules les références du dépôt sont concernées :
-- les références plus anciennes, saisies à la main, restent telles quelles.
CREATE UNIQUE INDEX IF NOT EXISTS signed_documents_scan_unique ON signed_documents (scan_ref) WHERE scan_ref LIKE 'mandats/%';
