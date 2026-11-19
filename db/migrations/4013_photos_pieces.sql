-- AU114 · Ce que montre une photo, dans la liste élargie aux pièces de toute habitation (cuisine, salle d'eau,
-- toilettes, entrée, façade). La table de HX39 garde sa liste fermée et ses lignes ; les nouveaux choix sont rangés ici,
-- et le dernier choix, d'une table ou de l'autre, fait foi.
CREATE TABLE IF NOT EXISTS diffusion_photo_descriptions (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  media_ref TEXT NOT NULL CHECK (length(media_ref) BETWEEN 1 AND 200),
  subject TEXT NOT NULL CHECK (subject IN ('aucun', 'piece_principale', 'chambre', 'cuisine', 'salle_de_bain', 'toilettes', 'entree', 'facade', 'balcon', 'terrasse', 'jardin', 'cour', 'terrain', 'stationnement', 'ascenseur')),
  by_actor TEXT NOT NULL,
  at TEXT NOT NULL,
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS diffusion_photo_descriptions_photo ON diffusion_photo_descriptions (property_id, media_ref, at);
CREATE TRIGGER IF NOT EXISTS diffusion_photo_descriptions_garde BEFORE DELETE ON diffusion_photo_descriptions BEGIN SELECT RAISE(ABORT, 'diffusion_photo_descriptions : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS diffusion_photo_descriptions_fige BEFORE UPDATE ON diffusion_photo_descriptions BEGIN SELECT RAISE(ABORT, 'diffusion_photo_descriptions : rien ne se réécrit'); END;
