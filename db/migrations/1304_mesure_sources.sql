-- G10 · Mesure mensuelle des sources de mandats (M20) [R144, R13, R16, R17].
-- Le coût d'une source pour un mois, saisi par la direction avec sa preuve. Une correction s'ajoute en version suivante ;
-- la dernière version fait foi. Aucune donnée de client.
CREATE TABLE IF NOT EXISTS mandate_source_costs (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  month TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  source TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  proof_ref TEXT NOT NULL CHECK (length(proof_ref) BETWEEN 3 AND 300),
  entered_by TEXT NOT NULL,
  entered_at TEXT NOT NULL,
  UNIQUE (network_id, month, source, version)
);
CREATE TRIGGER IF NOT EXISTS mandate_source_costs_garde BEFORE DELETE ON mandate_source_costs BEGIN SELECT RAISE(ABORT, 'mandate_source_costs : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS mandate_source_costs_fige BEFORE UPDATE ON mandate_source_costs BEGIN SELECT RAISE(ABORT, 'mandate_source_costs : un coût rangé ne change plus, une version s''ajoute'); END;

-- La décision de la direction sur une source : la garder ou l'arrêter, avec sa raison. Jamais écrite par le code seul.
CREATE TABLE IF NOT EXISTS mandate_source_decisions (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  month TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  source TEXT NOT NULL,
  -- L'ordre des décisions sur une source : la plus haute fait foi, même à la même milliseconde.
  seq INTEGER NOT NULL CHECK (seq >= 1),
  decision TEXT NOT NULL CHECK (decision IN ('garder', 'arreter')),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 200),
  decided_by TEXT NOT NULL CHECK (decided_by LIKE 'direction:%'),
  decided_at TEXT NOT NULL,
  UNIQUE (network_id, source, seq)
);
CREATE INDEX IF NOT EXISTS mandate_source_decisions_month ON mandate_source_decisions (network_id, month, source, decided_at);
CREATE TRIGGER IF NOT EXISTS mandate_source_decisions_garde BEFORE DELETE ON mandate_source_decisions BEGIN SELECT RAISE(ABORT, 'mandate_source_decisions : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS mandate_source_decisions_fige BEFORE UPDATE ON mandate_source_decisions BEGIN SELECT RAISE(ABORT, 'mandate_source_decisions : une décision rangée ne change plus, une nouvelle s''ajoute'); END;
