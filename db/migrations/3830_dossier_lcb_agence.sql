-- HX76 · Le dossier de la lutte contre le blanchiment de l'agence sous licence, remis à son responsable de la
-- conformité seul (M12 Conformité, « Anti-blanchiment » ; Feuille de route, phase 5, licence du logiciel) [R662, R663].
-- Table nouvelle, en ajout seul : rien ne change ni ne s'efface [R17].

-- Chaque dossier remis : son empreinte seule. Aucun compte de tables ni de lignes : le nombre de signalements ou de
-- pièces ne se lit nulle part hors du dossier [R663]. Le réseau est celui de l'agence, le geste celui de son
-- responsable de la conformité : la base refuse tout autre sens [R662].
CREATE TABLE IF NOT EXISTS licence_lcb_exports (
  id TEXT PRIMARY KEY,
  licence_id TEXT NOT NULL REFERENCES software_licences (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND ltrim(fingerprint, '0123456789abcdef') = ''),
  made_by TEXT NOT NULL CHECK (made_by LIKE 'compliance:%'),
  made_at TEXT NOT NULL,
  UNIQUE (network_id, fingerprint)
);
CREATE TRIGGER IF NOT EXISTS licence_lcb_exports_agence BEFORE INSERT ON licence_lcb_exports
WHEN NOT EXISTS (SELECT 1 FROM software_licences l WHERE l.id = NEW.licence_id AND l.licensee_network_id = NEW.network_id)
BEGIN SELECT RAISE(ABORT, 'licence_lcb_exports : le dossier n''est remis qu''à l''agence de la licence [R662]'); END;
CREATE TRIGGER IF NOT EXISTS licence_lcb_exports_garde BEFORE DELETE ON licence_lcb_exports BEGIN SELECT RAISE(ABORT, 'licence_lcb_exports : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS licence_lcb_exports_fige BEFORE UPDATE ON licence_lcb_exports BEGIN SELECT RAISE(ABORT, 'licence_lcb_exports : un dossier remis ne change plus'); END;
