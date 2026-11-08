-- HX39 · Texte par portail et légendes des photos. Tables nouvelles, en ajout seul : rien ne s'efface ni ne se réécrit [R17].

-- Le texte d'un bien pour un portail, écrit pour une version publiée précise (son numéro) : titre et texte seulement ;
-- prix, mentions et photos restent ceux de la version publiée [R476]. Écrit par l'agent du bien, ou proposé par l'IA.
CREATE TABLE IF NOT EXISTS diffusion_portal_texts (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  portal TEXT NOT NULL CHECK (length(portal) BETWEEN 2 AND 30),
  listing_seq INTEGER NOT NULL CHECK (listing_seq >= 1),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  origin TEXT NOT NULL CHECK (origin IN ('ia', 'agent')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS diffusion_portal_texts_bien ON diffusion_portal_texts (property_id, portal, listing_seq);
CREATE TRIGGER IF NOT EXISTS diffusion_portal_texts_garde BEFORE DELETE ON diffusion_portal_texts BEGIN SELECT RAISE(ABORT, 'diffusion_portal_texts : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS diffusion_portal_texts_fige BEFORE UPDATE ON diffusion_portal_texts BEGIN SELECT RAISE(ABORT, 'diffusion_portal_texts : rien ne se réécrit'); END;

-- La validation d'un texte par l'agent du bien : une seule par texte, gardée par la base [R477].
CREATE TABLE IF NOT EXISTS diffusion_portal_text_validations (
  text_id TEXT PRIMARY KEY REFERENCES diffusion_portal_texts (id) ON DELETE RESTRICT,
  by_actor TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS diffusion_portal_text_validations_garde BEFORE DELETE ON diffusion_portal_text_validations BEGIN SELECT RAISE(ABORT, 'diffusion_portal_text_validations : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS diffusion_portal_text_validations_fige BEFORE UPDATE ON diffusion_portal_text_validations BEGIN SELECT RAISE(ABORT, 'diffusion_portal_text_validations : rien ne se réécrit'); END;

-- Ce que montre chaque photo, dit par l'agent du bien dans une liste fermée ; le dernier choix d'une photo fait foi,
-- « aucun » le retire. La légende est écrite par le code depuis ce choix et la fiche [R478].
CREATE TABLE IF NOT EXISTS diffusion_photo_subjects (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  media_ref TEXT NOT NULL CHECK (length(media_ref) BETWEEN 1 AND 200),
  subject TEXT NOT NULL CHECK (subject IN ('aucun', 'piece_principale', 'chambre', 'balcon', 'terrasse', 'jardin', 'cour', 'terrain', 'stationnement', 'ascenseur')),
  by_actor TEXT NOT NULL,
  at TEXT NOT NULL,
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS diffusion_photo_subjects_photo ON diffusion_photo_subjects (property_id, media_ref, at);
CREATE TRIGGER IF NOT EXISTS diffusion_photo_subjects_garde BEFORE DELETE ON diffusion_photo_subjects BEGIN SELECT RAISE(ABORT, 'diffusion_photo_subjects : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS diffusion_photo_subjects_fige BEFORE UPDATE ON diffusion_photo_subjects BEGIN SELECT RAISE(ABORT, 'diffusion_photo_subjects : rien ne se réécrit'); END;
