-- AU089 · Le dispositif anti-blanchiment du réseau : le responsable nommé par la direction (un utilisateur au rôle
-- conformité) et la procédure écrite approuvée (version, référence du document, qui l'a approuvée et quand). Chaque
-- nomination et chaque approbation s'ajoutent ; la dernière vaut ; rien ne change ni ne s'efface [R17, R94].
CREATE TABLE IF NOT EXISTS lcb_officers (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  officer_user_id TEXT NOT NULL CHECK (length(officer_user_id) BETWEEN 1 AND 64),
  designated_by TEXT NOT NULL,
  designated_at TEXT NOT NULL,
  PRIMARY KEY (network_id, seq)
);
CREATE TRIGGER IF NOT EXISTS lcb_officers_fige BEFORE UPDATE ON lcb_officers BEGIN SELECT RAISE(ABORT, 'lcb_officers : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS lcb_officers_garde BEFORE DELETE ON lcb_officers BEGIN SELECT RAISE(ABORT, 'lcb_officers : rien ne s''efface'); END;

CREATE TABLE IF NOT EXISTS lcb_procedures (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  document_ref TEXT NOT NULL CHECK (length(document_ref) BETWEEN 3 AND 200),
  document_sha256 TEXT NOT NULL CHECK (length(document_sha256) = 64),
  approved_by TEXT NOT NULL CHECK (length(approved_by) BETWEEN 2 AND 120),
  approved_on TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (network_id, version)
);
CREATE TRIGGER IF NOT EXISTS lcb_procedures_fige BEFORE UPDATE ON lcb_procedures BEGIN SELECT RAISE(ABORT, 'lcb_procedures : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS lcb_procedures_garde BEFORE DELETE ON lcb_procedures BEGIN SELECT RAISE(ABORT, 'lcb_procedures : rien ne s''efface'); END;
