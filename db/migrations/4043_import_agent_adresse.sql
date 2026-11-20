-- AU031 · L'adresse exacte d'un bien repris d'un agent, gardée à part, dans un espace privé (M14, J05)
-- [R84, R13, R16, R18, R19, R46].
-- L'export des biens de l'ancien logiciel porte l'adresse du bien (voie, code postal, commune). Elle est reprise pour
-- que l'agent n'ait pas à la ressaisir, mais jamais dans `properties` : elle reste dans cette table, que seuls l'agent
-- du bien et la direction lisent, chaque lecture au journal sans l'adresse. Aucune sortie publique (annonce, page,
-- fiche, export, vidéo) ne lit cette table, et aucun message à un client [R46, R19]. Une adresse par bien repris :
-- relancé, l'import ne la double ni ne la change. Rien ne s'efface ni ne change.
CREATE TABLE IF NOT EXISTS agent_import_property_addresses (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL REFERENCES properties (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  street TEXT NOT NULL CHECK (length(street) BETWEEN 3 AND 200),
  postal_code TEXT NOT NULL CHECK (length(postal_code) = 5),
  city TEXT NOT NULL CHECK (length(city) BETWEEN 1 AND 100),
  source_format TEXT NOT NULL CHECK (source_format IN ('hektor', 'apimo', 'excel', 'google')),
  export_line INTEGER NOT NULL CHECK (export_line >= 2),
  created_at TEXT NOT NULL,
  PRIMARY KEY (network_id, property_id),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS agent_import_property_addresses_garde BEFORE DELETE ON agent_import_property_addresses BEGIN SELECT RAISE(ABORT, 'agent_import_property_addresses : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS agent_import_property_addresses_fige BEFORE UPDATE ON agent_import_property_addresses BEGIN SELECT RAISE(ABORT, 'agent_import_property_addresses : une adresse reprise ne change plus'); END;
