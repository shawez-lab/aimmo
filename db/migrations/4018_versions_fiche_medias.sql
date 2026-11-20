-- AU066 · La version de la fiche d'où viennent les photos et vidéos d'une version publiée : le texte validé peut rester
-- celui d'avant pendant qu'une correction se prépare, mais les médias et leurs légendes sont ceux de la fiche du jour.
CREATE TABLE IF NOT EXISTS listing_version_media_sheets (
  version_id TEXT PRIMARY KEY REFERENCES listing_versions (id) ON DELETE RESTRICT,
  sheet_version INTEGER NOT NULL CHECK (sheet_version >= 1)
);
CREATE TRIGGER IF NOT EXISTS listing_version_media_sheets_garde BEFORE DELETE ON listing_version_media_sheets BEGIN SELECT RAISE(ABORT, 'listing_version_media_sheets : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS listing_version_media_sheets_fige BEFORE UPDATE ON listing_version_media_sheets BEGIN SELECT RAISE(ABORT, 'listing_version_media_sheets : rien ne se réécrit'); END;
