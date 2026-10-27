-- P01 · Fiche du bien complète (M07), versionnée : une modification crée une version, rien ne change ni ne
-- s'efface [R17]. Ni adresse exacte, ni nom du vendeur, ni texte libre ici [R19, R46] : la fiche ne porte que des
-- valeurs contrôlées (nombres, classes, listes fermées) et les références de stockage des photos et vidéos.
CREATE TABLE IF NOT EXISTS property_sheets (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  -- La fiche entière de cette version, en JSON contrôlé par le code.
  data TEXT NOT NULL CHECK (json_valid(data)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (property_id, version),
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS property_sheets_latest ON property_sheets (property_id, version DESC);

CREATE TRIGGER IF NOT EXISTS property_sheets_sans_effacement
BEFORE DELETE ON property_sheets
BEGIN
  SELECT RAISE(ABORT, 'property_sheets : rien ne s''efface');
END;

CREATE TRIGGER IF NOT EXISTS property_sheets_fige
BEFORE UPDATE ON property_sheets
BEGIN
  SELECT RAISE(ABORT, 'property_sheets : une version rangée ne change plus');
END;
