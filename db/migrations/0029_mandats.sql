-- G03 · Chaque mandat signé garde sa source [R38]. Le registre légal des mandats viendra avec M06 : ici, le mandat
-- signé, sa date et sa source, pour mesurer chaque mois ce qui rapporte des mandats. Rien ne s'efface, rien ne change.
CREATE TABLE IF NOT EXISTS mandates (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  project_id TEXT,
  property_id TEXT,
  signed_at TEXT NOT NULL,
  -- La source, dans une liste fermée ; « liste achetée » et « ventes publiques » n'y sont pas [R37].
  source_kind TEXT NOT NULL CHECK (source_kind IN ('site', 'online_valuation', 'value_tracking', 'referral', 'social', 'portal', 'agent_network', 'neighbourhood_letter', 'other')),
  -- Un mot pour « autre » ; jamais écrit au journal.
  source_detail TEXT CHECK (source_detail IS NULL OR length(trim(source_detail)) > 0),
  -- La source de la fiche dont elle est reprise, quand elle l'est.
  source_id TEXT REFERENCES sources (id) ON DELETE RESTRICT,
  recorded_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (source_kind <> 'other' OR source_detail IS NOT NULL),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, network_id) REFERENCES projects (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS mandates_month ON mandates (network_id, signed_at);
CREATE INDEX IF NOT EXISTS mandates_agent ON mandates (network_id, agent_id, signed_at);

CREATE TRIGGER IF NOT EXISTS mandates_sans_effacement
BEFORE DELETE ON mandates
BEGIN
  SELECT RAISE(ABORT, 'mandates : rien ne s''efface');
END;

CREATE TRIGGER IF NOT EXISTS mandates_fige
BEFORE UPDATE ON mandates
BEGIN
  SELECT RAISE(ABORT, 'mandates : un mandat rangé ne change plus');
END;
