-- AU060 · Le droit de chaque mandant sur le bien : pleine propriété, usufruit ou nue-propriété, avec son justificatif. Un
-- bien démembré se vend par l'usufruitier et les nus-propriétaires ensemble ; le document nomme le droit de chacun.
-- Donné à la préparation du document, rien ne change ensuite, rien ne s'efface [R17, R41].
CREATE TABLE IF NOT EXISTS document_mandant_rights (
  document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES persons (id) ON DELETE RESTRICT,
  right_kind TEXT NOT NULL CHECK (right_kind IN ('pleine_propriete', 'usufruit', 'nue_propriete')),
  proof_ref TEXT CHECK (proof_ref IS NULL OR length(proof_ref) BETWEEN 1 AND 200),
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (document_id, person_id)
);
CREATE TRIGGER IF NOT EXISTS document_mandant_rights_garde BEFORE DELETE ON document_mandant_rights BEGIN SELECT RAISE(ABORT, 'document_mandant_rights : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS document_mandant_rights_fige BEFORE UPDATE ON document_mandant_rights BEGIN SELECT RAISE(ABORT, 'document_mandant_rights : rien ne se réécrit'); END;
