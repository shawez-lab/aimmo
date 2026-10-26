-- S03 · Fiche client unique : personnes, identifiants, accords, exclusions, projets, biens, messages, agents, sources.
-- SQL standard compatible SQLite et Cloudflare D1, pour passer plus tard à PostgreSQL sans réécriture.
-- Dates : texte ISO 8601 en temps universel, par exemple 2026-10-26T09:00:00.000Z.
-- Chaque ligne porte le réseau, et l'agent quand il est connu.
-- Aucune ligne n'est effacée par le code [R17] : les liens sont en ON DELETE RESTRICT.
-- Aucune pièce d'identité, aucun document anti-blanchiment, aucune coordonnée bancaire ici [R15] :
-- ils vivent seulement dans le coffre de la conformité.

CREATE TABLE IF NOT EXISTS networks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  zone TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'left')),
  sponsor_agent_id TEXT REFERENCES agents (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agents_network ON agents (network_id);

CREATE TABLE IF NOT EXISTS persons (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT REFERENCES agents (id) ON DELETE RESTRICT,
  first_name TEXT,
  last_name TEXT,
  language TEXT NOT NULL DEFAULT 'fr',
  contact_status TEXT NOT NULL DEFAULT 'new' CHECK (contact_status IN ('new', 'active', 'inactive')),
  last_contact_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS persons_agent ON persons (network_id, agent_id);
CREATE INDEX IF NOT EXISTS persons_last_contact ON persons (network_id, last_contact_at);

-- Une personne a autant d'identifiants qu'il faut. La valeur est rangée normalisée (S04).
-- Pas d'unicité entre personnes : deux fiches peuvent partager un identifiant avant leur fusion (S04).
CREATE TABLE IF NOT EXISTS person_identifiers (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT REFERENCES agents (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES persons (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('email', 'phone', 'instagram', 'facebook', 'whatsapp')),
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (person_id, kind, value)
);
CREATE INDEX IF NOT EXISTS person_identifiers_lookup ON person_identifiers (network_id, kind, value);
CREATE INDEX IF NOT EXISTS person_identifiers_person ON person_identifiers (person_id);

-- Accord pour un usage : finalité, canal, preuve, date, retrait. Jamais effacé : un retrait remplit withdrawn_at.
CREATE TABLE IF NOT EXISTS consents (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT REFERENCES agents (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES persons (id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'phone', 'sms', 'instagram', 'facebook', 'whatsapp')),
  proof TEXT NOT NULL CHECK (length(trim(proof)) > 0),
  given_at TEXT NOT NULL,
  withdrawn_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS consents_person ON consents (person_id, channel);

-- Exclusion : liste de Shawez, stop, non, vendu, suivi par quelqu'un d'autre. channel NULL = tous les canaux.
-- Une exclusion levée garde sa ligne, avec lifted_at.
CREATE TABLE IF NOT EXISTS exclusions (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT REFERENCES agents (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES persons (id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (reason IN ('network_list', 'stop', 'refused', 'sold', 'followed_elsewhere')),
  channel TEXT CHECK (channel IN ('email', 'phone', 'sms', 'instagram', 'facebook', 'whatsapp')),
  noted_at TEXT NOT NULL,
  lifted_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS exclusions_person ON exclusions (person_id);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT REFERENCES agents (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES persons (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('sell', 'buy', 'rent_out', 'rent', 'invest', 'sell_business', 'buy_business', 'valuation')),
  stage TEXT NOT NULL DEFAULT 'new',
  deadline TEXT,
  budget_min_eur INTEGER CHECK (budget_min_eur IS NULL OR budget_min_eur >= 0),
  budget_max_eur INTEGER CHECK (budget_max_eur IS NULL OR budget_max_eur >= 0),
  criteria TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS projects_person ON projects (person_id);
CREATE INDEX IF NOT EXISTS projects_agent ON projects (network_id, agent_id, kind, stage);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT REFERENCES agents (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES persons (id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects (id) ON DELETE RESTRICT,
  channel TEXT NOT NULL,
  detail TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sources_person ON sources (person_id);
CREATE INDEX IF NOT EXISTS sources_channel ON sources (network_id, channel, occurred_at);

-- Bien réduit au nécessaire pour le socle : ni adresse exacte ni nom du propriétaire ici.
CREATE TABLE IF NOT EXISTS properties (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT REFERENCES agents (id) ON DELETE RESTRICT,
  reference TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('home', 'land', 'building', 'commercial', 'business_walls', 'business')),
  postal_code TEXT,
  city TEXT,
  surface_m2 REAL CHECK (surface_m2 IS NULL OR surface_m2 > 0),
  rooms INTEGER CHECK (rooms IS NULL OR rooms >= 0),
  price_eur INTEGER CHECK (price_eur IS NULL OR price_eur >= 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'available', 'under_offer', 'sold', 'rented', 'withdrawn')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (network_id, reference)
);
CREATE INDEX IF NOT EXISTS properties_agent ON properties (network_id, agent_id, status);
CREATE INDEX IF NOT EXISTS properties_search ON properties (network_id, status, kind, postal_code);

CREATE TABLE IF NOT EXISTS project_properties (
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL REFERENCES properties (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT REFERENCES agents (id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('owned', 'interested', 'proposed')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, property_id, role)
);
CREATE INDEX IF NOT EXISTS project_properties_property ON project_properties (property_id);

-- Échange écrit ou oral : canal, sens, auteur, origine IA ou humaine, coût en centimes d'euro.
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT REFERENCES agents (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES persons (id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects (id) ON DELETE RESTRICT,
  conversation_id TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'phone', 'sms', 'instagram', 'facebook', 'whatsapp', 'site')),
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('person', 'agent', 'ai', 'system')),
  body TEXT NOT NULL,
  cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_person ON messages (person_id, occurred_at);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages (conversation_id, occurred_at);
CREATE INDEX IF NOT EXISTS messages_agent ON messages (network_id, agent_id, occurred_at);
