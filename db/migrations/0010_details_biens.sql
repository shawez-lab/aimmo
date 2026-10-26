-- C04 · Ce que la première réponse dit d'un bien, en plus de sa fiche : quartier et atout principal.
-- Uniquement des tables nouvelles. Rien n'est jamais effacé [R17]. Ni adresse exacte ni nom du vendeur ici [R19].
CREATE TABLE IF NOT EXISTS property_details (
  property_id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  neighborhood TEXT,
  highlight TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);

CREATE TRIGGER IF NOT EXISTS property_details_sans_effacement
BEFORE DELETE ON property_details
BEGIN
  SELECT RAISE(ABORT, 'property_details : rien ne s''efface');
END;
