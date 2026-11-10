-- HX74 · La reprise des données de l'agence sous licence : tout, table par table, rien d'oublié (Feuille de route,
-- phase 5, « licence du logiciel aux agences hors réseau » ; Offre aux agents, « Licence du logiciel ») [R658, R659].
-- Table nouvelle, en ajout seul : rien ne change ni ne s'efface [R17].

-- Chaque fichier de reprise remis à la direction d'une agence sous licence : son empreinte et ses comptes, jamais son
-- contenu. Le réseau est celui de l'agence, jamais celui qui donne la licence : la base refuse l'autre sens [R659, R657].
CREATE TABLE IF NOT EXISTS licence_data_exports (
  id TEXT PRIMARY KEY,
  licence_id TEXT NOT NULL REFERENCES software_licences (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND ltrim(fingerprint, '0123456789abcdef') = ''),
  tables_count INTEGER NOT NULL CHECK (tables_count >= 1),
  rows_count INTEGER NOT NULL CHECK (rows_count >= 0),
  made_by TEXT NOT NULL CHECK (made_by LIKE 'direction:%'),
  made_at TEXT NOT NULL,
  UNIQUE (network_id, fingerprint)
);
CREATE TRIGGER IF NOT EXISTS licence_data_exports_agence BEFORE INSERT ON licence_data_exports
WHEN NOT EXISTS (SELECT 1 FROM software_licences l WHERE l.id = NEW.licence_id AND l.licensee_network_id = NEW.network_id)
BEGIN SELECT RAISE(ABORT, 'licence_data_exports : le fichier n''est remis qu''à l''agence de la licence [R659]'); END;
CREATE TRIGGER IF NOT EXISTS licence_data_exports_garde BEFORE DELETE ON licence_data_exports BEGIN SELECT RAISE(ABORT, 'licence_data_exports : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS licence_data_exports_fige BEFORE UPDATE ON licence_data_exports BEGIN SELECT RAISE(ABORT, 'licence_data_exports : un fichier remis ne change plus'); END;
