-- AU052 · L'adresse vérifiée d'un bien, gardée pour le prochain avis de valeur (M04) [R695, R13, R16, R19, R46].
-- L'agent qui suit le bien donne l'adresse à la préparation d'un avis ; une fois vérifiée (trouvée, sûre, dans la
-- commune du bien), elle est gardée ici, à part de `properties` et de l'avis, pour qu'il ne la ressaisisse pas au
-- prochain avis. Une autre adresse donnée ensuite est une modification explicite : une nouvelle ligne, la plus récente
-- vaut. Seule la préparation de l'avis la lit, pour l'agent qui suit le bien. Aucune sortie publique (annonce, page,
-- fiche, export, vidéo), aucun message à un client et aucune ligne du journal ne la portent [R46, R19, R13].
-- Rien ne s'efface ni ne change.
CREATE TABLE IF NOT EXISTS valuation_addresses (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL REFERENCES properties (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  address TEXT NOT NULL CHECK (length(address) BETWEEN 5 AND 200),
  postal_code TEXT NOT NULL CHECK (length(postal_code) = 5),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  UNIQUE (property_id, version)
);
CREATE INDEX IF NOT EXISTS valuation_addresses_bien ON valuation_addresses (network_id, property_id, version);
CREATE TRIGGER IF NOT EXISTS valuation_addresses_fige BEFORE UPDATE ON valuation_addresses BEGIN SELECT RAISE(ABORT, 'valuation_addresses : une adresse gardée ne change pas'); END;
CREATE TRIGGER IF NOT EXISTS valuation_addresses_garde BEFORE DELETE ON valuation_addresses BEGIN SELECT RAISE(ABORT, 'valuation_addresses : rien ne s''efface'); END;
