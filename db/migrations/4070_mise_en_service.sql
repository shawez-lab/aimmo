-- AU088 · Le tableau de mise en service du réseau : carte professionnelle, garantie financière, assurance de
-- responsabilité civile professionnelle, adhésion au médiateur, relecture des mentions par l'avocat [R675, R221, R17].
--
-- Une ligne par preuve déclarée par la direction : numéro du document, émetteur, référence de la preuve, dates de
-- validité. Une correction, un renouvellement ou un retrait s'ajoutent en nouvelle version ; rien ne change ni ne
-- s'efface [R17]. La situation réelle n'est pas vérifiée par AIMMO : la ligne dit ce que la direction a déclaré.
CREATE TABLE IF NOT EXISTS launch_proofs (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  prerequisite TEXT NOT NULL CHECK (prerequisite IN ('carte', 'garantie', 'assurance', 'mediateur', 'mentions')),
  version INTEGER NOT NULL CHECK (version >= 1),
  withdrawn INTEGER NOT NULL CHECK (withdrawn IN (0, 1)),
  document_number TEXT,
  issuer TEXT,
  proof_ref TEXT,
  valid_from TEXT,
  valid_until TEXT,
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  CHECK (withdrawn = 1 OR (document_number IS NOT NULL AND issuer IS NOT NULL AND proof_ref IS NOT NULL AND valid_from IS NOT NULL)),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from),
  UNIQUE (network_id, prerequisite, version)
);
CREATE TRIGGER IF NOT EXISTS launch_proofs_fige BEFORE UPDATE ON launch_proofs
BEGIN
  SELECT RAISE(ABORT, 'launch_proofs : une preuve rangée ne change plus');
END;
CREATE TRIGGER IF NOT EXISTS launch_proofs_garde BEFORE DELETE ON launch_proofs
BEGIN
  SELECT RAISE(ABORT, 'launch_proofs : rien ne s''efface');
END;
