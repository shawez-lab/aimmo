-- J05 · Import des contacts et des biens d'un agent, triés selon la loi (M14) [R84, R03, R16, R18, R17].
-- Les fiches passent par la reprise (import_keys, contact_keys) : une seule fiche par personne, relançable sans doubler.

-- La base légale de chaque contact importé, telle que l'export la prouve : `client` (un mandat ou une vente dans
-- l'export), `consent` (un accord daté, prouvé, pour une finalité), `none` (rien : jamais de premier message).
-- Une ligne par contact d'export et par base : une relance n'ajoute rien, un export plus riche ajoute une base.
CREATE TABLE IF NOT EXISTS agent_import_contacts (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  origin_key TEXT NOT NULL CHECK (length(origin_key) BETWEEN 1 AND 200),
  person_id TEXT NOT NULL REFERENCES persons (id) ON DELETE RESTRICT,
  basis TEXT NOT NULL CHECK (basis IN ('client', 'consent', 'none')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (network_id, origin_key, basis),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS agent_import_contacts_person ON agent_import_contacts (person_id, basis);
CREATE TRIGGER IF NOT EXISTS agent_import_contacts_garde BEFORE DELETE ON agent_import_contacts BEGIN SELECT RAISE(ABORT, 'agent_import_contacts : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS agent_import_contacts_fige BEFORE UPDATE ON agent_import_contacts BEGIN SELECT RAISE(ABORT, 'agent_import_contacts : un tri rangé ne change plus'); END;

-- Un contact importé déjà suivi par un autre agent (ou sans agent) : la fiche n'est pas touchée, la direction attribue.
CREATE TABLE IF NOT EXISTS agent_import_referrals (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  origin_key TEXT NOT NULL CHECK (length(origin_key) BETWEEN 1 AND 200),
  importing_agent_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES persons (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  PRIMARY KEY (network_id, origin_key, person_id),
  FOREIGN KEY (importing_agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS agent_import_referrals_open ON agent_import_referrals (network_id, resolved_at, created_at);
CREATE TRIGGER IF NOT EXISTS agent_import_referrals_garde BEFORE DELETE ON agent_import_referrals BEGIN SELECT RAISE(ABORT, 'agent_import_referrals : rien ne s''efface'); END;

-- Les biens importés : rangés comme biens de l'agent, en brouillon, jamais publiés par l'import.
CREATE TABLE IF NOT EXISTS agent_import_properties (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  origin_key TEXT NOT NULL CHECK (length(origin_key) BETWEEN 1 AND 200),
  agent_id TEXT NOT NULL,
  property_id TEXT NOT NULL REFERENCES properties (id) ON DELETE RESTRICT,
  export_reference TEXT NOT NULL CHECK (length(export_reference) BETWEEN 1 AND 60),
  created_at TEXT NOT NULL,
  PRIMARY KEY (network_id, origin_key),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS agent_import_properties_garde BEFORE DELETE ON agent_import_properties BEGIN SELECT RAISE(ABORT, 'agent_import_properties : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS agent_import_properties_fige BEFORE UPDATE ON agent_import_properties BEGIN SELECT RAISE(ABORT, 'agent_import_properties : un bien importé ne change pas de cible'); END;
