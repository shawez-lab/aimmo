-- Y03 · Calcul d'investissement : chaque calcul est rangé avec toutes ses entrées et son résultat, pour être rejoué à
-- l'identique [R120]. Rien ne s'efface ni ne se réécrit [R17]. Aucun impôt ni régime fiscal [R125].
CREATE TABLE IF NOT EXISTS investment_calculations (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT,
  project_id TEXT,
  -- Les entrées, chacune avec sa valeur, sa source, sa date et son hypothèse, en JSON contrôlé par le code.
  inputs TEXT NOT NULL CHECK (json_valid(inputs)),
  -- Le résultat : `complet` avec ses lignes, ou `incomplet` avec ce qui manque.
  status TEXT NOT NULL CHECK (status IN ('complet', 'incomplet')),
  result TEXT NOT NULL CHECK (json_valid(result)),
  -- La version des formules : un rejeu se fait avec la même.
  formula_version INTEGER NOT NULL CHECK (formula_version >= 1),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, network_id) REFERENCES projects (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS investment_calculations_property ON investment_calculations (network_id, property_id, created_at);
CREATE INDEX IF NOT EXISTS investment_calculations_project ON investment_calculations (network_id, project_id, created_at);

CREATE TRIGGER IF NOT EXISTS investment_calculations_garde BEFORE DELETE ON investment_calculations
BEGIN
  SELECT RAISE(ABORT, 'investment_calculations : rien ne s''efface');
END;
CREATE TRIGGER IF NOT EXISTS investment_calculations_fige BEFORE UPDATE ON investment_calculations
BEGIN
  SELECT RAISE(ABORT, 'investment_calculations : un calcul rangé ne change plus');
END;
