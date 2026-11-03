-- IN11 · La mise en vente d'un bien, datée une fois : l'instant où la porte de diffusion s'est ouverte [R42], jamais
-- celui du passage qui l'a vue. Aucune donnée de personne : un bien, un mandat, deux instants.
CREATE TABLE IF NOT EXISTS property_on_sale (
  property_id TEXT PRIMARY KEY REFERENCES properties (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  mandate_id TEXT NOT NULL REFERENCES mandates (id) ON DELETE RESTRICT,
  on_sale_at TEXT NOT NULL,
  noted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS property_on_sale_month ON property_on_sale (network_id, on_sale_at);

CREATE TRIGGER IF NOT EXISTS property_on_sale_fige BEFORE UPDATE ON property_on_sale
BEGIN
  SELECT RAISE(ABORT, 'property_on_sale : une date de mise en vente ne se réécrit pas');
END;
CREATE TRIGGER IF NOT EXISTS property_on_sale_garde BEFORE DELETE ON property_on_sale
BEGIN
  SELECT RAISE(ABORT, 'property_on_sale : rien ne s''efface');
END;
